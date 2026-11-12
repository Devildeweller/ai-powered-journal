import { useQuery } from '@tanstack/react-query';
import { ChartNoAxesColumn, PenLine } from 'lucide-react';
import { ActivityHeatmap, BarList, MoodChart, MoodColumns } from '../components/charts.jsx';
import { ButtonLink, Card, EmptyState, ErrorNote, PageHeader, Skeleton } from '../components/ui.jsx';
import { api } from '../lib/api.js';
import { formatMediumDate, localToday } from '../lib/dates.js';
import { moodFor } from '../lib/moods.js';

const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
const formatCount = (value) => (value >= 10_000 ? compact.format(value) : value.toLocaleString());

function StatTile({ label, value, detail }) {
  return (
    <Card className="p-4 md:p-5">
      <p className="text-[13px] text-ink-2">{label}</p>
      <p className="mt-1 text-[28px] font-semibold leading-9 tracking-tight text-ink">{value}</p>
      {detail && <p className="mt-0.5 text-xs text-ink-3">{detail}</p>}
    </Card>
  );
}

function Panel({ title, description, children, className }) {
  return (
    <Card as="section" className={`p-4 md:p-6 ${className ?? ''}`}>
      <h2 className="font-serif text-lg font-medium text-ink">{title}</h2>
      {description && <p className="mt-0.5 text-sm text-ink-3">{description}</p>}
      <div className="mt-5">{children}</div>
    </Card>
  );
}

export default function InsightsPage() {
  const today = localToday();
  const insights = useQuery({
    queryKey: ['insights', today],
    queryFn: () => api('/insights', { query: { today } }),
  });

  const data = insights.data;

  return (
    <>
      <PageHeader title="Insights" description="How your writing and mood have moved over the last four months." />

      {insights.isPending && (
        <div className="space-y-4" role="status" aria-label="Loading insights">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {[0, 1, 2, 3].map((item) => (
              <Skeleton key={item} className="h-24 rounded-2xl" />
            ))}
          </div>
          <Skeleton className="h-64 rounded-2xl" />
        </div>
      )}
      {insights.isError && <ErrorNote onRetry={insights.refetch}>{insights.error.message}</ErrorNote>}

      {data && data.totals.entries === 0 && (
        <EmptyState
          icon={ChartNoAxesColumn}
          title="Nothing to chart yet"
          action={
            <ButtonLink to="/journal/new">
              <PenLine className="size-4" aria-hidden />
              Write an entry
            </ButtonLink>
          }
        >
          Once you have a few entries, your streaks, moods and most-used tags will appear here.
        </EmptyState>
      )}

      {data && data.totals.entries > 0 && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatTile
              label="Entries"
              value={formatCount(data.totals.entries)}
              detail={data.totals.firstEntryDate ? `Since ${formatMediumDate(data.totals.firstEntryDate)}` : undefined}
            />
            <StatTile label="Words written" value={formatCount(data.totals.words)} detail={`About ${Math.round(data.totals.words / data.totals.entries)} per entry`} />
            <StatTile
              label="Current streak"
              value={`${data.streak.current} ${data.streak.current === 1 ? 'day' : 'days'}`}
              detail={`Longest: ${data.streak.longest} ${data.streak.longest === 1 ? 'day' : 'days'}`}
            />
            <StatTile
              label="Average mood"
              value={data.totals.averageMood ? data.totals.averageMood.toFixed(1) : '–'}
              detail={data.totals.averageMood ? `${moodFor(Math.round(data.totals.averageMood)).label}, on a scale of 1 to 5` : 'No moods recorded'}
            />
          </div>

          <Panel title="Mood over time" description={`Average mood per day, ${formatMediumDate(data.since)} to ${formatMediumDate(data.today)}.`}>
            <MoodChart daily={data.daily} since={data.since} today={data.today} />
          </Panel>

          <Panel title="Writing activity" description="Words written each day.">
            <ActivityHeatmap daily={data.daily} since={data.since} today={data.today} />
          </Panel>

          <div className="grid gap-4 md:grid-cols-2">
            <Panel title="Most used tags" description="Number of entries carrying each tag.">
              {data.topTags.length > 0 ? (
                <BarList
                  unit="entries"
                  items={data.topTags.map((tag) => ({
                    label: tag.tag,
                    value: tag.count,
                    detail: tag.mood ? `Average mood ${tag.mood.toFixed(1)} of 5` : undefined,
                  }))}
                />
              ) : (
                <p className="py-6 text-center text-sm text-ink-3">Tag your entries to see what you write about most.</p>
              )}
            </Panel>
            <Panel title="Entries by mood" description="How often each mood was recorded.">
              <MoodColumns distribution={data.moodDistribution} />
            </Panel>
          </div>
        </div>
      )}
    </>
  );
}
