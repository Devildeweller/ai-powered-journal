/**
 * Journal dates are plain 'YYYY-MM-DD' strings: an entry belongs to a calendar
 * day, not an instant.  Formatting parses them as UTC so the label never
 * drifts by a day in time zones behind or ahead of UTC.
 */

const pad = (value) => String(value).padStart(2, '0');

/** Today's date in the user's own time zone. */
export function localToday() {
  const now = new Date();
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

const asDate = (iso) => new Date(`${iso}T00:00:00Z`);
const formatter = (options) => new Intl.DateTimeFormat(undefined, { timeZone: 'UTC', ...options });

const LONG = formatter({ weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const MEDIUM = formatter({ day: 'numeric', month: 'short', year: 'numeric' });
const SHORT = formatter({ day: 'numeric', month: 'short' });
const MONTH = formatter({ month: 'long', year: 'numeric' });
const MONTH_SHORT = formatter({ month: 'short' });
const WEEKDAY = formatter({ weekday: 'short' });

export const formatLongDate = (iso) => LONG.format(asDate(iso));
export const formatMediumDate = (iso) => MEDIUM.format(asDate(iso));
export const formatShortDate = (iso) => SHORT.format(asDate(iso));
export const formatMonth = (iso) => MONTH.format(asDate(iso));
export const formatMonthShort = (iso) => MONTH_SHORT.format(asDate(iso));
export const formatWeekday = (iso) => WEEKDAY.format(asDate(iso));
export const dayOfMonth = (iso) => Number(iso.slice(8, 10));

export function addDays(iso, days) {
  return new Date(asDate(iso).getTime() + days * 86_400_000).toISOString().slice(0, 10);
}

/** 0 = Monday … 6 = Sunday. */
export const weekdayIndex = (iso) => (asDate(iso).getUTCDay() + 6) % 7;

/** "Today", "Yesterday" or a medium date. */
export function formatRelativeDay(iso) {
  const today = localToday();
  if (iso === today) return 'Today';
  if (iso === addDays(today, -1)) return 'Yesterday';
  return formatMediumDate(iso);
}

const RELATIVE = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

/** "3 hours ago", for timestamps. */
export function formatTimeAgo(timestamp) {
  const seconds = Math.round((new Date(timestamp).getTime() - Date.now()) / 1000);
  const steps = [
    ['year', 31_536_000],
    ['month', 2_592_000],
    ['day', 86_400],
    ['hour', 3600],
    ['minute', 60],
  ];
  for (const [unit, size] of steps) {
    if (Math.abs(seconds) >= size) return RELATIVE.format(Math.round(seconds / size), unit);
  }
  return 'just now';
}
