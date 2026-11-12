import { useEffect, useMemo, useRef, useState } from 'react';
import { addDays, formatMediumDate, formatMonthShort, weekdayIndex } from '../lib/dates.js';
import { MOODS, moodFor } from '../lib/moods.js';

/**
 * Charts for the Insights page, drawn as plain SVG.
 *
 * Conventions: every chart shows one series, so there is one data colour
 * (--chart-series) and no legend; the title says what is plotted.  Text is
 * always a text colour, never the data colour.  Each chart has a hover
 * tooltip, and the mood chart can also be read as a table.
 */

/** Tracks an element's width so SVG text stays a constant size as the layout changes. */
function useWidth() {
  const ref = useRef(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (!element) return undefined;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

function Tooltip({ x, y, containerWidth, children }) {
  // Keep the tooltip inside the chart horizontally.
  const left = Math.min(Math.max(x, 80), Math.max(containerWidth - 80, 80));
  return (
    <div
      role="status"
      className="pointer-events-none absolute z-10 w-max max-w-56 -translate-x-1/2 -translate-y-full rounded-lg border border-line bg-surface px-2.5 py-1.5 text-xs shadow-pop"
      style={{ left, top: y - 10 }}
    >
      {children}
    </div>
  );
}

const wordsLabel = (count) => `${count.toLocaleString()} ${count === 1 ? 'word' : 'words'}`;
const entriesLabel = (count) => (count === 1 ? '1 entry' : `${count} entries`);

// ------------------------------------------------------------- mood chart --

const MOOD_CHART = { height: 220, top: 14, right: 14, bottom: 26, left: 46 };

export function MoodChart({ daily, since, today }) {
  const [ref, width] = useWidth();
  const [active, setActive] = useState(null);

  const points = useMemo(() => daily.filter((day) => day.mood !== null), [daily]);
  const totalDays = Math.max(1, Math.round((Date.parse(today) - Date.parse(since)) / 86_400_000));

  const { height, top, right, bottom, left } = MOOD_CHART;
  const plotWidth = Math.max(0, width - left - right);
  const plotHeight = height - top - bottom;
  const xOf = (day) => left + (Math.round((Date.parse(day) - Date.parse(since)) / 86_400_000) / totalDays) * plotWidth;
  const yOf = (mood) => top + ((5 - mood) / 4) * plotHeight;

  const coordinates = points.map((point) => ({ ...point, x: xOf(point.day), y: yOf(point.mood) }));
  const line = coordinates.map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ');
  const area = coordinates.length > 1 ? `${line} L${coordinates.at(-1).x.toFixed(1)},${yOf(1)} L${coordinates[0].x.toFixed(1)},${yOf(1)} Z` : '';

  // A tick on the first day of each month inside the window.
  const monthTicks = useMemo(() => {
    const ticks = [];
    for (let day = since; day <= today; day = addDays(day, 1)) {
      if (day.endsWith('-01')) ticks.push(day);
    }
    return ticks;
  }, [since, today]);

  const activePoint = active === null ? null : coordinates[active];

  const pickNearest = (clientX, target) => {
    if (coordinates.length === 0) return;
    const x = clientX - target.getBoundingClientRect().left;
    let nearest = 0;
    for (let index = 1; index < coordinates.length; index += 1) {
      if (Math.abs(coordinates[index].x - x) < Math.abs(coordinates[nearest].x - x)) nearest = index;
    }
    setActive(nearest);
  };

  const onKeyDown = (event) => {
    if (coordinates.length === 0) return;
    if (event.key === 'ArrowRight') setActive((current) => Math.min(coordinates.length - 1, (current ?? -1) + 1));
    else if (event.key === 'ArrowLeft') setActive((current) => Math.max(0, (current ?? coordinates.length) - 1));
    else if (event.key === 'Escape') setActive(null);
    else return;
    event.preventDefault();
  };

  if (points.length === 0) {
    return <p className="py-10 text-center text-sm text-ink-3">Pick a mood when you write, and it will be charted here.</p>;
  }

  return (
    <div>
      <div ref={ref} className="relative">
        {width > 0 && (
          <svg
            width={width}
            height={height}
            role="img"
            aria-label={`Line chart of daily mood from ${formatMediumDate(since)} to ${formatMediumDate(today)}. Use the left and right arrow keys to read each day.`}
            tabIndex={0}
            onKeyDown={onKeyDown}
            onBlur={() => setActive(null)}
            onPointerMove={(event) => pickNearest(event.clientX, event.currentTarget)}
            onPointerLeave={() => setActive(null)}
            className="block touch-pan-y rounded-lg"
          >
            {MOODS.map((mood) => (
              <g key={mood.value}>
                <line x1={left} x2={width - right} y1={yOf(mood.value)} y2={yOf(mood.value)} stroke="var(--chart-grid)" strokeWidth="1" />
                <text x={left - 10} y={yOf(mood.value)} textAnchor="end" dominantBaseline="middle" className="fill-ink-3 text-[11px]">
                  {mood.label}
                </text>
              </g>
            ))}
            {monthTicks.map((day) => (
              <text key={day} x={xOf(day)} y={height - 6} textAnchor="middle" className="fill-ink-3 text-[11px]">
                {formatMonthShort(day)}
              </text>
            ))}

            {area && <path d={area} fill="var(--chart-wash)" />}
            {coordinates.length > 1 && (
              <path d={line} fill="none" stroke="var(--chart-series)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
            )}
            {/* With only a handful of points the line alone is hard to read, so mark each one. */}
            {coordinates.length <= 12 &&
              coordinates.map((point) => (
                <circle key={point.day} cx={point.x} cy={point.y} r="4" fill="var(--chart-series)" stroke="var(--surface)" strokeWidth="2" />
              ))}

            {activePoint && (
              <>
                <line x1={activePoint.x} x2={activePoint.x} y1={top} y2={yOf(1)} stroke="var(--chart-axis)" strokeWidth="1" />
                <circle cx={activePoint.x} cy={activePoint.y} r="5" fill="var(--chart-series)" stroke="var(--surface)" strokeWidth="2" />
              </>
            )}
          </svg>
        )}
        {activePoint && (
          <Tooltip x={activePoint.x} y={activePoint.y} containerWidth={width}>
            <p className="font-medium text-ink">{formatMediumDate(activePoint.day)}</p>
            <p className="text-ink-2">
              {moodFor(Math.round(activePoint.mood))?.label} · {activePoint.mood.toFixed(activePoint.mood % 1 ? 1 : 0)} of 5
            </p>
            <p className="text-ink-3">{entriesLabel(activePoint.entries)}</p>
          </Tooltip>
        )}
      </div>

      <details className="mt-3 text-sm">
        <summary className="inline-flex text-[13px] font-medium text-ink-3 hover:text-ink-2">View as table</summary>
        <div className="scroll-quiet mt-2 max-h-56 overflow-y-auto rounded-xl border border-line">
          <table className="w-full text-left text-[13px]">
            <thead className="sticky top-0 bg-sunken text-ink-2">
              <tr>
                <th scope="col" className="px-3 py-1.5 font-medium">
                  Date
                </th>
                <th scope="col" className="px-3 py-1.5 font-medium">
                  Mood
                </th>
                <th scope="col" className="px-3 py-1.5 text-right font-medium">
                  Entries
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {[...points].reverse().map((point) => (
                <tr key={point.day}>
                  <td className="px-3 py-1.5 text-ink">{formatMediumDate(point.day)}</td>
                  <td className="px-3 py-1.5 text-ink-2">
                    {moodFor(Math.round(point.mood))?.label} ({point.mood.toFixed(point.mood % 1 ? 1 : 0)})
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-ink-2">{point.entries}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}

// ------------------------------------------------------- activity heatmap --

const HEAT = ['var(--heat-0)', 'var(--heat-1)', 'var(--heat-2)', 'var(--heat-3)', 'var(--heat-4)'];
const WEEKDAY_LABELS = ['Mon', '', 'Wed', '', 'Fri', '', ''];

export function ActivityHeatmap({ daily, since, today }) {
  const [ref, width] = useWidth();
  const [active, setActive] = useState(null);

  const { cells, weeks, thresholds } = useMemo(() => {
    const byDay = new Map(daily.map((day) => [day.day, day]));
    const offset = weekdayIndex(since);
    const list = [];
    let index = 0;
    for (let day = since; day <= today; day = addDays(day, 1), index += 1) {
      const data = byDay.get(day);
      list.push({ day, words: data?.words ?? 0, entries: data?.entries ?? 0, column: Math.floor((index + offset) / 7), row: (index + offset) % 7 });
    }
    // Bucket boundaries from the quartiles of the days that have writing.
    const values = list.map((cell) => cell.words).filter((value) => value > 0).sort((a, b) => a - b);
    const quantile = (q) => values[Math.min(values.length - 1, Math.floor(q * values.length))] ?? 0;
    return { cells: list, weeks: (list.at(-1)?.column ?? 0) + 1, thresholds: [quantile(0.25), quantile(0.5), quantile(0.75)] };
  }, [daily, since, today]);

  const level = (words) => {
    if (words === 0) return 0;
    if (words <= thresholds[0]) return 1;
    if (words <= thresholds[1]) return 2;
    if (words <= thresholds[2]) return 3;
    return 4;
  };

  const labelWidth = 30;
  const gap = 3;
  const top = 18;
  const size = Math.max(9, Math.min(24, Math.floor((width - labelWidth) / weeks) - gap));
  const step = size + gap;
  const height = top + 7 * step;
  const xOf = (column) => labelWidth + column * step;

  // Label a column with the month when the 1st falls inside it.
  const monthLabels = cells.filter((cell) => cell.day.endsWith('-01')).map((cell) => ({ day: cell.day, column: cell.column }));
  const activeCell = active === null ? null : cells[active];

  return (
    <div>
      <div ref={ref} className="relative">
        {width > 0 && (
          <svg
            width={width}
            height={height}
            role="img"
            aria-label={`Calendar heatmap of words written per day from ${formatMediumDate(since)} to ${formatMediumDate(today)}. Stronger colour means more writing.`}
            onPointerLeave={() => setActive(null)}
            className="block"
          >
            {monthLabels.map((label) => (
              <text key={label.day} x={xOf(label.column)} y={10} className="fill-ink-3 text-[11px]">
                {formatMonthShort(label.day)}
              </text>
            ))}
            {WEEKDAY_LABELS.map(
              (label, row) =>
                label && (
                  <text key={label} x={0} y={top + row * step + size / 2} dominantBaseline="middle" className="fill-ink-3 text-[11px]">
                    {label}
                  </text>
                ),
            )}
            {cells.map((cell, index) => (
              <rect
                key={cell.day}
                x={xOf(cell.column)}
                y={top + cell.row * step}
                width={size}
                height={size}
                rx="3"
                fill={HEAT[level(cell.words)]}
                stroke={active === index ? 'var(--ink)' : 'none'}
                strokeWidth="1.5"
                onPointerEnter={() => setActive(index)}
              />
            ))}
          </svg>
        )}
        {activeCell && (
          <Tooltip x={xOf(activeCell.column) + size / 2} y={top + activeCell.row * step} containerWidth={width}>
            <p className="font-medium text-ink">{formatMediumDate(activeCell.day)}</p>
            <p className="text-ink-2">
              {activeCell.entries === 0 ? 'No entry' : `${entriesLabel(activeCell.entries)} · ${wordsLabel(activeCell.words)}`}
            </p>
          </Tooltip>
        )}
      </div>
      <div className="mt-3 flex items-center justify-end gap-1.5 text-[11px] text-ink-3">
        Less
        {HEAT.map((color) => (
          <span key={color} className="size-3 rounded-[3px]" style={{ background: color }} />
        ))}
        More
      </div>
    </div>
  );
}

// ----------------------------------------------------------------- bars ----

/** Horizontal bars with the value printed at the tip of each bar. */
export function BarList({ items, unit }) {
  const max = Math.max(1, ...items.map((item) => item.value));
  return (
    <ul className="space-y-2.5">
      {items.map((item) => (
        <li key={item.label} className="grid grid-cols-[minmax(0,7rem)_1fr] items-center gap-3 text-sm" title={item.detail}>
          <span className="truncate text-ink-2">{item.label}</span>
          <span className="flex items-center gap-2">
            <span className="flex flex-1 items-center">
              {/* Square at the baseline, rounded at the data end. */}
              <span
                className="h-2.5 min-w-1 rounded-r-[4px]"
                style={{ width: `${(item.value / max) * 100}%`, background: 'var(--chart-series)' }}
              />
            </span>
            <span className="w-8 shrink-0 text-right text-[13px] tabular-nums text-ink-2">
              {item.value}
              <span className="sr-only"> {unit}</span>
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Five columns, one per mood, with the count on the cap. */
export function MoodColumns({ distribution }) {
  const max = Math.max(1, ...distribution.map((bucket) => bucket.count));
  return (
    <div className="flex items-end justify-between gap-2" role="img" aria-label={`Entries by mood: ${distribution.map((bucket) => `${moodFor(bucket.mood).label} ${bucket.count}`).join(', ')}.`}>
      {distribution.map((bucket) => {
        const mood = moodFor(bucket.mood);
        return (
          <div key={bucket.mood} className="flex flex-1 flex-col items-center gap-1.5" title={`${mood.label}: ${entriesLabel(bucket.count)}`}>
            <span className="text-[13px] tabular-nums text-ink-2">{bucket.count}</span>
            <div className="flex h-28 w-full items-end justify-center border-b border-[var(--chart-axis)]">
              <div
                className="w-6 rounded-t-[4px]"
                style={{ height: `${(bucket.count / max) * 100}%`, minHeight: bucket.count ? 3 : 0, background: 'var(--chart-series)' }}
              />
            </div>
            <span className="flex flex-col items-center gap-0.5 text-[11px] text-ink-3">
              <mood.Icon className="size-4" aria-hidden />
              {mood.label}
            </span>
          </div>
        );
      })}
    </div>
  );
}
