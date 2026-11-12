import { db } from '../db/index.js';
import { addDays, diffDays } from '../utils/temporal.js';

/** Current and longest run of consecutive days with at least one entry. */
export function computeStreaks(datesDescending, today) {
  if (datesDescending.length === 0) return { current: 0, longest: 0 };

  let longest = 1;
  let run = 1;
  for (let index = 1; index < datesDescending.length; index += 1) {
    run = diffDays(datesDescending[index - 1], datesDescending[index]) === 1 ? run + 1 : 1;
    longest = Math.max(longest, run);
  }

  // The streak is still alive if the latest entry is from today or yesterday.
  let current = 0;
  if (diffDays(today, datesDescending[0]) <= 1) {
    current = 1;
    for (let index = 1; index < datesDescending.length; index += 1) {
      if (diffDays(datesDescending[index - 1], datesDescending[index]) !== 1) break;
      current += 1;
    }
  }
  return { current, longest };
}

export async function getInsights(userId, { today, days = 120 }) {
  const since = addDays(today, -(days - 1));

  const [totals, dates, daily, tags, moods] = await Promise.all([
    db.query(
      `SELECT count(*)::int AS entries,
              coalesce(sum(word_count), 0)::int AS words,
              round(avg(mood)::numeric, 2)::float8 AS average_mood,
              to_char(min(entry_date), 'YYYY-MM-DD') AS first_date
       FROM entries WHERE user_id = $1`,
      [userId],
    ),
    db.query(
      `SELECT DISTINCT to_char(entry_date, 'YYYY-MM-DD') AS day FROM entries
       WHERE user_id = $1 AND entry_date <= $2::date ORDER BY day DESC LIMIT 1000`,
      [userId, today],
    ),
    db.query(
      `SELECT to_char(entry_date, 'YYYY-MM-DD') AS day,
              count(*)::int AS entries,
              sum(word_count)::int AS words,
              round(avg(mood)::numeric, 2)::float8 AS mood
       FROM entries
       WHERE user_id = $1 AND entry_date BETWEEN $2::date AND $3::date
       GROUP BY entry_date ORDER BY entry_date`,
      [userId, since, today],
    ),
    db.query(
      `SELECT tag, count(*)::int AS count, round(avg(mood)::numeric, 2)::float8 AS mood
       FROM entries, unnest(tags) AS tag
       WHERE user_id = $1
       GROUP BY tag ORDER BY count DESC, tag LIMIT 10`,
      [userId],
    ),
    db.query(
      `SELECT mood, count(*)::int AS count FROM entries
       WHERE user_id = $1 AND mood IS NOT NULL GROUP BY mood ORDER BY mood`,
      [userId],
    ),
  ]);

  const summary = totals.rows[0];
  return {
    today,
    since,
    totals: {
      entries: summary.entries,
      words: summary.words,
      averageMood: summary.average_mood,
      firstEntryDate: summary.first_date,
      daysJournaled: dates.rows.length,
    },
    streak: computeStreaks(
      dates.rows.map((row) => row.day),
      today,
    ),
    daily: daily.rows,
    topTags: tags.rows,
    moodDistribution: [1, 2, 3, 4, 5].map((mood) => ({
      mood,
      count: moods.rows.find((row) => row.mood === mood)?.count ?? 0,
    })),
  };
}
