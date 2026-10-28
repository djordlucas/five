import { useEffect, useState } from 'preact/hooks';
import { get, message, type WorkerDetail, type WorkerInfo, type WorkerKind } from '../api/client';
import { Code } from '../code';
import { Icon } from '../components/Icon';
import { Badge, ui } from '../components/ui';
import { ago } from '../format';
import { status } from '../live';
import type { IconName } from '../sections';
import styles from './Tools.module.css';
import browse from './Workspace.module.css';

type Show = 'all' | WorkerKind;

const SHOWS: { value: Show; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'task', label: 'Task workers' },
  { value: 'lead', label: 'Lead' },
  { value: 'chat', label: 'Chat' },
];

const icons: Record<WorkerKind, IconName> = { lead: 'lead', chat: 'chat', task: 'worker' };

/**
 * Five's workers: the lead and the chat, five's own, and the task workers —
 * code the lead writes and revises — each with the tasks it did; and one
 * worker's code, or for a fixed one its instructions.
 */
export function Workers({ name }: { name?: string }) {
  const [workers, setWorkers] = useState<WorkerInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [show, setShow] = useState<Show>('all');
  // A worker changes, or does a task, with an event.
  const lastSeq = status.value?.lastSeq;

  useEffect(() => {
    get<{ workers: WorkerInfo[] }>('/workers').then(
      (r) => setWorkers(r.workers),
      (err: unknown) => setError(message(err)),
    );
  }, [lastSeq]);

  if (name) return <Worker name={name} />;
  const all = workers ?? [];
  const needle = search.trim().toLowerCase();
  const shown = all.filter(
    (w) =>
      (show === 'all' || w.kind === show) &&
      (!needle || w.name.toLowerCase().includes(needle) || w.description.toLowerCase().includes(needle)),
  );
  const counts = Object.fromEntries(SHOWS.map((s) => [s.value, all.filter((w) => s.value === 'all' || w.kind === s.value).length]));

  return (
    <section class={browse.browser} aria-label="Workers">
      <div class={browse.filters}>
        <label class={browse.search}>
          <Icon name="search" size={16} />
          <input
            type="search"
            placeholder="Search names and descriptions"
            value={search}
            aria-label="Search workers"
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
      </div>

      {error && <p class="error">{error}</p>}
      {all.length > 0 && shown.length === 0 && <p class="muted">No worker matches.</p>}
      <ul class={styles.cards}>
        {shown.map((w) => (
          <li key={w.name}>
            <a class={styles.card} href={`/workspace/workers/${w.name}`}>
              <span class={styles.icon}>
                <Icon name={icons[w.kind]} size={20} />
              </span>
              <span class={styles.name}>{w.name}</span>
              <span class={styles.meta}>
                {w.fixed ? (
                  <Badge state="ok">five's own</Badge>
                ) : (
                  <>
                    r{w.revision} · {w.updatedAt && ago(w.updatedAt)} · {w.done} done
                    {w.failed > 0 && (
                      <>
                        {' '}
                        <Badge state="warn">{w.failed} failed</Badge>
                      </>
                    )}
                  </>
                )}
              </span>
              <span class={styles.desc}>{w.description}</span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Worker({ name }: { name: string }) {
  const [w, setW] = useState<WorkerDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    get<WorkerDetail>(`/workers/${encodeURIComponent(name)}`).then(setW, (err: unknown) => setError(message(err)));
  }, [name]);
  return (
    <div class={styles.page}>
      <a href="/workspace/workers">← All workers</a>
      {error && <p class="error">{error}</p>}
      {w && (
        <>
          <h2 class={styles.title}>
            {w.name} <span class="muted">{w.fixed ? "five's own" : `r${w.revision}`}</span>
          </h2>
          <p>{w.description}</p>
          {!w.fixed && (
            <p>
              {w.done} tasks done, {w.failed} failed · <a href={`/board?worker=${w.name}`}>its tasks</a>
              {w.libs && w.libs.length > 0 && <> · built on {w.libs.map((l) => `lib:${l.name} r${l.revision}`).join(', ')}</>}
            </p>
          )}
          <h3>{w.fixed ? 'Its instructions (system prompt)' : 'Code'}</h3>
          {w.fixed ? <pre class={ui.pre}>{w.source}</pre> : <Code class={ui.pre} text={w.source} lang="js" />}
        </>
      )}
    </div>
  );
}
