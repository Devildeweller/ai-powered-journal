import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowUp, BookOpen, Brain, ChevronDown, History, MessageCircle, Plus, Square, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { AutoTextarea } from '../components/entryFields.jsx';
import { Button, ConfirmDialog, ErrorNote, Spinner, cx } from '../components/ui.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { useToast } from '../context/ToastContext.jsx';
import { api, streamChat } from '../lib/api.js';
import { formatMediumDate, formatTimeAgo, localToday } from '../lib/dates.js';
import { categoryLabel } from '../lib/moods.js';

const SUGGESTIONS = [
  'How has my mood been over the past two weeks?',
  'What have I been worried about lately?',
  'What patterns do you notice in how I write about work?',
  'Summarise what happened last month.',
];

const STAGE_LABEL = { retrieving: 'Searching your journal…', generating: 'Thinking…' };

// ------------------------------------------------------------ message views --

/**
 * Renders an answer as Markdown.  Citation markers like [2] become links to
 * the journal entry that retrieval numbered 2 for this answer.
 */
function AnswerBody({ content, sources, streaming }) {
  const entryByNumber = useMemo(() => new Map((sources?.entries ?? []).map((entry) => [String(entry.number), entry])), [sources]);

  // Handles single markers "[2]" and combined ones "[2, 4]".
  const markdown = useMemo(
    () =>
      content.replace(/\[(\d{1,2}(?:\s*,\s*\d{1,2})*)\]/g, (marker, list) => {
        const numbers = list.split(',').map((item) => item.trim());
        if (!numbers.every((number) => entryByNumber.has(number))) return marker;
        return numbers.map((number) => `[${number}](#cite-${number})`).join('');
      }),
    [content, entryByNumber],
  );

  const components = useMemo(
    () => ({
      a({ href, children }) {
        if (href?.startsWith('#cite-')) {
          const entry = entryByNumber.get(href.slice(6));
          if (entry) {
            return (
              <Link
                to={`/journal/${entry.entryId}`}
                title={`${formatMediumDate(entry.entryDate)}${entry.title ? ` · ${entry.title}` : ''}`}
                className="mx-0.5 inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-md bg-accent-soft px-1 align-[1px] text-[11px] font-semibold !text-accent !no-underline hover:bg-accent hover:!text-on-accent"
              >
                {children}
              </Link>
            );
          }
        }
        return (
          <a href={href} target="_blank" rel="noreferrer">
            {children}
          </a>
        );
      },
    }),
    [entryByNumber],
  );

  return (
    <div className="prose-ink">
      <Markdown components={components}>{markdown}</Markdown>
      {streaming && <span className="ml-0.5 inline-block h-4 w-[2px] translate-y-0.5 animate-blink bg-ink-2" aria-hidden />}
    </div>
  );
}

/** Collapsible list of what retrieval gave the model for this answer. */
function Sources({ sources }) {
  const entries = sources?.entries ?? [];
  const memories = sources?.memories ?? [];
  if (entries.length === 0 && memories.length === 0) return null;

  const parts = [];
  if (entries.length) parts.push(`${entries.length} ${entries.length === 1 ? 'entry' : 'entries'}`);
  if (memories.length) parts.push(`${memories.length} ${memories.length === 1 ? 'memory' : 'memories'}`);

  return (
    <details className="group mt-3">
      <summary className="inline-flex list-none items-center gap-1.5 rounded-lg py-1 text-[13px] font-medium text-ink-3 hover:text-ink-2 [&::-webkit-details-marker]:hidden">
        <ChevronDown className="size-3.5 transition-transform group-open:rotate-180" aria-hidden />
        Based on {parts.join(' and ')}
        {sources.range && <span className="font-normal">from {sources.range.label}</span>}
      </summary>
      <div className="mt-2 space-y-4 rounded-xl border border-line bg-surface p-3.5">
        {entries.length > 0 && (
          <div>
            <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-ink-3">
              <BookOpen className="size-3.5" aria-hidden />
              Journal entries
            </p>
            <ol className="space-y-1">
              {entries.map((entry) => (
                <li key={entry.entryId}>
                  <Link to={`/journal/${entry.entryId}`} className="flex gap-2.5 rounded-lg p-1.5 hover:bg-sunken">
                    <span className="mt-0.5 grid h-[18px] min-w-[18px] shrink-0 place-items-center rounded-md bg-accent-soft px-1 text-[11px] font-semibold text-accent">
                      {entry.number}
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium text-ink">
                        {entry.title || 'Untitled'} <span className="font-normal text-ink-3">· {formatMediumDate(entry.entryDate)}</span>
                      </span>
                      <span className="line-clamp-1 text-[13px] text-ink-2">{entry.excerpt}</span>
                    </span>
                  </Link>
                </li>
              ))}
            </ol>
          </div>
        )}
        {memories.length > 0 && (
          <div>
            <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-ink-3">
              <Brain className="size-3.5" aria-hidden />
              Long-term memory
            </p>
            <ul className="space-y-1.5 pl-1.5">
              {memories.map((memory) => (
                <li key={memory.id} className="text-[13px] text-ink-2">
                  <span className="mr-1.5 font-medium text-ink-3">{categoryLabel(memory.category)}</span>
                  {memory.content}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </details>
  );
}

function UserBubble({ children }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-accent-soft px-4 py-2.5 text-[15.5px] leading-relaxed text-ink [overflow-wrap:anywhere]">
        {children}
      </div>
    </div>
  );
}

function AssistantMessage({ content, sources, streaming = false, interrupted = false }) {
  return (
    <div>
      <AnswerBody content={content} sources={sources} streaming={streaming} />
      {interrupted && <p className="mt-1 text-xs text-ink-3">Stopped early.</p>}
      {!streaming && <Sources sources={sources} />}
    </div>
  );
}

// ------------------------------------------------------- conversation list --

function ConversationList({ activeId, onNavigate }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const [pendingDelete, setPendingDelete] = useState(null);

  const conversations = useQuery({ queryKey: ['conversations'], queryFn: () => api('/conversations') });

  const remove = useMutation({
    mutationFn: (id) => api(`/conversations/${id}`, { method: 'DELETE' }),
    onSuccess: (_data, id) => {
      queryClient.invalidateQueries({ queryKey: ['conversations'] });
      queryClient.removeQueries({ queryKey: ['conversation', id] });
      setPendingDelete(null);
      if (id === activeId) navigate('/chat', { replace: true });
    },
    onError: (error) => {
      setPendingDelete(null);
      toast.error(error.message);
    },
  });

  return (
    <div className="flex h-full flex-col">
      <div className="p-3">
        <Link
          to="/chat"
          onClick={onNavigate}
          className="flex h-10 items-center justify-center gap-2 rounded-xl border border-line-strong bg-surface text-sm font-medium text-ink transition-colors hover:bg-sunken"
        >
          <Plus className="size-4" aria-hidden />
          New conversation
        </Link>
      </div>
      <nav className="scroll-quiet flex-1 overflow-y-auto px-3 pb-3" aria-label="Conversations">
        {conversations.isPending && (
          <div className="grid place-items-center py-8 text-ink-3">
            <Spinner />
          </div>
        )}
        {conversations.data?.conversations.length === 0 && <p className="px-2 py-6 text-center text-sm text-ink-3">No conversations yet.</p>}
        <ul className="space-y-0.5">
          {conversations.data?.conversations.map((conversation) => (
            <li key={conversation.id} className="group relative">
              <Link
                to={`/chat/${conversation.id}`}
                onClick={onNavigate}
                aria-current={conversation.id === activeId ? 'page' : undefined}
                className={cx(
                  'block rounded-xl py-2 pl-3 pr-9 transition-colors',
                  conversation.id === activeId ? 'bg-accent-soft' : 'hover:bg-sunken',
                )}
              >
                <span className={cx('block truncate text-sm font-medium', conversation.id === activeId ? 'text-accent' : 'text-ink')}>
                  {conversation.title}
                </span>
                <span className="block text-xs text-ink-3">{formatTimeAgo(conversation.updatedAt)}</span>
              </Link>
              <button
                type="button"
                onClick={() => setPendingDelete(conversation)}
                aria-label={`Delete conversation: ${conversation.title}`}
                className="absolute right-1.5 top-1/2 grid size-7 -translate-y-1/2 place-items-center rounded-lg text-ink-3 opacity-0 hover:bg-danger-soft hover:text-danger focus:opacity-100 group-hover:opacity-100"
              >
                <Trash2 className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
      </nav>

      <ConfirmDialog
        open={Boolean(pendingDelete)}
        onClose={() => setPendingDelete(null)}
        onConfirm={() => remove.mutate(pendingDelete.id)}
        loading={remove.isPending}
        title="Delete this conversation?"
        confirmLabel="Delete conversation"
      >
        “{pendingDelete?.title}” will be removed. Memories saved from it are kept.
      </ConfirmDialog>
    </div>
  );
}

// -------------------------------------------------------------------- page --

export default function ChatPage() {
  const { id } = useParams();
  const { user } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [draft, setDraft] = useState('');
  // The exchange currently in flight: { userText, userMessageId, stage, sources, text, error }.
  const [live, setLive] = useState(null);
  const [historyOpen, setHistoryOpen] = useState(false);

  const abortRef = useRef(null);
  const ownNavigationRef = useRef(null);
  const scrollRef = useRef(null);
  const stickToBottomRef = useRef(true);
  const composerRef = useRef(null);

  const conversation = useQuery({
    queryKey: ['conversation', id],
    queryFn: () => api(`/conversations/${id}`),
    enabled: Boolean(id),
  });
  const config = useQuery({ queryKey: ['config'], queryFn: () => api('/config'), staleTime: Infinity });

  // Leaving a conversation (other than the app's own redirect to a freshly
  // created one) cancels the answer in flight; the server keeps what it wrote.
  useEffect(() => {
    if (ownNavigationRef.current === id) {
      ownNavigationRef.current = null;
      return;
    }
    abortRef.current?.abort();
    setLive(null);
    stickToBottomRef.current = true;
    // Focus the composer on desktop; on touch devices that would pop the keyboard open.
    if (window.matchMedia('(pointer: fine)').matches) composerRef.current?.focus();
  }, [id]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const messages = conversation.data?.messages ?? [];
  const busy = Boolean(live && !live.error);

  // Follow the answer as it streams, unless the reader has scrolled up.
  useEffect(() => {
    const element = scrollRef.current;
    if (element && stickToBottomRef.current) element.scrollTop = element.scrollHeight;
  }, [messages.length, live?.text, live?.stage, live?.error]);

  const onScroll = () => {
    const element = scrollRef.current;
    stickToBottomRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
  };

  const send = useCallback(
    async (text) => {
      const message = text.trim();
      if (!message || abortRef.current) return;

      const controller = new AbortController();
      abortRef.current = controller;
      stickToBottomRef.current = true;
      setDraft('');
      setLive({ userText: message, userMessageId: null, stage: 'retrieving', sources: null, text: '', error: null });

      let conversationId = id;
      let userMessage = null;

      const appendToCache = (...items) => {
        queryClient.setQueryData(['conversation', conversationId], (previous) => {
          if (!previous) return previous;
          const known = new Set(previous.messages.map((item) => item.id));
          return { ...previous, messages: [...previous.messages, ...items.filter((item) => item && !known.has(item.id))] };
        });
      };

      try {
        await streamChat({
          message,
          conversationId: id,
          today: localToday(),
          signal: controller.signal,
          onEvent(event, data) {
            if (event === 'conversation') {
              conversationId = data.conversation.id;
              userMessage = data.userMessage;
              setLive((current) => current && { ...current, userMessageId: data.userMessage.id });
              if (data.isNew) {
                // Seed the cache so the new URL renders immediately, then move to it.
                queryClient.setQueryData(['conversation', conversationId], { conversation: data.conversation, messages: [data.userMessage] });
                ownNavigationRef.current = conversationId;
                navigate(`/chat/${conversationId}`, { replace: true });
              }
              queryClient.invalidateQueries({ queryKey: ['conversations'] });
            } else if (event === 'status') {
              setLive((current) => current && { ...current, stage: data.stage });
            } else if (event === 'sources') {
              setLive((current) => current && { ...current, sources: data });
            } else if (event === 'delta') {
              setLive((current) => current && { ...current, stage: 'writing', text: current.text + data.text });
            } else if (event === 'done') {
              appendToCache(userMessage, data.message);
              setLive(null);
              // Memory extraction runs after the answer; refresh the memory list shortly after.
              setTimeout(() => queryClient.invalidateQueries({ queryKey: ['memories'] }), 4000);
            } else if (event === 'error') {
              appendToCache(userMessage);
              setLive((current) => current && { ...current, error: data.message });
            }
          },
        });
        // The stream ended without "done" or "error": treat it as a dropped connection.
        setLive((current) => (current && !current.error ? { ...current, error: 'The connection was interrupted. Please try again.' } : current));
      } catch (error) {
        if (error.name === 'AbortError') {
          // Stopped by the user: the server stored the partial answer, so reload it.
          setLive(null);
          if (conversationId) queryClient.invalidateQueries({ queryKey: ['conversation', conversationId] });
        } else {
          setLive((current) => current && { ...current, error: error.message });
        }
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
        queryClient.invalidateQueries({ queryKey: ['conversations'] });
      }
    },
    [id, navigate, queryClient],
  );

  const stop = () => abortRef.current?.abort();

  const retry = () => {
    const text = live?.userText;
    setLive(null);
    if (text) setDraft(text);
    composerRef.current?.focus();
  };

  const onSubmit = (event) => {
    event.preventDefault();
    send(draft);
  };

  // The in-flight user message may already be in the cached list (after the
  // redirect to a new conversation); do not show it twice.
  const liveUserShown = live?.userMessageId && messages.some((message) => message.id === live.userMessageId);
  const isEmpty = !id && !live;
  const notFound = conversation.isError && (conversation.error.status === 404 || conversation.error.status === 422);

  return (
    <div className="flex h-[calc(100dvh-7rem-env(safe-area-inset-bottom))] md:h-dvh">
      {/* Conversation history: a column on large screens, a drawer otherwise */}
      <aside className="hidden w-72 shrink-0 border-r border-line bg-surface/60 lg:block">
        <ConversationList activeId={id} />
      </aside>
      {historyOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <button type="button" className="absolute inset-0 bg-black/40" aria-label="Close conversation list" onClick={() => setHistoryOpen(false)} />
          <div className="absolute inset-y-0 left-0 w-[min(20rem,85vw)] animate-fade-in border-r border-line bg-surface shadow-pop">
            <div className="flex items-center justify-between border-b border-line py-2 pl-4 pr-2">
              <span className="text-sm font-semibold">Conversations</span>
              <Button variant="ghost" size="icon" onClick={() => setHistoryOpen(false)} aria-label="Close">
                <X className="size-4" />
              </Button>
            </div>
            <div className="h-[calc(100%-3.25rem)]">
              <ConversationList activeId={id} onNavigate={() => setHistoryOpen(false)} />
            </div>
          </div>
        </div>
      )}

      <section className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-3 lg:hidden">
          <Button variant="ghost" size="sm" onClick={() => setHistoryOpen(true)}>
            <History className="size-4" aria-hidden />
            History
          </Button>
          <span className="min-w-0 flex-1 truncate text-center text-sm font-medium text-ink-2">{conversation.data?.conversation.title ?? ''}</span>
          <Link to="/chat" className="grid size-8 place-items-center rounded-lg text-ink-2 hover:bg-sunken" aria-label="New conversation">
            <Plus className="size-4" />
          </Link>
        </header>

        <div ref={scrollRef} onScroll={onScroll} className="scroll-quiet flex-1 overflow-y-auto">
          <div className="mx-auto flex min-h-full w-full max-w-2xl flex-col px-4 py-6 md:px-6 md:py-10">
            {isEmpty && (
              <div className="my-auto animate-rise pb-8 text-center">
                <div className="mx-auto mb-5 grid size-12 place-items-center rounded-full bg-accent-soft text-accent">
                  <MessageCircle className="size-5" aria-hidden />
                </div>
                <h1 className="font-serif text-[30px] font-medium leading-tight tracking-tight">
                  What would you like to look back on{user?.name ? `, ${user.name.split(' ')[0]}` : ''}?
                </h1>
                <p className="mx-auto mt-2 max-w-md text-ink-2">
                  Ask about anything you have written. Answers come from your own entries, with links to where they came from.
                </p>
                <div className="mx-auto mt-8 grid max-w-xl gap-2 sm:grid-cols-2">
                  {SUGGESTIONS.map((suggestion) => (
                    <button
                      key={suggestion}
                      type="button"
                      onClick={() => send(suggestion)}
                      className="rounded-xl border border-line bg-surface px-4 py-3 text-left text-sm text-ink-2 transition-colors hover:border-line-strong hover:text-ink"
                    >
                      {suggestion}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {id && conversation.isPending && !live && (
              <div className="my-auto grid place-items-center text-ink-3" role="status" aria-label="Loading conversation">
                <Spinner className="size-5" />
              </div>
            )}
            {notFound && <ErrorNote>This conversation does not exist or was deleted.</ErrorNote>}
            {conversation.isError && !notFound && <ErrorNote onRetry={conversation.refetch}>{conversation.error.message}</ErrorNote>}

            <div className="space-y-6" aria-live="polite">
              {messages.map((message) =>
                message.role === 'user' ? (
                  <UserBubble key={message.id}>{message.content}</UserBubble>
                ) : (
                  <AssistantMessage key={message.id} content={message.content} sources={message.sources} interrupted={message.meta?.interrupted} />
                ),
              )}

              {live && !liveUserShown && <UserBubble>{live.userText}</UserBubble>}
              {live && !live.error && live.text === '' && (
                <p className="flex items-center gap-2 text-sm text-ink-3" role="status">
                  <Spinner className="size-3.5" />
                  {STAGE_LABEL[live.stage] ?? 'Thinking…'}
                </p>
              )}
              {live && live.text !== '' && <AssistantMessage content={live.text} sources={live.sources} streaming={!live.error} />}
              {live?.error && <ErrorNote onRetry={retry}>{live.error}</ErrorNote>}
            </div>
          </div>
        </div>

        {/* Composer */}
        <div className="shrink-0 px-4 pb-4 md:px-6 md:pb-6">
          <form onSubmit={onSubmit} className="mx-auto max-w-2xl">
            {config.data && !config.data.features.assistant && (
              <p className="mb-2 rounded-xl bg-sunken px-3.5 py-2 text-[13px] text-ink-2">
                The assistant is not connected yet. Add <code className="font-mono text-xs">GEMINI_API_KEY</code> to the server&rsquo;s{' '}
                <code className="font-mono text-xs">.env</code> file and restart it.
              </p>
            )}
            <div className="flex items-end gap-2 rounded-2xl border border-line-strong bg-surface p-2 shadow-card focus-within:border-accent">
              <AutoTextarea
                ref={composerRef}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  // Enter sends; Shift+Enter adds a line.  Ignore Enter while an IME is composing.
                  if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    send(draft);
                  }
                }}
                placeholder="Ask about your journal…"
                aria-label="Message"
                maxLength={4000}
                maxHeight={180}
                disabled={notFound}
                className="min-h-9 flex-1 bg-transparent px-2.5 py-1.5 text-[15.5px] text-ink outline-none placeholder:text-ink-3"
              />
              {busy ? (
                <Button type="button" variant="secondary" size="icon" onClick={stop} aria-label="Stop answering" title="Stop">
                  <Square className="size-3.5 fill-current" />
                </Button>
              ) : (
                <Button type="submit" size="icon" disabled={!draft.trim() || notFound} aria-label="Send message" title="Send">
                  <ArrowUp className="size-[18px]" />
                </Button>
              )}
            </div>
            <p className="mt-2 text-center text-xs text-ink-3">Inkwell answers from your entries and can be wrong. It is not a substitute for professional care.</p>
          </form>
        </div>
      </section>
    </div>
  );
}
