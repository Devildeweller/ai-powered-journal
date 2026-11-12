/**
 * Date helpers working on plain 'YYYY-MM-DD' strings in UTC, so nothing here
 * depends on the server's time zone.  "Today" always comes from the client.
 */

const DAY_MS = 86_400_000;
const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];
const NUMBER_WORDS = { a: 1, one: 1, two: 2, couple: 2, three: 3, few: 3, four: 4, five: 5, six: 6 };

export const isIsoDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));

const toDate = (iso) => new Date(`${iso}T00:00:00Z`);
const toIso = (date) => date.toISOString().slice(0, 10);

export function todayIso() {
  return toIso(new Date());
}

export function addDays(iso, days) {
  return toIso(new Date(toDate(iso).getTime() + days * DAY_MS));
}

export function diffDays(laterIso, earlierIso) {
  return Math.round((toDate(laterIso) - toDate(earlierIso)) / DAY_MS);
}

export function weekdayName(iso) {
  return ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][toDate(iso).getUTCDay()];
}

/** Monday of the week containing the given day. */
function startOfWeek(iso) {
  const day = toDate(iso).getUTCDay();
  return addDays(iso, -((day + 6) % 7));
}

function monthRange(year, monthIndex) {
  const from = new Date(Date.UTC(year, monthIndex, 1));
  const to = new Date(Date.UTC(year, monthIndex + 1, 0));
  return { from: toIso(from), to: toIso(to) };
}

function shiftMonths(iso, months) {
  const date = toDate(iso);
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(date.getUTCDate(), lastDay));
  return toIso(target);
}

function parseCount(raw) {
  if (!raw) return 1;
  const numeric = Number.parseInt(raw, 10);
  if (Number.isFinite(numeric)) return numeric;
  return NUMBER_WORDS[raw.toLowerCase()] ?? 1;
}

/**
 * Finds an explicit time window in a question ("last week", "in December",
 * "past 3 days").  Embeddings are poor at dates — "last week" is not similar
 * to an entry just because it was written last week — so time expressions are
 * turned into a hard SQL date filter instead.
 *
 * Returns { from, to, label } with inclusive ISO dates, or null.
 */
export function parseDateRange(text, today) {
  const input = ` ${text.toLowerCase().replace(/[’']/g, "'")} `;
  const clamp = (range) => ({ ...range, to: range.to > today ? today : range.to });

  // "past 3 days", "last two weeks", "previous couple of months"
  const span = input.match(
    /\b(?:past|last|previous)\s+(\d{1,3}|a|one|two|three|four|five|six|couple|few)?\s*(?:of\s+)?(day|week|month|year)s\b/,
  );
  if (span) {
    const count = Math.min(parseCount(span[1]), 400);
    const unit = span[2];
    const from =
      unit === 'day' ? addDays(today, -(count - 1))
      : unit === 'week' ? addDays(today, -(count * 7 - 1))
      : unit === 'month' ? shiftMonths(today, -count)
      : shiftMonths(today, -12 * count);
    return { from, to: today, label: `the last ${count} ${unit}${count === 1 ? '' : 's'}` };
  }

  if (/\b(today|tonight|this (morning|afternoon|evening))\b/.test(input)) {
    return { from: today, to: today, label: 'today' };
  }
  if (/\byesterday\b/.test(input)) {
    const day = addDays(today, -1);
    return { from: day, to: day, label: 'yesterday' };
  }
  if (/\b(last|this past|over the) weekend\b/.test(input)) {
    // Most recent completed Saturday–Sunday.
    const monday = startOfWeek(today);
    return { from: addDays(monday, -2), to: addDays(monday, -1), label: 'last weekend' };
  }
  if (/\bthis week\b/.test(input)) {
    return { from: startOfWeek(today), to: today, label: 'this week' };
  }
  if (/\b(past|last|previous) week\b/.test(input)) {
    const monday = startOfWeek(today);
    // "past week" reads as a rolling window, "last week" as the previous calendar week.
    if (/\bpast week\b/.test(input)) return { from: addDays(today, -6), to: today, label: 'the past week' };
    return { from: addDays(monday, -7), to: addDays(monday, -1), label: 'last week' };
  }
  if (/\bthis month\b/.test(input)) {
    const now = toDate(today);
    return clamp({ ...monthRange(now.getUTCFullYear(), now.getUTCMonth()), label: 'this month' });
  }
  if (/\b(past|last|previous) month\b/.test(input)) {
    if (/\bpast month\b/.test(input)) return { from: shiftMonths(today, -1), to: today, label: 'the past month' };
    const now = toDate(today);
    return { ...monthRange(now.getUTCFullYear(), now.getUTCMonth() - 1), label: 'last month' };
  }
  if (/\bthis year\b/.test(input)) {
    return { from: `${today.slice(0, 4)}-01-01`, to: today, label: 'this year' };
  }
  if (/\b(past|last|previous) year\b/.test(input)) {
    if (/\bpast year\b/.test(input)) return { from: shiftMonths(today, -12), to: today, label: 'the past year' };
    const year = Number.parseInt(today.slice(0, 4), 10) - 1;
    return { from: `${year}-01-01`, to: `${year}-12-31`, label: 'last year' };
  }

  // Month names: "in December", "January 2026", "last March".
  for (let index = 0; index < MONTHS.length; index += 1) {
    const name = MONTHS[index];
    // "may" is also a verb, so it needs a preposition or a year next to it.
    const pattern =
      name === 'may'
        ? /\b(?:in|during|last|this|since|of)\s+may\b(?:\s+(\d{4}))?|\bmay\s+(\d{4})\b/
        : new RegExp(`\\b${name}\\b(?:\\s+(?:of\\s+)?(\\d{4}))?`);
    const match = input.match(pattern);
    if (!match) continue;

    const explicitYear = match[1] ?? match[2];
    const now = toDate(today);
    let year = explicitYear ? Number.parseInt(explicitYear, 10) : now.getUTCFullYear();
    // Without a year, a month that has not started yet means last year's.
    if (!explicitYear && index > now.getUTCMonth()) year -= 1;
    const label = `${name[0].toUpperCase()}${name.slice(1)} ${year}`;
    return clamp({ ...monthRange(year, index), label });
  }

  if (/\b(recently|lately|these days|of late)\b/.test(input)) {
    return { from: addDays(today, -13), to: today, label: 'the last two weeks' };
  }

  return null;
}
