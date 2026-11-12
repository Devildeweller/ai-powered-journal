import { X } from 'lucide-react';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { MOODS, moodFor } from '../lib/moods.js';
import { cx } from './ui.jsx';

/** Five-step mood selector.  Selecting the current mood again clears it. */
export function MoodPicker({ value, onChange }) {
  return (
    <div role="radiogroup" aria-label="Mood" className="flex flex-wrap gap-1.5">
      {MOODS.map(({ value: mood, label, Icon }) => {
        const selected = value === mood;
        return (
          <button
            key={mood}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(selected ? null : mood)}
            className={cx(
              'inline-flex h-9 items-center gap-1.5 rounded-full border px-3 text-[13px] font-medium transition-colors',
              selected ? 'border-accent bg-accent-soft text-accent' : 'border-line-strong text-ink-2 hover:bg-sunken hover:text-ink',
            )}
          >
            <Icon className="size-4" aria-hidden />
            {label}
          </button>
        );
      })}
    </div>
  );
}

/** Read-only mood: icon plus word. */
export function MoodBadge({ mood, className }) {
  const meta = moodFor(mood);
  if (!meta) return null;
  return (
    <span className={cx('inline-flex items-center gap-1 text-xs font-medium text-ink-2', className)}>
      <meta.Icon className="size-3.5" aria-hidden />
      {meta.label}
    </span>
  );
}

/** Tag editor: type and press Enter or comma; Backspace on an empty field removes the last tag. */
export function TagInput({ value, onChange, suggestions = [], max = 10 }) {
  const [draft, setDraft] = useState('');
  const listId = useId();

  const add = (raw) => {
    const tag = raw.trim().toLowerCase().replace(/\s+/g, '-').slice(0, 30);
    if (tag && !value.includes(tag) && value.length < max) onChange([...value, tag]);
    setDraft('');
  };

  return (
    <div className="flex min-h-10 flex-wrap items-center gap-1.5 rounded-xl border border-line-strong bg-surface px-2 py-1.5 focus-within:border-accent">
      {value.map((tag) => (
        <span key={tag} className="inline-flex h-6 items-center gap-1 rounded-full bg-sunken pl-2.5 pr-1 text-xs font-medium text-ink-2">
          {tag}
          <button
            type="button"
            onClick={() => onChange(value.filter((item) => item !== tag))}
            className="grid size-4 place-items-center rounded-full hover:bg-line-strong hover:text-ink"
            aria-label={`Remove tag ${tag}`}
          >
            <X className="size-3" />
          </button>
        </span>
      ))}
      <input
        value={draft}
        onChange={(event) => {
          const next = event.target.value;
          if (next.endsWith(',')) add(next.slice(0, -1));
          else setDraft(next);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            add(draft);
          } else if (event.key === 'Backspace' && !draft && value.length) {
            onChange(value.slice(0, -1));
          }
        }}
        onBlur={() => draft && add(draft)}
        list={listId}
        placeholder={value.length ? '' : 'Add tags…'}
        aria-label="Tags"
        className="h-7 min-w-24 flex-1 bg-transparent px-1.5 text-sm text-ink outline-none placeholder:text-ink-3"
      />
      <datalist id={listId}>
        {suggestions
          .filter((tag) => !value.includes(tag))
          .map((tag) => (
            <option key={tag} value={tag} />
          ))}
      </datalist>
    </div>
  );
}

/** Textarea that grows with its content instead of scrolling inside itself. */
export function AutoTextarea({ value, minRows = 1, maxHeight, className, ref: forwardedRef, ...props }) {
  const ref = useRef(null);
  // Expose the element to a parent ref as well (React 19 passes `ref` as a prop).
  const setRef = (element) => {
    ref.current = element;
    if (typeof forwardedRef === 'function') forwardedRef(element);
    else if (forwardedRef) forwardedRef.current = element;
  };

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.style.height = 'auto';
    const height = maxHeight ? Math.min(element.scrollHeight, maxHeight) : element.scrollHeight;
    element.style.height = `${height}px`;
    element.style.overflowY = maxHeight && element.scrollHeight > maxHeight ? 'auto' : 'hidden';
  }, [value, maxHeight]);

  return <textarea {...props} ref={setRef} value={value} rows={minRows} className={cx('resize-none', className)} />;
}

/** Returns `value` after it has stopped changing for `delay` ms. */
export function useDebounced(value, delay = 300) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}
