import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BookOpen, Brain, MessageCircle, Pencil, Plus, Trash2, UserRound } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { AutoTextarea } from '../components/entryFields.jsx';
import { Button, Card, ConfirmDialog, EmptyState, ErrorNote, PageHeader, Select, Skeleton, cx } from '../components/ui.jsx';
import { useToast } from '../context/ToastContext.jsx';
import { api } from '../lib/api.js';
import { formatTimeAgo } from '../lib/dates.js';
import { MEMORY_CATEGORIES } from '../lib/moods.js';

const IMPORTANCE = [
  { value: 1, label: 'Minor detail' },
  { value: 2, label: 'Nice to know' },
  { value: 3, label: 'Useful' },
  { value: 4, label: 'Important' },
  { value: 5, label: 'Core (always remembered)' },
];

/** Importance as five pips with a text equivalent. */
function Importance({ value }) {
  return (
    <span className="inline-flex items-center gap-0.5" title={IMPORTANCE[value - 1].label} aria-label={`Importance ${value} of 5`}>
      {[1, 2, 3, 4, 5].map((step) => (
        <span key={step} className={cx('size-1.5 rounded-full', step <= value ? 'bg-accent' : 'bg-line-strong')} />
      ))}
    </span>
  );
}

function MemoryForm({ initial, onSubmit, onCancel, saving, submitLabel }) {
  const [form, setForm] = useState(initial);
  const valid = form.content.trim().length >= 3;
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (valid) onSubmit({ ...form, content: form.content.trim() });
      }}
      className="space-y-3"
    >
      <AutoTextarea
        value={form.content}
        onChange={(event) => setForm({ ...form, content: event.target.value })}
        placeholder="For example: My sister Priya lives in Pune and visits every August."
        aria-label="Memory"
        autoFocus
        minRows={2}
        maxLength={600}
        className="w-full rounded-xl border border-line-strong bg-surface px-3.5 py-2.5 text-ink placeholder:text-ink-3 focus:border-accent focus:outline-2 focus:outline-offset-0 focus:outline-accent/25"
      />
      <div className="flex flex-wrap items-center gap-2">
        <Select value={form.category} onChange={(event) => setForm({ ...form, category: event.target.value })} aria-label="Category" className="w-auto">
          {MEMORY_CATEGORIES.map((category) => (
            <option key={category.value} value={category.value}>
              {category.label}
            </option>
          ))}
        </Select>
        <Select
          value={form.importance}
          onChange={(event) => setForm({ ...form, importance: Number(event.target.value) })}
          aria-label="Importance"
          className="w-auto"
        >
          {IMPORTANCE.map((level) => (
            <option key={level.value} value={level.value}>
              {level.label}
            </option>
          ))}
        </Select>
        <div className="ml-auto flex gap-2">
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" disabled={!valid} loading={saving}>
            {submitLabel}
          </Button>
        </div>
      </div>
    </form>
  );
}

const SOURCE_META = {
  chat: { Icon: MessageCircle, label: 'Learned in a conversation' },
  entry: { Icon: BookOpen, label: 'Learned from an entry' },
  manual: { Icon: UserRound, label: 'Added by you' },
};

function MemoryRow({ memory, onEdit, onDelete }) {
  const source = SOURCE_META[memory.sourceType] ?? SOURCE_META.manual;
  const sourceLink =
    memory.sourceType === 'entry' && memory.sourceEntryId
      ? `/journal/${memory.sourceEntryId}`
      : memory.sourceType === 'chat' && memory.sourceConversationId
        ? `/chat/${memory.sourceConversationId}`
        : null;

  return (
    <li className="group flex gap-3 px-4 py-3.5 md:px-5">
      <div className="min-w-0 flex-1">
        <p className="text-ink">{memory.content}</p>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-3">
          <Importance value={memory.importance} />
          <span className="inline-flex items-center gap-1">
            <source.Icon className="size-3.5" aria-hidden />
            {sourceLink ? (
              <Link to={sourceLink} className="hover:text-accent hover:underline">
                {source.label}
              </Link>
            ) : (
              source.label
            )}
          </span>
          <span>Updated {formatTimeAgo(memory.updatedAt)}</span>
        </div>
      </div>
      <div className="flex shrink-0 items-start gap-0.5 opacity-100 transition-opacity md:opacity-0 md:focus-within:opacity-100 md:group-hover:opacity-100">
        <Button variant="ghost" size="icon" onClick={onEdit} aria-label="Edit memory" title="Edit">
          <Pencil className="size-4" />
        </Button>
        <Button variant="dangerGhost" size="icon" onClick={onDelete} aria-label="Delete memory" title="Delete">
          <Trash2 className="size-4" />
        </Button>
      </div>
    </li>
  );
}

export default function MemoriesPage() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [pendingDelete, setPendingDelete] = useState(null);

  const memories = useQuery({ queryKey: ['memories'], queryFn: () => api('/memories') });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['memories'] });
  const onError = (error) => toast.error(error.details?.[0]?.message ?? error.message);

  const create = useMutation({
    mutationFn: (body) => api('/memories', { method: 'POST', body }),
    onSuccess: () => {
      setAdding(false);
      refresh();
      toast.success('Memory added');
    },
    onError,
  });
  const update = useMutation({
    mutationFn: ({ id, ...body }) => api(`/memories/${id}`, { method: 'PATCH', body }),
    onSuccess: () => {
      setEditingId(null);
      refresh();
      toast.success('Memory updated');
    },
    onError,
  });
  const remove = useMutation({
    mutationFn: (id) => api(`/memories/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      setPendingDelete(null);
      refresh();
      toast.success('Memory forgotten');
    },
    onError: (error) => {
      setPendingDelete(null);
      onError(error);
    },
  });

  const all = memories.data?.memories ?? [];
  const groups = MEMORY_CATEGORIES.map((category) => ({
    ...category,
    items: all.filter((memory) => memory.category === category.value),
  })).filter((group) => group.items.length > 0);

  return (
    <>
      <PageHeader
        title="Memory"
        description="What Inkwell has learned about you. It brings these into every conversation, and you can correct or remove any of them."
        actions={
          !adding && (
            <Button onClick={() => setAdding(true)}>
              <Plus className="size-4" aria-hidden />
              Add memory
            </Button>
          )
        }
      />

      {adding && (
        <Card className="mb-6 animate-rise p-4 md:p-5">
          <MemoryForm
            initial={{ content: '', category: 'other', importance: 3 }}
            onSubmit={(form) => create.mutate(form)}
            onCancel={() => setAdding(false)}
            saving={create.isPending}
            submitLabel="Remember this"
          />
        </Card>
      )}

      {memories.isPending && (
        <Card className="space-y-4 p-5" role="status" aria-label="Loading memories">
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-4 w-2/3" />
        </Card>
      )}
      {memories.isError && <ErrorNote onRetry={memories.refetch}>{memories.error.message}</ErrorNote>}

      {memories.isSuccess && all.length === 0 && !adding && (
        <EmptyState icon={Brain} title="Nothing remembered yet">
          As you write entries and talk with the assistant, it will note the people, goals and patterns that matter, and list them here.
        </EmptyState>
      )}

      <div className="space-y-6">
        {groups.map((group) => (
          <section key={group.value} aria-labelledby={`memory-group-${group.value}`}>
            <h2 id={`memory-group-${group.value}`} className="mb-2 text-[13px] font-semibold uppercase tracking-wider text-ink-3">
              {group.label}
            </h2>
            <Card as="ul" className="divide-y divide-line">
              {group.items.map((memory) =>
                editingId === memory.id ? (
                  <li key={memory.id} className="p-4 md:p-5">
                    <MemoryForm
                      initial={{ content: memory.content, category: memory.category, importance: memory.importance }}
                      onSubmit={(form) => update.mutate({ id: memory.id, ...form })}
                      onCancel={() => setEditingId(null)}
                      saving={update.isPending}
                      submitLabel="Save"
                    />
                  </li>
                ) : (
                  <MemoryRow key={memory.id} memory={memory} onEdit={() => setEditingId(memory.id)} onDelete={() => setPendingDelete(memory)} />
                ),
              )}
            </Card>
          </section>
        ))}
      </div>

      <ConfirmDialog
        open={Boolean(pendingDelete)}
        onClose={() => setPendingDelete(null)}
        onConfirm={() => remove.mutate(pendingDelete.id)}
        loading={remove.isPending}
        title="Forget this memory?"
        confirmLabel="Forget"
      >
        “{pendingDelete?.content}” will no longer be used in conversations. Your journal entries are not affected.
      </ConfirmDialog>
    </>
  );
}
