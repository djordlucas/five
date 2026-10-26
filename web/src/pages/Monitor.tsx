import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { useLocation } from 'preact-iso';
import { get, message, post, type ProcessDetail, type ProcessInfo } from '../api/client';
import { Badge, ui } from '../components/ui';
import { clock, duration, pretty } from '../format';
import { status } from '../live';
import split from './Workspace.module.css';
import styles from './Monitor.module.css';

const live = (p: ProcessInfo) => p.state === 'installing' || p.state === 'running';

/**
 * What five has running. For now its processes: every child process five started since it started — each run_js, each call
 * of a tool the agent built, each define_tool trial, each background run —
 * newest first, live ones to follow and kill.
 */
export function Monitor() {
  const { query } = useLocation();
  const open = query.id || undefined;
  const [list, setList] = useState<ProcessInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Polled with the status, once a second: durations and output grow.
  const tick = status.value;

  useEffect(() => {
    get<{ processes: ProcessInfo[] }>('/processes').then(
      (r) => {
        setList(r.processes);
        setError(null);
      },
      (err: unknown) => setError(message(err)),
    );
  }, [tick]);

  const running = list?.filter(live).length ?? 0;
  return (
    <div class={`${split.split} ${open ? split.open : ''}`}>
      <nav class={split.list} aria-label="Processes">
        <p class="muted">
          {list === null ? 'Loading…' : `${list.length} since five started${running ? ` · ${running} live` : ''}`}
        </p>
        {error && <p class="error">{error}</p>}
        {list?.length === 0 && <p class="muted">None yet: the agent has not run any code.</p>}
        <ul class={split.entries}>
          {list?.map((p) => (
            <li key={p.id}>
              <a href={`/monitor?id=${p.id}`} class={split.entry} aria-current={p.id === open ? 'page' : undefined}>
                <span class={split.kind}>
                  <Badge state={p.state} />
                </span>
                <span class={split.name}>
                  {p.label}
                  {p.runId && <span class="muted"> · {p.runId}</span>}
                </span>
                <span class={split.meta}>
                  turn {p.turn} · step {p.step} · {clock(p.startedAt)} · {duration(p.durationMs)}
                  {p.lines > 0 && ` · ${p.lines} lines`}
                </span>
              </a>
            </li>
          ))}
        </ul>
      </nav>
      <section class={split.pane} aria-label="Process">
        {open ? (
          <Detail key={open} id={open} tick={tick} />
        ) : (
          <p class="card muted">
            Each run of code is a Node.js process of its own, with all of Node and no permission model. Choose one to see its
            code, arguments, output and result. Kept in memory: a restart of five starts the list over.
          </p>
        )}
      </section>
    </div>
  );
}

function Detail({ id, tick }: { id: string; tick: unknown }) {
  const [p, setP] = useState<ProcessDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const output = useRef<HTMLPreElement>(null);
  const isLive = p ? live(p) : true;

  // A live process is reloaded with every poll; a finished one no more.
  useEffect(() => {
    if (!isLive) return;
    get<ProcessDetail>(`/processes/${encodeURIComponent(id)}`).then(
      (d) => {
        setP(d);
        setError(null);
      },
      (err: unknown) => setError(message(err)),
    );
  }, [id, tick, isLive]);

  // Follow the output's end as it grows, unless scrolled up.
  useLayoutEffect(() => {
    const el = output.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 80) el.scrollTop = el.scrollHeight;
  }, [p?.logs.length]);

  const kill = async () => {
    setBusy(true);
    try {
      setP(await post<ProcessDetail>(`/processes/${encodeURIComponent(id)}/kill`));
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  };

  if (!p) return error ? <p class="card error">{error}</p> : <p class="card muted">Loading…</p>;
  return (
    <article class={`card ${split.detail}`}>
      <header class={split.head}>
        <a class={split.back} href="/monitor" aria-label="All processes">
          ‹
        </a>
        <div class={split.title}>
          <h2>
            {p.label} <Badge state={p.state} />
          </h2>
          <span class="muted">
            {[
              p.kind === 'code' ? 'run_js code' : p.kind === 'trial' ? 'a define_tool trial' : 'a tool the agent built',
              p.runId ? `background run ${p.runId}` : '',
              `turn ${p.turn}, step ${p.step}`,
              `started ${clock(p.startedAt)}`,
              `${live(p) ? 'running for' : 'ran'} ${duration(p.durationMs)}`,
              `id ${p.id}`,
            ]
              .filter(Boolean)
              .join(' · ')}
          </span>
        </div>
        {live(p) && (
          <div class={split.actions}>
            <button type="button" class={`${ui.action} ${ui.danger}`} disabled={busy} onClick={() => void kill()}>
              Kill
            </button>
          </div>
        )}
      </header>
      {error && <p class="error">{error}</p>}
      {p.error && (
        <section class={styles.part}>
          <h3>Error</h3>
          <pre class={`${ui.pre} ${styles.failed}`}>{p.error}</pre>
        </section>
      )}
      {p.state === 'ok' && (
        <section class={styles.part}>
          <h3>Result</h3>
          <pre class={ui.pre}>{p.value === null || p.value === undefined ? '(no return value)' : pretty(p.value)}</pre>
        </section>
      )}
      <section class={styles.part}>
        <h3>
          Output <span class="muted">{p.lines} lines</span>
        </h3>
        {p.logs.length === 0 ? (
          <p class="muted">{live(p) ? 'Nothing printed yet.' : 'Nothing printed.'}</p>
        ) : (
          <pre ref={output} class={`${ui.pre} ${styles.output}`}>
            {p.logs.join('\n')}
          </pre>
        )}
      </section>
      {p.args !== null && p.args !== undefined && (
        <section class={styles.part}>
          <h3>Arguments</h3>
          <pre class={ui.pre}>{pretty(p.args)}</pre>
        </section>
      )}
      <section class={styles.part}>
        <h3>Code</h3>
        <pre class={`${ui.pre} ${styles.code}`}>{p.source || '(not readable)'}</pre>
      </section>
    </article>
  );
}
