import { chromium, Browser, Page } from 'rustwright';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  detectSchoolWideCancellation,
  isActualClass,
  normalizeDateTime,
  timeToDisplay,
  type ScheduleItem,
} from './helpers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const AUTH_STATE_PATH = join(__dirname, '..', '.auth-state.json');
const CACHE_PATH = join(__dirname, '..', '.schedule-cache.json');
const APPOINTMENTS_PATH = join(__dirname, '..', '.appointments.json');
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

const LOG_FILE = '/tmp/magister-mcp.log';

// Simple cache structure
interface CacheEntry {
  data: ScheduleItem[];
  timestamp: number;
}
interface CacheStore {
  [dateKey: string]: CacheEntry;
}

// Auth state stored on disk (flat JSON, no Playwright storageState)
interface AuthState {
  userId?: number;
  accessToken?: string;
  savedAt: string;
}

// Locally-created appointment records. The Magister student/parent API exposes no
// documented endpoint for creating appointments, so adds are stored locally and
// merged into the schedule. A best-effort POST to the API is attempted first.
export interface StoredAppointment {
  id: string;
  subject: string;
  startTime: string; // ISO 8601
  endTime: string; // ISO 8601
  source: 'local';
  cancelled: boolean;
  description?: string;
  createdAt: string;
}

class ScheduleCache {
  private cache: CacheStore = {};

  constructor() {
    this.load();
  }

  private load() {
    try {
      if (existsSync(CACHE_PATH)) {
        this.cache = JSON.parse(readFileSync(CACHE_PATH, 'utf-8'));
        log('Cache loaded from disk');
      }
    } catch {
      this.cache = {};
    }
  }

  private save() {
    try {
      writeFileSync(CACHE_PATH, JSON.stringify(this.cache, null, 2));
    } catch {
      // Ignore save errors
    }
  }

  get(dateKey: string): { data: ScheduleItem[]; isStale: boolean } | null {
    const entry = this.cache[dateKey];
    if (!entry) return null;

    const age = Date.now() - entry.timestamp;
    const isStale = age > CACHE_TTL_MS;

    return { data: entry.data, isStale };
  }

  set(dateKey: string, data: ScheduleItem[]) {
    this.cache[dateKey] = { data, timestamp: Date.now() };
    this.save();
  }

  clear() {
    this.cache = {};
    this.save();
  }
}

const scheduleCache = new ScheduleCache();

function log(...args: unknown[]) {
  const msg = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  const line = `${new Date().toISOString()} ${msg}\n`;
  appendFileSync(LOG_FILE, line);
  process.stderr.write(line);
}

// Small sleep helper (Rustwright Page has no wait_for_timeout).
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface ClassResult {
  class: ScheduleItem | null;
  cancellationReason: string | null;
}

export interface MagisterConfig {
  school: string;
  username: string;
  password: string;
}

export interface AddAppointmentInput {
  subject: string;
  start: string; // ISO 8601 or YYYY-MM-DD HH:mm
  end: string; // ISO 8601 or YYYY-MM-DD HH:mm
  description?: string;
}

export class MagisterClient {
  private config: MagisterConfig;
  private browser: Browser | null = null;
  private page: Page | null = null;
  private accessToken: string | null = null;
  private userId: number | null = null;

  constructor(config: MagisterConfig) {
    this.config = config;
  }

  private getBaseUrl(): string {
    const school = this.config.school.replace(/\.magister\.net$/, '');
    return `https://${school}.magister.net`;
  }

  async init(): Promise<void> {
    log('Initializing Magister client...');
    this.browser = await chromium.launch({ headless: true });
    this.page = await this.browser.newPage();

    // Restore saved userId + token from disk if present
    if (existsSync(AUTH_STATE_PATH)) {
      try {
        const state = JSON.parse(readFileSync(AUTH_STATE_PATH, 'utf-8')) as AuthState;
        this.userId = state.userId ?? null;
        this.accessToken = state.accessToken ?? null;
        log('Restored userId:', this.userId, 'token:', this.accessToken ? 'yes' : 'no');
      } catch (e) {
        log('Failed to restore auth state:', e);
      }
    } else {
      log('No saved auth state, fresh login required');
    }

    // Probe whether the saved session is still usable
    const valid = await this.probeSession();
    if (valid) {
      log('Session restored successfully!');
      return;
    }

    log('Saved session invalid or absent, logging in fresh...');
    await this.login();
  }

  // Returns true if we already have a working session (userId + token). Navigates to
  // the school domain first (Rustwright pages start on about:blank, and fetch('/...')
  // is relative), then hits the authenticated /api/account endpoint.
  private async probeSession(): Promise<boolean> {
    if (!this.page || !this.userId || !this.accessToken) return false;
    try {
      await this.page.goto(`${this.getBaseUrl()}/magister/`);
      await sleep(2000);
      const status = await this.page.evaluate(async (token) => {
        const r = await fetch('/api/account', {
          credentials: 'include',
          headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
        });
        return r.status;
      }, this.accessToken);
      log('Session probe status:', status);
      return status >= 200 && status < 300;
    } catch (e) {
      log('Session probe failed:', e);
      return false;
    }
  }

  private async login(): Promise<void> {
    if (!this.page) throw new Error('Page not initialized');

    log('Logging into Magister...');
    await this.page.goto(this.getBaseUrl());

    // Wait for redirect to accounts.magister.net and the username field.
    await this.waitForSelector('#username', 15000);
    log('Username field found');

    await this.page.fill('#username', this.config.username);
    log('Username filled');

    await this.page.click(
      'dna-button:has-text("Doorgaan"), button:has-text("Doorgaan"), [type="submit"]'
    );
    log('Clicked continue button');

    await this.waitForSelector('#password, input[type="password"]', 15000);
    log('Password field found');

    await this.page.fill('#password, input[type="password"]', this.config.password);
    log('Password filled');

    await this.page.screenshot({ path: '/tmp/magister-before-login.png' });
    log('Screenshot saved to /tmp/magister-before-login.png');

    // Cookie consent
    const consentSelectors = [
      'button:has-text("Accepteren")',
      'button:has-text("Accept")',
      'button:has-text("Akkoord")',
      'button:has-text("OK")',
      '[id*="cookie"] button',
      '[class*="cookie"] button',
      '[class*="consent"] button',
    ];
    for (const selector of consentSelectors) {
      const present = await this.isVisible(selector);
      if (present) {
        log('Found consent button:', selector);
        await this.page.click(selector);
        await sleep(500);
        break;
      }
    }

    const loginSelectors = [
      'dna-button:has-text("Inloggen")',
      'button:has-text("Inloggen")',
      'dna-button[type="submit"]',
      'button[type="submit"]',
      'input[type="submit"]',
      '.btn-primary',
      '[data-testid="login"]',
    ];

    let clicked = false;
    for (const selector of loginSelectors) {
      const present = await this.isVisible(selector);
      if (present) {
        await this.page.click(selector);
        log('Clicked login button:', selector);
        clicked = true;
        break;
      }
    }

    if (!clicked) {
      await this.page.screenshot({ path: '/tmp/magister-login-failed.png' });
      log('Could not find login button! Screenshot saved to /tmp/magister-login-failed.png');
      // Fallback: submit the form via evaluate (no keyboard API in Rustwright).
      await this.page.evaluate(() => {
        const form = document.querySelector('form');
        if (form) form.requestSubmit();
        else {
          const btn = document.querySelector(
            'button[type="submit"], dna-button[type="submit"], input[type="submit"]'
          ) as HTMLElement | null;
          btn?.click();
        }
      });
      log('Attempted form submit as fallback');
    }

    // Give the login redirect a moment to settle
    await sleep(3000);

    // Navigate to the school domain so storage/fragment reads happen on the right origin.
    await this.page.goto(`${this.getBaseUrl()}/magister/`);
    await sleep(2000);

    // Extract token: prefer redirect fragment/session, fall back to storage scan
    this.accessToken = await this.extractToken();
    log(
      'Access token captured:',
      this.accessToken ? this.accessToken.slice(0, 50) + '...' : 'none'
    );

    await this.fetchUserId();

    log('Login successful! Token:', this.accessToken ? 'yes' : 'no', 'UserId:', this.userId);

    await this.saveAuthState();
  }

  // Poll for a selector using evaluate (Rustwright has no wait_for_selector).
  private async waitForSelector(selector: string, timeoutMs: number): Promise<void> {
    if (!this.page) throw new Error('Page not initialized');
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const found = await this.page.evaluate((sel) => !!document.querySelector(sel), selector);
      if (found) return;
      await sleep(250);
    }
    throw new Error(`Timeout waiting for selector: ${selector}`);
  }

  // Check whether a selector matches a visible-ish element (Rustwright has no is_visible).
  private async isVisible(selector: string): Promise<boolean> {
    if (!this.page) return false;
    try {
      return await this.page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (!el) return false;
        const rect = (el as HTMLElement).getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      }, selector);
    } catch {
      return false;
    }
  }

  // Poll session/localStorage for a JWT-looking token, with retries to account for
  // the redirect completing just after our initial wait.
  private async extractToken(): Promise<string | null> {
    if (!this.page) return null;
    for (let attempt = 0; attempt < 6; attempt++) {
      const token = await this.page.evaluate(() => {
        const storages: Storage[] = [sessionStorage, localStorage].filter(Boolean);
        for (const store of storages) {
          for (let i = 0; i < store.length; i++) {
            const key = store.key(i);
            if (!key) continue;
            const val = store.getItem(key);
            if (val && val.startsWith('eyJ') && val.length > 100) {
              return val;
            }
          }
        }
        // Also try a redirect fragment access_token
        const m = window.location.href.match(/access_token=([^&]+)/);
        if (m) return decodeURIComponent(m[1]);
        return null;
      });
      if (token) return token;
      await sleep(500);
    }
    return null;
  }

  private async saveAuthState(): Promise<void> {
    try {
      const state: AuthState = {
        userId: this.userId ?? undefined,
        accessToken: this.accessToken ?? undefined,
        savedAt: new Date().toISOString(),
      };
      writeFileSync(AUTH_STATE_PATH, JSON.stringify(state, null, 2));
      log('Auth state saved to disk');
    } catch (err) {
      log('Failed to save auth state:', err);
    }
  }

  private async fetchUserId(): Promise<void> {
    if (!this.page) return;

    try {
      const token = this.accessToken;
      const response = await this.page.evaluate(async (t) => {
        const headers: Record<string, string> = { Accept: 'application/json' };
        if (t) headers['Authorization'] = `Bearer ${t}`;

        const res = await fetch('/api/account', { credentials: 'include', headers });
        if (!res.ok) return { error: res.status, statusText: res.statusText };
        return await res.json();
      }, token);

      log('Account API response:', JSON.stringify(response).slice(0, 500));

      if (response.Persoon?.Id) {
        const personId = response.Persoon.Id;
        log('Logged in as person ID:', personId);

        const childrenResponse = await this.page.evaluate(
          async (params) => {
            const { personId, token } = params;
            const headers: Record<string, string> = { Accept: 'application/json' };
            if (token) headers['Authorization'] = `Bearer ${token}`;

            const endpoints = [
              `/api/personen/${personId}/kinderen`,
              `/api/leerlingen`,
              `/api/accounts/${personId}/kinderen`,
            ];

            for (const endpoint of endpoints) {
              try {
                const res = await fetch(endpoint, { credentials: 'include', headers });
                if (res.ok) return { endpoint, data: await res.json() };
              } catch {
                // try next endpoint
              }
            }
            return { error: 'No children endpoint found' };
          },
          { personId, token }
        );

        log('Children API response:', JSON.stringify(childrenResponse).slice(0, 500));

        const children = childrenResponse.data?.Items || childrenResponse.data || [];
        if (Array.isArray(children) && children.length > 0) {
          const child = children[0];
          this.userId = child.Id || child.Persoon?.Id || child.LeerlingId;
          log('Using child ID:', this.userId, 'Name:', child.Naam || child.Persoon?.Naam);
        } else {
          this.userId = personId;
          log('No children found, using own ID:', this.userId);
        }
      } else {
        log('Could not get user ID from response');
      }
    } catch (e) {
      log('Failed to fetch user ID:', e);
    }
  }

  // --- Local appointment storage ---

  private loadAppointments(): StoredAppointment[] {
    try {
      if (existsSync(APPOINTMENTS_PATH)) {
        return JSON.parse(readFileSync(APPOINTMENTS_PATH, 'utf-8'));
      }
    } catch (e) {
      log('Failed to read appointments:', e);
    }
    return [];
  }

  private saveAppointments(items: StoredAppointment[]): void {
    try {
      writeFileSync(APPOINTMENTS_PATH, JSON.stringify(items, null, 2));
    } catch (e) {
      log('Failed to save appointments:', e);
    }
  }

  // Merge locally-created appointments into a schedule's items. Local items are
  // appended and sorted by start time. Duplicate local items (same id) are skipped.
  private mergeLocalAppointments(items: ScheduleItem[], dateStr: string): ScheduleItem[] {
    const locals = this.loadAppointments().filter((a) => a.startTime.startsWith(dateStr));
    if (locals.length === 0) return items;

    const existing = new Set(items.map((it) => it.id).filter(Boolean));
    const merged = [...items];

    for (const a of locals) {
      if (existing.has(a.id)) continue;
      merged.push({
        id: a.id,
        startTime: timeToDisplay(a.startTime),
        endTime: timeToDisplay(a.endTime),
        subject: a.subject,
        cancelled: a.cancelled,
        description: a.description,
      });
    }

    merged.sort((x, y) => x.startTime.localeCompare(y.startTime));
    return merged;
  }

  // --- Appointment tools ---

  async listAppointments(): Promise<StoredAppointment[]> {
    const items = this.loadAppointments();
    return items.sort((a, b) => a.startTime.localeCompare(b.startTime));
  }

  async addAppointment(input: AddAppointmentInput): Promise<StoredAppointment> {
    if (!input.subject || !input.subject.trim()) {
      throw new Error('Subject is required');
    }

    const start = normalizeDateTime(input.start);
    const end = normalizeDateTime(input.end);

    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      throw new Error('Invalid date/time. Use ISO 8601 (YYYY-MM-DDTHH:mm) or YYYY-MM-DD HH:mm');
    }
    if (end.getTime() <= start.getTime()) {
      throw new Error('End time must be after start time');
    }

    const record: StoredAppointment = {
      id: `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      subject: input.subject.trim(),
      startTime: start.toISOString(),
      endTime: end.toISOString(),
      source: 'local',
      cancelled: false,
      description: input.description,
      createdAt: new Date().toISOString(),
    };

    // Best-effort POST to the Magister API (no documented create endpoint for
    // student/parent accounts). Failures are non-fatal: we persist locally regardless.
    await this.tryRemoteCreate(record);

    const items = this.loadAppointments();
    items.push(record);
    this.saveAppointments(items);

    // Invalidate the schedule cache for the affected date so the merged result loads.
    const dateStr = record.startTime.split('T')[0];
    const cache = scheduleCache.get(dateStr);
    if (cache) {
      cache.data = this.mergeLocalAppointments(cache.data, dateStr);
      scheduleCache.set(dateStr, cache.data);
    }

    log('Appointment added locally:', record.id, record.subject);
    return record;
  }

  private async tryRemoteCreate(record: StoredAppointment): Promise<void> {
    if (!this.page) return;
    try {
      const status = await this.page.evaluate(
        async (p) => {
          const headers: Record<string, string> = {
            Accept: 'application/json',
            'Content-Type': 'application/json',
          };
          if (p.token) headers['Authorization'] = `Bearer ${p.token}`;

          // The schedule endpoint is GET-only in the public API; posting is a
          // best-effort guess and is expected to 405.
          const res = await fetch(`/api/personen/${p.userId}/afspraken`, {
            method: 'POST',
            credentials: 'include',
            headers,
            body: JSON.stringify({
              Omschrijving: p.subject,
              Start: p.start,
              Einde: p.end,
              Inhoud: p.description,
              Status: 1,
            }),
          });
          return res.status;
        },
        {
          userId: this.userId,
          token: this.accessToken,
          subject: record.subject,
          start: record.startTime,
          end: record.endTime,
          description: record.description,
        }
      );
      log('Remote create attempt returned status:', status);
    } catch (e) {
      log('Remote create failed (expected):', e);
    }
  }

  async getSchedule(date: Date): Promise<ScheduleItem[]> {
    const formatDate = (d: Date) => d.toISOString().split('T')[0];
    const dateStr = formatDate(date);

    const cached = scheduleCache.get(dateStr);
    if (cached) {
      if (!cached.isStale) {
        log(`Cache HIT for ${dateStr} (fresh)`);
        return cached.data;
      }
      log(`Cache HIT for ${dateStr} (stale, will refresh)`);
      this.refreshScheduleInBackground(date, dateStr);
      return cached.data;
    }

    log(`Cache MISS for ${dateStr}, fetching...`);
    return this.fetchScheduleFromAPI(date, dateStr);
  }

  private async refreshScheduleInBackground(date: Date, dateStr: string): Promise<void> {
    this.fetchScheduleFromAPI(date, dateStr).catch((e) => {
      log('Background refresh failed:', e);
    });
  }

  private async fetchScheduleFromAPI(date: Date, dateStr: string): Promise<ScheduleItem[]> {
    if (!this.page) throw new Error('Client not initialized. Call init() first.');

    if (!this.userId) {
      log('No userId, trying to fetch...');
      await this.fetchUserId();
      if (!this.userId) {
        throw new Error('Could not get user ID');
      }
    }

    log(`Fetching schedule for ${dateStr} (userId: ${this.userId})`);

    const apiResult = await this.page.evaluate(
      async (params) => {
        const { dateStr, userId, token } = params;

        try {
          const scheduleUrl = `/api/personen/${userId}/afspraken?status=1&van=${dateStr}&tot=${dateStr}`;

          const headers: Record<string, string> = { Accept: 'application/json' };
          if (token) headers['Authorization'] = `Bearer ${token}`;

          const res = await fetch(scheduleUrl, { credentials: 'include', headers });

          if (!res.ok) {
            return { error: 'Failed to get schedule', status: res.status, url: scheduleUrl };
          }

          const schedule = await res.json();
          return { success: true, schedule };
        } catch (e) {
          return { error: String(e) };
        }
      },
      { dateStr, userId: this.userId, token: this.accessToken || '' }
    );

    log('API result:', JSON.stringify(apiResult, null, 2).slice(0, 500));

    if (apiResult.error) {
      log('API error:', apiResult.error);
      return this.getScheduleFromDOM(date);
    }

    const items: ScheduleItem[] = [];
    const appointments = apiResult.schedule?.Items || apiResult.schedule || [];

    for (const appt of appointments) {
      items.push({
        id: appt.Id != null ? String(appt.Id) : undefined,
        startTime: appt.Start
          ? new Date(appt.Start).toLocaleTimeString('nl-NL', {
              hour: '2-digit',
              minute: '2-digit',
              timeZone: 'Europe/Amsterdam',
            })
          : '',
        endTime: appt.Einde
          ? new Date(appt.Einde).toLocaleTimeString('nl-NL', {
              hour: '2-digit',
              minute: '2-digit',
              timeZone: 'Europe/Amsterdam',
            })
          : '',
        subject: appt.Omschrijving || appt.Vakken?.[0]?.Naam || 'Unknown',
        teacher: appt.Docenten?.[0]?.Naam,
        location: appt.Lokalen?.[0]?.Naam || appt.Lokatie,
        cancelled: appt.Status === 5 || appt.Uitval || appt.Vervallen || false,
        description: appt.Inhoud,
      });
    }

    const merged = this.mergeLocalAppointments(items, dateStr);

    scheduleCache.set(dateStr, merged);
    log(`Cached ${merged.length} items for ${dateStr}`);

    return merged;
  }

  private async getScheduleFromDOM(date: Date): Promise<ScheduleItem[]> {
    if (!this.page) return [];

    const dateStr = date.toISOString().split('T')[0];
    log('Falling back to DOM scraping for:', dateStr);

    await this.page.goto(`${this.getBaseUrl()}/magister/#/agenda`);
    await sleep(3000);

    const items = await this.page.evaluate(() => {
      const results: ScheduleItem[] = [];

      const selectors = [
        '.agenda-item',
        '.appointment',
        '[class*="appointment"]',
        '[class*="agenda-list"] > *',
        '.rooster-item',
      ];

      for (const selector of selectors) {
        const elements = document.querySelectorAll(selector);
        if (elements.length > 0) {
          elements.forEach((el) => {
            const text = el.textContent?.trim() || '';
            if (text.length > 0) {
              results.push({
                startTime: '',
                endTime: '',
                subject: text.slice(0, 100),
                cancelled:
                  el.classList.contains('cancelled') || el.classList.contains('vervallen'),
                description: undefined,
              });
            }
          });
          break;
        }
      }

      return results;
    });

    return this.mergeLocalAppointments(items, dateStr);
  }

  async getTodaySchedule(): Promise<ScheduleItem[]> {
    return this.getSchedule(new Date());
  }

  async getTomorrowSchedule(): Promise<ScheduleItem[]> {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    return this.getSchedule(tomorrow);
  }

  async getWeekSchedule(): Promise<Record<string, ScheduleItem[]>> {
    const result: Record<string, ScheduleItem[]> = {};
    const today = new Date();

    for (let i = 0; i < 7; i++) {
      const date = new Date(today);
      date.setDate(date.getDate() + i);
      const dateStr = date.toISOString().split('T')[0];
      result[dateStr] = await this.getSchedule(date);
    }

    return result;
  }

  async getFirstClass(date: Date): Promise<ClassResult> {
    const schedule = await this.getSchedule(date);
    const actualClasses = schedule.filter((item) => isActualClass(item));

    if (actualClasses.length === 0) {
      const cancellationReason = detectSchoolWideCancellation(schedule);
      if (cancellationReason) {
        return { class: null, cancellationReason };
      }
    }

    return {
      class: actualClasses.length > 0 ? actualClasses[0] : null,
      cancellationReason: null,
    };
  }

  async getLastClass(date: Date): Promise<ClassResult> {
    const schedule = await this.getSchedule(date);
    const actualClasses = schedule.filter((item) => isActualClass(item));

    if (actualClasses.length === 0) {
      const cancellationReason = detectSchoolWideCancellation(schedule);
      if (cancellationReason) {
        return { class: null, cancellationReason };
      }
    }

    return {
      class: actualClasses.length > 0 ? actualClasses[actualClasses.length - 1] : null,
      cancellationReason: null,
    };
  }

  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.page = null;
    }
  }
}