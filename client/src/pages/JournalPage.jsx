import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { BookOpen, PenLine, Search, SearchX, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { MoodBadge, useDebounced } from '../components/entryFields.jsx';
import { Button, ButtonLink, Card, EmptyState, ErrorNote, PageHeader, Skeleton, Spinner, Tag, cx } from '../components/ui.jsx';
import { api } from '../lib/api.js';
import { dayOfMonth, formatMediumDate, formatMonth, formatWeekday } from '../lib/dates.js';
import { MOODS } from '../lib/moods.js';

function EntryCard({ entry, match }) {
  return (
    <Link
      to={`/journal/${entry.id}`}
      className="group flex gap-4 rounded-2xl border border-line bg-surface p-4 shadow-card transition-colors hover:border-line-strong md:gap-5 md:p-5"
    >
      <div className="w-11 shrink-0 text-center">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-ink-3">{formatWeekday(entry.entryDate)}</div>
        <div className="font-serif text-[28px] font-medium leading-8 text-ink">{dayOfMonth(entry.entryDate)}</div>
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-3">
          <h3 className="truncate font-serif text-lg font-medium text-ink group-hover:text-accent">
            {entry.title || <span className="text-ink-3">Untitled</span>}
          </h3>
          {match !== undefined && match !== null && (
            <span className="shrink-0 text-xs font-medium tabular-nums text-ink-3" title="How closely this entry matches your search">
              {Math.round(match * 100)}% match
            </span>
          )}
        </div>
        {match !== undefined && <p className="text-xs text-ink-3">{formatMediumDate(entry.entryDate)}</p>}
        <p className="mt-1 line-clamp-2 text-ink-2">{entry.excerpt}</p>
        {(entry.mood || entry.tags.length > 0) && (
          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <MoodBadge mood={entry.mood} />
            {entry.tags.map((tag) => (
              <Tag key={tag}>{tag}</Tag>
            ))}
          </div>
        )}
      </div>
    </Link>
  );
}

function ListSkeleton() {
  return (
    <div className="space-y-3" role="status" aria-label="Loading entries">
      {[0, 1, 2].map((item) => (
        <Card key={item} className="flex gap-5 p-5">
          <Skeleton className="h-12 w-11" />
          <div className="flex-1 space-y-2.5">
            <Skeleton className="h-5 w-2/5" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-3/4" />
          </div>
        </Card>
      ))}
    </div>
  );
}

/** Groups a date-sorted list into [{ month, entries }]. */
function groupByMonth(entries) {
  const groups = [];
  for (const entry of entries) {
    const month = entry.entryDate.slice(0, 7);
    const last = groups[groups.length - 1];
    if (last?.month === month) last.entries.push(entry);
    else groups.push({ month, label: formatMonth(entry.entryDate), entries: [entry] });
  }
  return groups;
}

export default function JournalPage() {
  const [text, setText] = useState('');
  const [mode, setMode] = useState('keyword'); // keyword | meaning
  const [tag, setTag] = useState(null);
  const [mood, setMood] = useState(null);
  const query = useDebounced(text.trim(), 300);

  const semantic = mode === 'meaning' && query.length >= 2;
  const filters = { q: mode === 'keyword' ? query : '', tag, mood };
  const filtered = Boolean(filters.q || tag || mood);

  const list = useInfiniteQuery({
    queryKey: ['entries', filters],
    queryFn: ({ pageParam, signal }) => api('/entries', { query: { ...filters, cursor: pageParam, limit: 20 }, signal }),
    initialPageParam: undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: !semantic,
    // Keep polling while something is still being embedded so its badge updates.
    refetchInterval: (state) =>
      state.state.data?.pages.some((page) => page.entries.some((entry) => entry.embeddingStatus === 'pending')) ? 2500 : false,
  });

  const search = useQuery({
    queryKey: ['entry-search', query],
    queryFn: ({ signal }) => api('/entries/search', { query: { q: query, limit: 10 }, signal }),
    enabled: semantic,
  });

  const tags = useQuery({ queryKey: ['tags'], queryFn: () => api('/entries/tags') });

  const entries = list.data?.pages.flatMap((page) => page.entries) ?? [];
  const groups = groupByMonth(entries);

  return (
    <>
      <PageHeader
        title="Journal"
        description="Everything you have written, newest first."
        actions={
          // Phones already have the compose button in the tab bar.
          <div className="hidden md:block">
            <ButtonLink to="/journal/new">
              <PenLine className="size-4" aria-hidden />
              New entry
            </ButtonLink>
          </div>
        }
      />

      {/* Search and filters */}
      <div className="mb-6 space-y-3">
        <div className="flex flex-col gap-2 sm:flex-row">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-ink-3" aria-hidden />
            <input
              type="search"
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder={mode === 'meaning' ? 'Describe what you are looking for…' : 'Search by words…'}
              aria-label="Search entries"
              className="h-11 w-full rounded-xl border border-line-strong bg-surface pl-10 pr-3.5 text-ink placeholder:text-ink-3 hover:border-ink-3 focus:border-accent focus:outline-2 focus:outline-offset-0 focus:outline-accent/25"
            />
          </div>
          <div className="flex h-11 shrink-0 rounded-xl border border-line-strong bg-surface p-1" role="group" aria-label="Search mode">
            {[
              { value: 'keyword', label: 'Words', title: 'Find entries containing these words' },
              { value: 'meaning', label: 'Meaning', title: 'Find entries about the same thing, even in different words (vector search)', Icon: Sparkles },
            ].map(({ value, label, title, Icon }) => (
              <button
                key={value}
                type="button"
                title={title}
                aria-pressed={mode === value}
                onClick={() => setMode(value)}
                className={cx(
                  'inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg px-3.5 text-[13px] font-medium transition-colors',
                  mode === value ? 'bg-accent-soft text-accent' : 'text-ink-2 hover:text-ink',
                )}
              >
                {Icon && <Icon className="size-3.5" aria-hidden />}
                {label}
              </button>
            ))}
          </div>
        </div>

        {!semantic && (
          <div className="flex flex-wrap items-center gap-1.5">
            {MOODS.map(({ value, label, Icon }) => (
              <Tag key={value} active={mood === value} onClick={() => setMood(mood === value ? null : value)}>
                <Icon className="mr-1 size-3.5" aria-hidden />
                {label}
              </Tag>
            ))}
            {tags.data?.tags.length > 0 && <span className="mx-1 h-4 w-px bg-line-strong" aria-hidden />}
            {tags.data?.tags.slice(0, 12).map((item) => (
              <Tag key={item.tag} active={tag === item.tag} onClick={() => setTag(tag === item.tag ? null : item.tag)}>
                {item.tag}
                <span className={cx('ml-1.5 tabular-nums', tag === item.tag ? 'opacity-80' : 'text-ink-3')}>{item.count}</span>
              </Tag>
            ))}
          </div>
        )}
      </div>

      {/* Semantic results */}
      {semantic && (
        <section aria-label="Search results">
          {search.isPending && <ListSkeleton />}
          {search.isError && <ErrorNote onRetry={search.refetch}>{search.error.message}</ErrorNote>}
          {search.data && search.data.results.length === 0 && (
            <EmptyState icon={SearchX} title="Nothing close to that">
              Try describing it another way, or switch to word search.
            </EmptyState>
          )}
          {search.data && search.data.results.length > 0 && (
            <>
              <p className="mb-3 text-sm text-ink-3">
                {search.data.results.length} closest {search.data.results.length === 1 ? 'entry' : 'entries'}, found in {search.data.tookMs} ms
              </p>
              <div className="space-y-3">
                {search.data.results.map((result) => (
                  <EntryCard key={result.id} entry={result} match={result.similarity} />
                ))}
              </div>
            </>
          )}
        </section>
      )}

      {/* Chronological list */}
      {!semantic && (
        <section aria-label="Entries">
          {list.isPending && <ListSkeleton />}
          {list.isError && <ErrorNote onRetry={list.refetch}>{list.error.message}</ErrorNote>}

          {list.isSuccess && entries.length === 0 && !filtered && (
            <EmptyState
              icon={BookOpen}
              title="Your journal is empty"
              action={
                <ButtonLink to="/journal/new">
                  <PenLine className="size-4" aria-hidden />
                  Write your first entry
                </ButtonLink>
              }
            >
              Write a few lines about today. The more you write, the more your assistant can help you look back.
            </EmptyState>
          )}
          {list.isSuccess && entries.length === 0 && filtered && (
            <EmptyState icon={SearchX} title="No entries match">
              Try different words or clear the filters.
            </EmptyState>
          )}

          <div className="space-y-8">
            {groups.map((group) => (
              <div key={group.month}>
                <h2 className="mb-3 text-[13px] font-semibold uppercase tracking-wider text-ink-3">{group.label}</h2>
                <div className="space-y-3">
                  {group.entries.map((entry) => (
                    <EntryCard key={entry.id} entry={entry} />
                  ))}
                </div>
              </div>
            ))}
          </div>

          {list.hasNextPage && (
            <div className="mt-6 flex justify-center">
              <Button variant="secondary" onClick={() => list.fetchNextPage()} disabled={list.isFetchingNextPage}>
                {list.isFetchingNextPage && <Spinner />}
                Show older entries
              </Button>
            </div>
          )}
        </section>
      )}
    </>
  );
}
