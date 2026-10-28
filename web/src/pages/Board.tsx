import { useEffect, useState } from 'preact/hooks';
import { useLocation } from 'preact-iso';
import { type BoardPage, del, get, message, post, type Task, type WorkerInfo } from '../api/client';
import { Icon } from '../components/Icon';
import { Badge, ui } from '../components/ui';
import { ago, clock, duration, oneLine } from '../format';
import { refresh, status } from '../live';
import { Markdown } from '../markdown';
import browse from './Workspace.module.css';
import styles from './Board.module.css';

type Show = 'all' | Task['status'];

const SHOWS: { value: Show; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'open', label: 'Open' },
  { value: 'running', label: 'Running' },
  { value: 'done', label: 'Done' },
  { value: 'failed', label: 'Failed' },
  { value: 'cancelled', label: 'Cancelled' },
];

const badge: Record<Task['status'], string> = {
  open: 'paused',
  running: 'running',
  done: 'ok',
  failed: 'failed',
  cancelled: 'paused',
};

/**
 * The board: every task five's workers share, newest first — who posted it,
 * which worker took it, and what came of it. Post one yourself, or cancel one
 * still open.
 */
export function Board() {
  const { query } = useLocation();
  const [page, setPage] = useState<BoardPage | null>(null);
  const [workers, setWorkers] = useState<WorkerInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [show, setShow] = useState<Show>('all');
  const [worker, setWorker] = useState(query.worker ?? '');
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState<number | null>(Number(query.task) || null);
  const lastSeq = status.value?.lastSeq;

  const load = () =>
    get<BoardPage>('/board?limit=500').then(
      (r) => {
        setPage(r);
        setError(null);
      },
      (err: unknown) => setError(message(err)),
    );
  useEffect(() => {
    void load();
  }, [lastSeq]);
  useEffect(() => {
    get<{ workers: WorkerInfo[] }>('/workers').then(
      (r) => setWorkers(r.workers.filter((w) => w.kind === 'task')),
      () => {},
    );
  }, [status.value?.workers]);
  useEffect(() => {
    if (open) document.getElementById(`task-${open}`)?.scrollIntoView({ block: 'center' });
  }, [page === null]);

  const all = page?.tasks ?? [];
  const needle = search.trim().toLowerCase();
  const shown = all.filter(
    (t) =>
      (show === 'all' || t.status === show) &&
      (!worker || t.worker === worker) &&
      (!needle || t.title.toLowerCase().includes(needle) || t.input.toLowerCase().includes(needle) || (t.result ?? '').toLowerCase().includes(needle)),
  );
  const counts = Object.fromEntries(SHOWS.map((s) => [s.value, all.filter((t) => s.value === 'all' || t.status === s.value).length]));

  const cancel = async (id: number) => {
    try {
      await del(`/board/${id}`);
      await load();
    } catch (err) {
      setError(message(err));
    }
  };

  return (
    <div class={styles.page}>
      <PostTask workers={workers} onPosted={load} />
      <div class={browse.filters}>
        <label class={browse.search}>
          <Icon name="search" size={16} />
          <input
            type="search"
            placeholder="Search titles, inputs and results"
            value={search}
            aria-label="Search tasks"
            onInput={(e) => setSearch(e.currentTarget.value)}
          />
        </label>
        <div class={browse.kinds} role="group" aria-label="Show">
          {SHOWS.map((k) => (
            <button
              key={k.value}
              type="button"
              class={browse.kindButton}
              aria-pressed={show === k.value}
              onClick={() => setShow(k.value)}
            >
              {k.label}
              <span class={browse.kindCount}>{counts[k.value]}</span>
            </button>
          ))}
        </div>
        <label class={browse.sort}>
          Worker
          <select value={worker} onChange={(e) => setWorker(e.currentTarget.value)}>
            <option value="">Any</option>
            {[...new Set([...workers.map((w) => w.name), ...all.map((t) => t.worker)])].sort().map((w) => (
              <option key={w} value={w}>
                {w}
              </option>
            ))}
          </select>
        </label>
      </div>

      {error && <p class="error">{error}</p>}
      {page === null && !error && <p class="muted">Loading…</p>}
      {page && all.length === 0 && <p class="card muted">No tasks yet. The lead posts them; you can too, above.</p>}
      {all.length > 0 && shown.length === 0 && <p class="muted">No task matches.</p>}
      <ol class={styles.list}>
        {shown.map((t) => {
          const isOpen = open === t.id;
          const took = t.startedAt && t.endedAt ? Date.parse(t.endedAt) - Date.parse(t.startedAt) : undefined;
          return (
            <li key={t.id} id={`task-${t.id}`} class={`card ${styles.task} ${isOpen ? styles.open : ''}`}>
              <button type="button" class={styles.head} onClick={() => setOpen(isOpen ? null : t.id)} aria-expanded={isOpen}>
                <span class={styles.id}>#{t.id}</span>
                <Badge state={badge[t.status]}>{t.status}</Badge>
                <span class={styles.worker}>{t.worker}</span>
                <span class={styles.title}>{t.title}</span>
                <span class={styles.meta} title={new Date(t.createdAt).toLocaleString()}>
                  by {t.postedBy === 'person' ? 'you' : t.postedBy} · {ago(t.createdAt)}
                  {took !== undefined && ` · took ${duration(took)}`}
                </span>
              </button>
              {!isOpen && (t.result || t.error) && (
                <p class={`${styles.preview} ${t.error ? styles.failed : ''}`}>{oneLine(t.error ?? t.result ?? '', 220)}</p>
              )}
              {isOpen && (
                <div class={styles.body}>
                  <p class="muted">
                    Posted {clock(t.createdAt)} by {t.postedBy === 'person' ? 'you' : t.postedBy}
                    {t.startedAt && `, started ${clock(t.startedAt)}`}
                    {t.endedAt && `, ended ${clock(t.endedAt)}`}
                    {t.run !== undefined && (
                      <>
                        {' · '}
                        <a href="/">run {t.run} in Activity</a>
                      </>
                    )}
                  </p>
                  {t.input && (
                    <>
                      <h3>Input</h3>
                      <pre class={ui.pre}>{t.input}</pre>
                    </>
                  )}
                  {t.result && (
                    <>
                      <h3>Result</h3>
                      <Markdown text={t.result} class={styles.md} />
                    </>
                  )}
                  {t.error && (
                    <>
                      <h3>Error</h3>
                      <pre class={`${ui.pre} ${styles.failed}`}>{t.error}</pre>
                    </>
                  )}
                  {t.status === 'open' && (
                    <div class={styles.actions}>
                      <button type="button" class={ui.action} onClick={() => void cancel(t.id)}>
                        <Icon name="trash" size={16} />
                        Cancel task
                      </button>
                    </div>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/** A task of the person's own, for a task worker. */
function PostTask({ workers, onPosted }: { workers: WorkerInfo[]; onPosted: () => void }) {
  const [open, setOpen] = useState(false);
  const [worker, setWorker] = useState('');
  const [title, setTitle] = useState('');
  const [input, setInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const chosen = workers.find((w) => w.name === worker);
  if (!open) {
    return (
      <div class={styles.postBar}>
        <button type="button" class={ui.action} onClick={() => setOpen(true)}>
          <Icon name="plus" size={16} />
          Post a task
        </button>
      </div>
    );
  }
  const submit = async () => {
    try {
      await post('/board', { worker, title: title.trim(), input });
      setTitle('');
      setInput('');
      setOpen(false);
      setError(null);
      onPosted();
      await refresh();
    } catch (err) {
      setError(message(err));
    }
  };
  return (
    <form
      class={`card ${styles.post}`}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <label>
        Worker
        <select value={worker} onChange={(e) => setWorker(e.currentTarget.value)} required>
          <option value="">Choose…</option>
          {workers.map((w) => (
            <option key={w.name} value={w.name}>
              {w.name}
            </option>
          ))}
        </select>
      </label>
      {chosen && <p class="muted">{chosen.description}</p>}
      <label>
        Title
        <input class="input" value={title} onInput={(e) => setTitle(e.currentTarget.value)} placeholder="What to do, in a line" required />
      </label>
      <label>
        Input
        <textarea rows={4} value={input} onInput={(e) => setInput(e.currentTarget.value)} placeholder="What the worker needs, as its description asks" />
      </label>
      {error && <p class="error">{error}</p>}
      <div class={styles.actions}>
        <button type="button" class={ui.action} onClick={() => setOpen(false)}>
          Discard
        </button>
        <button type="submit" class="button" disabled={!worker || !title.trim()}>
          Post
        </button>
      </div>
    </form>
  );
}
