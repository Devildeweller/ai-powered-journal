import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Check, CircleAlert, ImagePlus, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { AutoTextarea, MoodPicker, TagInput } from '../components/entryFields.jsx';
import { Button, ConfirmDialog, ErrorNote, Skeleton, Spinner } from '../components/ui.jsx';
import { useToast } from '../context/ToastContext.jsx';
import { api, uploadToPresignedUrl } from '../lib/api.js';
import { formatLongDate, formatMediumDate, localToday } from '../lib/dates.js';

const blankForm = () => ({ title: '', content: '', mood: null, tags: [], entryDate: localToday() });
const toForm = (entry) => ({ title: entry.title, content: entry.content, mood: entry.mood, tags: entry.tags, entryDate: entry.entryDate });
const sameForm = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const countWords = (text) => (text.match(/\S+/g) ?? []).length;

/** Shows whether the entry is searchable by the assistant yet. */
function IndexStatus({ entry, onRetry }) {
  if (!entry) return null;
  if (entry.embeddingStatus === 'ready') {
    return (
      <span className="inline-flex items-center gap-1.5" title="This entry has been embedded and is searchable by meaning.">
        <Check className="size-3.5 text-success" aria-hidden />
        Searchable
      </span>
    );
  }
  if (entry.embeddingStatus === 'pending') {
    return (
      <span className="inline-flex items-center gap-1.5">
        <Spinner className="size-3.5" />
        Indexing…
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-danger" title={entry.embeddingError ?? undefined}>
      <CircleAlert className="size-3.5" aria-hidden />
      Indexing failed.
      <button type="button" onClick={onRetry} className="font-medium underline underline-offset-2">
        Retry
      </button>
    </span>
  );
}

function Attachments({ entry, limits }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const inputRef = useRef(null);
  const [uploading, setUploading] = useState(false);
  const attachments = entry.attachments ?? [];
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['entry', entry.id] });

  async function onFiles(event) {
    const files = [...event.target.files];
    event.target.value = '';
    if (files.length === 0) return;
    setUploading(true);
    try {
      for (const file of files) {
        if (file.size > limits.attachmentBytes) {
          toast.error(`${file.name} is larger than ${Math.round(limits.attachmentBytes / 1024 / 1024)} MB.`);
          continue;
        }
        // 1. reserve a slot and get a presigned URL  2. upload to S3  3. confirm
        const { attachment, uploadUrl, headers } = await api('/attachments', {
          method: 'POST',
          body: { entryId: entry.id, fileName: file.name, contentType: file.type, sizeBytes: file.size },
        });
        await uploadToPresignedUrl(uploadUrl, file, headers);
        await api(`/attachments/${attachment.id}/complete`, { method: 'POST' });
      }
      await refresh();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setUploading(false);
    }
  }

  const remove = useMutation({
    mutationFn: (id) => api(`/attachments/${id}`, { method: 'DELETE' }),
    onSuccess: refresh,
    onError: (error) => toast.error(error.message),
  });

  return (
    <section aria-label="Photos">
      <div className="flex flex-wrap gap-3">
        {attachments.map((attachment) => (
          <figure key={attachment.id} className="group relative size-28 overflow-hidden rounded-xl border border-line bg-sunken">
            <a href={attachment.url} target="_blank" rel="noreferrer">
              <img src={attachment.url} alt={attachment.fileName} loading="lazy" className="size-full object-cover" />
            </a>
            <button
              type="button"
              onClick={() => remove.mutate(attachment.id)}
              aria-label={`Remove ${attachment.fileName}`}
              className="absolute right-1.5 top-1.5 grid size-6 place-items-center rounded-full bg-black/60 text-white opacity-0 transition-opacity focus:opacity-100 group-hover:opacity-100"
            >
              <X className="size-3.5" />
            </button>
          </figure>
        ))}
        {attachments.length < limits.attachmentsPerEntry && (
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            disabled={uploading}
            className="grid size-28 place-items-center rounded-xl border border-dashed border-line-strong text-ink-3 transition-colors hover:border-accent hover:text-accent disabled:opacity-60"
          >
            <span className="flex flex-col items-center gap-1.5 text-xs font-medium">
              {uploading ? <Spinner className="size-5" /> : <ImagePlus className="size-5" aria-hidden />}
              {uploading ? 'Uploading…' : 'Add photo'}
            </span>
          </button>
        )}
      </div>
      <input ref={inputRef} type="file" accept="image/jpeg,image/png,image/webp,image/gif" multiple hidden onChange={onFiles} />
    </section>
  );
}

function RelatedEntries({ entryId }) {
  const related = useQuery({
    queryKey: ['related', entryId],
    queryFn: () => api(`/entries/${entryId}/related`),
  });
  if (!related.data?.related.length) return null;

  return (
    <section className="mt-12 border-t border-line pt-8" aria-labelledby="related-heading">
      <h2 id="related-heading" className="text-[13px] font-semibold uppercase tracking-wider text-ink-3">
        Related entries
      </h2>
      <p className="mt-1 text-sm text-ink-3">Other days when you wrote about similar things.</p>
      <ul className="mt-4 grid gap-3 sm:grid-cols-2">
        {related.data.related.map((item) => (
          <li key={item.id}>
            <Link
              to={`/journal/${item.id}`}
              className="block h-full rounded-xl border border-line bg-surface p-4 transition-colors hover:border-line-strong"
            >
              <p className="text-xs text-ink-3">{formatMediumDate(item.entryDate)}</p>
              <p className="mt-0.5 truncate font-serif text-base font-medium text-ink">{item.title || 'Untitled'}</p>
              <p className="mt-1 line-clamp-2 text-sm text-ink-2">{item.excerpt}</p>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

export default function EntryPage() {
  const { id } = useParams();
  const isNew = !id;
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();

  const [form, setForm] = useState(blankForm);
  const [saved, setSaved] = useState(blankForm);
  const [loadedId, setLoadedId] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState('');

  const entryQuery = useQuery({
    queryKey: ['entry', id],
    queryFn: () => api(`/entries/${id}`).then((data) => data.entry),
    enabled: !isNew,
    // Poll while the entry is being embedded so the status line updates.
    refetchInterval: (query) => (query.state.data?.embeddingStatus === 'pending' ? 1500 : false),
  });
  const entry = entryQuery.data;

  const config = useQuery({ queryKey: ['config'], queryFn: () => api('/config'), staleTime: Infinity });
  const tags = useQuery({ queryKey: ['tags'], queryFn: () => api('/entries/tags') });

  // Fill the form once per entry.  Later refetches (status polling) must not
  // overwrite what the user is typing.
  useEffect(() => {
    if (entry && loadedId !== entry.id) {
      setForm(toForm(entry));
      setSaved(toForm(entry));
      setLoadedId(entry.id);
    }
  }, [entry, loadedId]);

  const dirty = !sameForm(form, saved);
  const canSave = form.content.trim().length > 0 && (isNew || dirty);

  const save = useMutation({
    mutationFn: () =>
      isNew ? api('/entries', { method: 'POST', body: form }) : api(`/entries/${id}`, { method: 'PATCH', body: form }),
    onSuccess: ({ entry: result }) => {
      setError('');
      setSaved(toForm(result));
      setForm(toForm(result));
      setLoadedId(result.id);
      queryClient.setQueryData(['entry', result.id], (previous) => ({ ...previous, ...result }));
      queryClient.invalidateQueries({ queryKey: ['entries'] });
      queryClient.invalidateQueries({ queryKey: ['tags'] });
      queryClient.invalidateQueries({ queryKey: ['insights'] });
      queryClient.invalidateQueries({ queryKey: ['related', result.id] });
      toast.success(isNew ? 'Entry saved' : 'Changes saved');
      if (isNew) navigate(`/journal/${result.id}`, { replace: true });
    },
    onError: (failure) => setError(failure.details?.[0]?.message ?? failure.message),
  });

  const remove = useMutation({
    mutationFn: () => api(`/entries/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: ['entry', id] });
      queryClient.invalidateQueries({ queryKey: ['entries'] });
      queryClient.invalidateQueries({ queryKey: ['tags'] });
      queryClient.invalidateQueries({ queryKey: ['insights'] });
      toast.success('Entry deleted');
      navigate('/journal', { replace: true });
    },
    onError: (failure) => {
      setConfirmDelete(false);
      toast.error(failure.message);
    },
  });

  const reindex = useMutation({
    mutationFn: () => api(`/entries/${id}/reindex`, { method: 'POST' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['entry', id] }),
  });

  const trySave = useCallback(() => {
    if (canSave && !save.isPending) save.mutate();
  }, [canSave, save]);

  // Ctrl/Cmd+S saves; the browser warns before closing a tab with unsaved text.
  useEffect(() => {
    const onKeyDown = (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        trySave();
      }
    };
    const onBeforeUnload = (event) => {
      if (dirty) event.preventDefault();
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('beforeunload', onBeforeUnload);
    };
  }, [trySave, dirty]);

  const set = (field) => (value) => setForm((current) => ({ ...current, [field]: value }));

  if (!isNew && entryQuery.isError) {
    return (
      <div className="space-y-4">
        <BackLink />
        <ErrorNote onRetry={entryQuery.error.status === 404 ? undefined : entryQuery.refetch}>
          {entryQuery.error.status === 404 || entryQuery.error.status === 422 ? 'This entry does not exist or was deleted.' : entryQuery.error.message}
        </ErrorNote>
      </div>
    );
  }

  const loading = !isNew && loadedId !== id;

  return (
    <article className="mx-auto max-w-2xl">
      <div className="mb-6 flex items-center justify-between gap-3">
        <BackLink />
        <div className="flex items-center gap-2">
          {!isNew && (
            <Button variant="dangerGhost" size="icon" onClick={() => setConfirmDelete(true)} aria-label="Delete entry" title="Delete entry">
              <Trash2 className="size-[18px]" />
            </Button>
          )}
          <Button onClick={trySave} disabled={!canSave} loading={save.isPending} title="Save (Ctrl+S)">
            {isNew ? 'Save entry' : dirty ? 'Save changes' : 'Saved'}
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="space-y-4" role="status" aria-label="Loading entry">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-10 w-3/4" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      ) : (
        <>
          {error && (
            <div className="mb-4">
              <ErrorNote>{error}</ErrorNote>
            </div>
          )}

          <label className="group relative inline-flex cursor-pointer items-center text-sm font-medium text-ink-2 hover:text-accent">
            <span>{formatLongDate(form.entryDate)}</span>
            {/* The native date input sits invisibly over the label so clicking it opens the picker. */}
            <input
              type="date"
              value={form.entryDate}
              max="2100-12-31"
              onChange={(event) => event.target.value && set('entryDate')(event.target.value)}
              onClick={(event) => event.currentTarget.showPicker?.()}
              aria-label="Entry date"
              className="absolute inset-0 cursor-pointer opacity-0"
            />
          </label>

          <input
            value={form.title}
            onChange={(event) => set('title')(event.target.value)}
            placeholder="Title"
            maxLength={200}
            aria-label="Title"
            className="mt-2 w-full bg-transparent font-serif text-[32px] font-medium leading-tight tracking-tight text-ink outline-none placeholder:text-ink-3/70"
          />

          <AutoTextarea
            value={form.content}
            onChange={(event) => set('content')(event.target.value)}
            placeholder="What is on your mind today?"
            aria-label="Entry"
            autoFocus={isNew}
            minRows={isNew ? 10 : 4}
            maxLength={50000}
            className="mt-4 w-full bg-transparent font-serif text-[19px] leading-[1.75] text-ink outline-none placeholder:text-ink-3/70"
          />

          <div className="mt-8 space-y-5 border-t border-line pt-6">
            <div>
              <p className="mb-2 text-[13px] font-medium text-ink-2">How did the day feel?</p>
              <MoodPicker value={form.mood} onChange={set('mood')} />
            </div>
            <div>
              <p className="mb-2 text-[13px] font-medium text-ink-2">Tags</p>
              <TagInput value={form.tags} onChange={set('tags')} suggestions={tags.data?.tags.map((item) => item.tag) ?? []} />
            </div>
            {!isNew && entry && config.data?.features.attachments && (
              <div>
                <p className="mb-2 text-[13px] font-medium text-ink-2">Photos</p>
                <Attachments entry={entry} limits={config.data.limits} />
              </div>
            )}
          </div>

          <footer className="mt-6 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-ink-3">
            <span className="tabular-nums">
              {countWords(form.content)} {countWords(form.content) === 1 ? 'word' : 'words'}
            </span>
            {!isNew && !dirty && <IndexStatus entry={entry} onRetry={() => reindex.mutate()} />}
            {dirty && !isNew && <span>Unsaved changes</span>}
          </footer>

          {!isNew && entry?.embeddingStatus === 'ready' && <RelatedEntries entryId={id} />}
        </>
      )}

      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={() => remove.mutate()}
        loading={remove.isPending}
        title="Delete this entry?"
        confirmLabel="Delete entry"
      >
        The entry and its photos will be removed permanently. This cannot be undone.
      </ConfirmDialog>
    </article>
  );
}

function BackLink() {
  return (
    <Link to="/journal" className="-ml-2 inline-flex h-9 items-center gap-1.5 rounded-lg px-2 text-sm font-medium text-ink-2 hover:bg-sunken hover:text-ink">
      <ArrowLeft className="size-4" aria-hidden />
      Journal
    </Link>
  );
}
