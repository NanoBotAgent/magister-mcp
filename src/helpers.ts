// Pure, dependency-free helpers shared across the client and the test suite.
// Keeping these here (rather than private in magister.ts) lets unit tests import
// the real implementation instead of mirroring the logic.

export interface ScheduleItem {
  startTime: string;
  endTime: string;
  subject: string;
  teacher?: string;
  location?: string;
  cancelled: boolean;
  description?: string;
  id?: string;
}

// Normalize a datetime string (accepts "YYYY-MM-DDTHH:mm", "YYYY-MM-DD HH:mm",
// or a full ISO string) into a Date. Values without an explicit timezone are
// interpreted as Europe/Amsterdam local time (+01:00).
export function normalizeDateTime(value: string): Date {
  const trimmed = value.trim();
  const hasTimezone = /Z$|[+-]\d{2}:\d{2}$/.test(trimmed);

  if (hasTimezone) {
    return new Date(trimmed.replace(' ', 'T'));
  }

  // No timezone: parse as Amsterdam local time and convert to a UTC Date.
  const normalized = trimmed.replace(' ', 'T');
  const withSeconds = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(normalized)
    ? `${normalized}:00`
    : normalized;
  return new Date(`${withSeconds}+01:00`);
}

// Format an ISO timestamp to "HH:mm" display form.
export function timeToDisplay(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('nl-NL', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/Amsterdam',
  });
}

// Determine whether a schedule item is an actual class (excludes cancellations,
// "geen les"/"lesuitval" notices, all-day notices, and items without a teacher).
export function isActualClass(item: ScheduleItem): boolean {
  if (item.cancelled) return false;

  const subject = item.subject.toLowerCase();

  if (subject.includes('geen les')) return false;
  if (subject.includes('lesuitval')) return false;
  if (subject.includes('vervallen')) return false;

  if (item.subject.startsWith('!') || item.subject.startsWith('#')) return false;

  if (item.startTime === '00:00' && item.endTime === '00:00') return false;

  if (!item.teacher) return false;

  return true;
}

// Detect a school-wide cancellation from an all-day (00:00-00:00) notice.
// Returns the cancellation reason text, or null if none is found.
export function detectSchoolWideCancellation(schedule: ScheduleItem[]): string | null {
  const cancellationPatterns = [
    /alle lessen vervallen/i,
    /school gesloten/i,
    /geen lessen/i,
    /lesuitval/i,
    /code (oranje|rood)/i,
  ];

  for (const item of schedule) {
    if (item.startTime !== '00:00' || item.endTime !== '00:00') {
      continue;
    }

    const textToCheck = `${item.subject} ${item.description || ''}`;

    for (const pattern of cancellationPatterns) {
      if (pattern.test(textToCheck)) {
        return item.description || item.subject;
      }
    }
  }

  return null;
}