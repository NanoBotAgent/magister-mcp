import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import {
  detectSchoolWideCancellation,
  isActualClass,
  normalizeDateTime,
  timeToDisplay,
  type ScheduleItem,
} from '../src/helpers.js';

describe('normalizeDateTime', () => {
  it('parses ISO datetime with seconds', () => {
    const d = normalizeDateTime('2026-01-05T08:30:00');
    assert.ok(!isNaN(d.getTime()));
  });

  it('parses minute-only datetime and appends seconds', () => {
    const d = normalizeDateTime('2026-01-05T08:30');
    // Interpreted as +01:00 (Amsterdam, winter), so UTC is 07:30.
    assert.equal(d.toISOString(), '2026-01-05T07:30:00.000Z');
  });

  it('parses space-separated datetime', () => {
    const d = normalizeDateTime('2026-01-05 08:30');
    assert.equal(d.toISOString(), '2026-01-05T07:30:00.000Z');
  });

  it('honors an explicit Z timezone', () => {
    const d = normalizeDateTime('2026-01-05T08:30:00Z');
    assert.equal(d.toISOString(), '2026-01-05T08:30:00.000Z');
  });

  it('rejects garbage input', () => {
    const d = normalizeDateTime('not-a-date');
    assert.ok(isNaN(d.getTime()));
  });
});

describe('timeToDisplay', () => {
  it('formats an ISO timestamp as HH:mm in Amsterdam time', () => {
    const out = timeToDisplay('2026-01-05T08:30:00.000Z');
    assert.equal(out, '09:30'); // 08:30 UTC -> 09:30 CET
  });

  it('returns empty string for invalid input', () => {
    assert.equal(timeToDisplay('garbage'), '');
  });
});

describe('isActualClass', () => {
  const base: ScheduleItem = {
    startTime: '08:30',
    endTime: '09:20',
    subject: 'Mathematics',
    teacher: 'Mr. de Vries',
    cancelled: false,
  };

  it('accepts a normal class', () => {
    assert.ok(isActualClass(base));
  });

  it('rejects cancelled classes', () => {
    assert.ok(!isActualClass({ ...base, cancelled: true }));
  });

  it('rejects "geen les" notices', () => {
    assert.ok(!isActualClass({ ...base, subject: 'Geen les vandaag' }));
  });

  it('rejects "lesuitval" notices', () => {
    assert.ok(!isActualClass({ ...base, subject: 'Lesuitval aardrijkskunde' }));
  });

  it('rejects all-day notices at 00:00-00:00', () => {
    assert.ok(!isActualClass({ ...base, startTime: '00:00', endTime: '00:00' }));
  });

  it('rejects items without a teacher', () => {
    assert.ok(!isActualClass({ ...base, teacher: undefined }));
  });

  it('rejects informational notices starting with ! or #', () => {
    assert.ok(!isActualClass({ ...base, subject: '!Uitje naar het museum' }));
    assert.ok(!isActualClass({ ...base, subject: '#Schoolfeest' }));
  });
});

describe('detectSchoolWideCancellation', () => {
  const notice: ScheduleItem = {
    startTime: '00:00',
    endTime: '00:00',
    subject: 'School gesloten',
    description: 'Alle lessen vervallen vanwege storm',
    cancelled: false,
  };

  it('detects a school-wide cancellation from an all-day notice', () => {
    const reason = detectSchoolWideCancellation([notice]);
    assert.ok(reason);
    assert.match(reason as string, /lessen vervallen/i);
  });

  it('returns null when there is no cancellation notice', () => {
    const normal: ScheduleItem = {
      startTime: '08:30',
      endTime: '09:20',
      subject: 'Mathematics',
      teacher: 'Mr. de Vries',
      cancelled: false,
    };
    assert.equal(detectSchoolWideCancellation([normal]), null);
  });
});

describe('appointment persistence round-trip', () => {
  let dir: string;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'magister-test-'));
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes and reads a StoredAppointment-shaped object', () => {
    const record = {
      id: 'local-123',
      subject: 'Tandarts',
      startTime: '2026-01-05T08:30:00.000Z',
      endTime: '2026-01-05T09:00:00.000Z',
      source: 'local',
      cancelled: false,
      description: 'Controle',
      createdAt: '2026-01-04T12:00:00.000Z',
    };
    const path = join(dir, '.appointments.json');
    writeFileSync(path, JSON.stringify([record], null, 2));

    const read = JSON.parse(readFileSync(path, 'utf-8'));
    assert.equal(read.length, 1);
    assert.equal(read[0].subject, 'Tandarts');
    assert.equal(read[0].source, 'local');
  });
});