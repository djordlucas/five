import { signal } from '@preact/signals';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
  type ActiveRun,
  type ChatStatus,
  type Event,
  type LiveWork,
  message,
  post,
  type WorkerKind,
} from '../api/client';
import { Code } from '../code';
import { Icon } from '../components/Icon';
import { Badge } from '../components/ui';
import { clock, duration, oneLine, prettyArgs } from '../format';
import { events, loadMoreRuns, refresh, runsLoaded, status } from '../live';
import { Markdown } from '../markdown';
import type { IconName } from '../sections';
import { fileHref, rawUrl } from '../workspace';
import styles from './Activity.module.css';

/** The choices of how many runs the page shows, the last first. */
const SHOW = [5, 10, 20, 50, 100];
const shown = signal<number>(read<number>('five.showRuns', (n) => SHOW.includes(Number(n)), 20));
/** Which runs the page shows: every kind, or one. */
type Filter = 'all' | WorkerKind;
const filter = signal<Filter>(read('five.runFilter', (v) => ['all', 'lead', 'chat', 'task'].includes(v), 'all'));
/** Finished runs opened by hand; a running run is always open. */
const opened = signal<Set<number>>(new Set());

function read<T extends string | number>(key: string, ok: (v: string) => boolean, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    if (v !== null && ok(v)) return (typeof fallback === 'number' ? Number(v) : v) as T;
  } catch {
    // The default, then.
  }
  return fallback;
}

function keep(key: string, value: string | number): void {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    // Not kept: the default comes back on the next load.
  }
}

function setShown(n: number): void {
  shown.value = n;
  keep('five.showRuns', n);
  // The timeline loads 30 runs back at first: load more when asked for more.
  if (n > runsLoaded.value) void loadMoreRuns(n - runsLoaded.value);
}

type Of<T extends Event['type']> = Extract<Event, { type: T }>;

interface RunGroup {
  n: number;
  started?: Of<'run_started'>;
  ended?: Of<'run_ended'>;
  /** Everything between, in order. */
  items: Event[];
  /** Tool results by call id. */
  results: Map<string, Of<'tool'>>;
  /** Its first event, to place it in the timeline. */
  first: number;
}

type Item = { kind: 'run'; run: RunGroup } | { kind: 'event'; e: Event };

/** The events as the timeline shows them: each run as one group where it began, and the events of no run between. */
function timeline(list: Event[]): Item[] {
  const runs = new Map<number, RunGroup>();
  const items: Item[] = [];
  for (const e of list) {
    if (e.run === 0) {
      items.push({ kind: 'event', e });
      continue;
    }
    let g = runs.get(e.run);
    if (!g) {
      g = { n: e.run, items: [], results: new Map(), first: e.seq };
      runs.set(e.run, g);
      items.push({ kind: 'run', run: g });
    }
    if (e.type === 'run_started') g.started = e;
    else if (e.type === 'run_ended') g.ended = e;
    else if (e.type === 'tool') g.results.set(e.id, e);
    else g.items.push(e);
  }
  return items;
}

/** Five at work: its controls, then every run, newest at the bottom, followed as it grows — and the chat below. */
export function Activity() {
  const items = useMemo(() => timeline(events.value), [events.value]);
  const bottom = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const s = status.value;
  const active = new Map((s?.active ?? []).map((a) => [a.run, a]));
  const chat = s?.chat;
  const live = s?.active.map((a) => `${a.run}:${a.live?.phase}:${a.live?.content?.length ?? 0}:${a.live?.thinking?.length ?? 0}`).join();

  // Follow the bottom as events arrive, as replies stream in, and as the person writes.
  useLayoutEffect(() => {
    if (stick.current) bottom.current?.scrollIntoView({ block: 'end' });
  }, [events.value.length, live, chat?.queued.length]);
  useEffect(() => {
    const onScroll = () => {
      const b = bottom.current?.getBoundingClientRect();
      if (b) stick.current = b.bottom <= window.innerHeight + 120;
    };
    window.addEventListener('scroll', onScroll, true);
    return () => window.removeEventListener('scroll', onScroll, true);
  }, []);

  const f = filter.value;
  const runs = items.filter((i): i is Extract<Item, { kind: 'run' }> => i.kind === 'run');
  const keepRuns = new Set(
    runs
      .filter((i) => f === 'all' || i.run.started?.kind === f)
      .slice(-shown.value)
      .map((i) => i.run.n),
  );
  const firstShown = runs.find((i) => keepRuns.has(i.run.n))?.run.first ?? Number.POSITIVE_INFINITY;
  const visible = items.filter((i) =>
    i.kind === 'run' ? keepRuns.has(i.run.n) : f === 'all' && i.e.seq >= Math.min(firstShown, Number.MAX_SAFE_INTEGER),
  );
  const hidden = runs.filter((i) => f === 'all' || i.run.started?.kind === f).length - keepRuns.size;
  const more = SHOW.find((n) => n > shown.value);
  // The chat's run, when it has not shown an event yet.
  const chatShown = chat && runs.some((i) => i.run.n === chat.run);

  return (
    <div class={styles.page}>
      <Controls />
      {hidden > 0 && more && (
        <button type="button" class={styles.more} onClick={() => setShown(more)}>
          {hidden} earlier {hidden === 1 ? 'run' : 'runs'} hidden · show the last {more}
        </button>
      )}
      {items.length === 0 && <p class="muted">Nothing yet. Start five, or say something below.</p>}
      {visible.map((i) =>
        i.kind === 'run' ? (
          <RunView
            key={`r${i.run.n}`}
            g={i.run}
            active={active.get(i.run.n)}
            chat={chat?.run === i.run.n ? chat : undefined}
          />
        ) : (
          <Line key={i.e.seq} e={i.e} />
        ),
      )}
      {chat && !chatShown && <Queued chat={chat} />}
      <div ref={bottom} />
      <Composer chat={chat} />
    </div>
  );
}

function Controls() {
  const s = status.value;
  const [error, setError] = useState<string | null>(null);
  if (!s) return null;
  const act = async (what: 'start' | 'pause' | 'stop') => {
    setError(null);
    try {
      await post(`/loop/${what}`);
      await refresh();
    } catch (err) {
      setError(message(err));
    }
  };
  const busy = s.active.filter((a) => a.live?.phase === 'model').length;
  const tasks = s.active.filter((a) => a.kind === 'task').length;
  const facts = [
    s.running ? 'running' : 'paused',
    `${tasks} ${tasks === 1 ? 'task' : 'tasks'} in progress`,
    `model ${busy}/${s.slots}${s.queued ? `, ${s.queued} waiting` : ''}`,
    `${s.board.open} open · ${s.board.done} done${s.board.failed ? ` · ${s.board.failed} failed` : ''}`,
  ];
  return (
    <header class={styles.bar}>
      <div class={styles.title}>
        <h2>
          five · {s.model}
          {s.think && ' · thinking'}
        </h2>
        <span class="muted">{facts.join(' · ')}</span>
      </div>
      <div class={styles.actions}>
        <a class={styles.slots} href="/board" title="The board">
          <Slots s={s.slots} busy={busy} queued={s.queued} />
        </a>
        <Filters />
        <ShownRuns />
        {s.running ? (
          <button type="button" class={styles.action} onClick={() => void act('pause')} title="Start no new runs">
            <Icon name="pause" size={16} />
            Pause
          </button>
        ) : (
          <button type="button" class={styles.action} onClick={() => void act('start')}>
            <Icon name="play" size={16} />
            Start
          </button>
        )}
        {s.active.some((a) => a.kind !== 'chat') && (
          <button
            type="button"
            class={styles.action}
            onClick={() => void act('stop')}
            title="Pause, and stop the lead and task runs now; the chat goes on"
          >
            <Icon name="stop" size={16} />
            Stop runs
          </button>
        )}
      </div>
      <p class={styles.goal}>
        <Icon name="flag" size={14} />
        <span>{oneLine(s.goal, 220)}</span>
        <a href="/config">change</a>
      </p>
      {error && <p class="error">{error}</p>}
    </header>
  );
}

/** The model's slots as squares: filled while a call runs, and how many wait. */
function Slots({ s, busy, queued }: { s: number; busy: number; queued: number }) {
  return (
    <span class={styles.slotRow} role="img" aria-label={`${busy} of ${s} model slots busy, ${queued} waiting`}>
      {Array.from({ length: s }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: one square per slot, in order
        <span key={i} class={`${styles.slot} ${i < busy ? styles.slotBusy : ''}`} />
      ))}
    </span>
  );
}

const FILTERS: { value: Filter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'lead', label: 'Lead' },
  { value: 'task', label: 'Tasks' },
  { value: 'chat', label: 'Chat' },
];

function Filters() {
  return (
    <div class={styles.filters} role="group" aria-label="Runs shown">
      {FILTERS.map((f) => (
        <button
          key={f.value}
          type="button"
          aria-pressed={filter.value === f.value}
          onClick={() => {
            filter.value = f.value;
            keep('five.runFilter', f.value);
          }}
        >
          {f.label}
        </button>
      ))}
    </div>
  );
}

/** ‹ last N runs ›: how much of the timeline the page shows. */
function ShownRuns() {
  const i = SHOW.indexOf(shown.value);
  const n = shown.value;
  return (
    <div class={styles.stepper} role="group" aria-label="Runs shown">
      <button type="button" disabled={i <= 0} onClick={() => setShown(SHOW[i - 1] as number)} aria-label="Fewer runs">
        ‹
      </button>
      <span>last {n} runs</span>
      <button
        type="button"
        disabled={i >= SHOW.length - 1}
        onClick={() => setShown(SHOW[i + 1] as number)}
        aria-label="More runs"
      >
        ›
      </button>
    </div>
  );
}

const kindIcon: Record<WorkerKind, IconName> = { lead: 'lead', chat: 'chat', task: 'worker' };

/** One run: its worker and task, what it did, and how it ended. A finished run folds to its result. */
function RunView({ g, active, chat }: { g: RunGroup; active?: ActiveRun; chat?: ChatStatus }) {
  const kind = g.started?.kind ?? active?.kind ?? 'task';
  const worker = g.started?.worker ?? active?.worker ?? '?';
  const task = g.started?.task;
  const running = Boolean(active);
  const open = running || kind === 'chat' || opened.value.has(g.n);
  const toggle = () => {
    if (running || kind === 'chat') return;
    const next = new Set(opened.value);
    if (next.has(g.n)) next.delete(g.n);
    else next.add(g.n);
    opened.value = next;
  };
  const outcome = g.ended?.outcome;
  const state = running ? 'running' : outcome === 'done' ? 'ok' : outcome === 'stopped' ? 'paused' : 'failed';
  const steps = g.items.filter((e) => e.type === 'model').length;
  const startedAt = g.started?.at ?? active?.startedAt;
  return (
    <section class={`${styles.run} ${styles[kind]} ${open ? styles.open : ''}`} aria-label={`Run ${g.n}`}>
      <button type="button" class={styles.runHead} onClick={toggle} aria-expanded={open}>
        <span class={styles.kind}>
          <Icon name={kindIcon[kind]} size={16} />
        </span>
        <span class={styles.runName}>{worker}</span>
        {task && (
          <span class={styles.runTask}>
            #{task.id} {task.title}
          </span>
        )}
        <span class={styles.runMeta}>
          run {g.n}
          {steps > 0 && ` · ${steps} ${steps === 1 ? 'call' : 'calls'}`}
          {g.ended && ` · ${duration(g.ended.durationMs)}`}
        </span>
        {g.ended ? (
          <Badge state={state}>{outcome}</Badge>
        ) : running ? (
          <Badge state="running">{active?.live?.phase === 'queued' ? 'waiting for the model' : 'working'}</Badge>
        ) : null}
        {startedAt && <span class={styles.at}>{clock(startedAt)}</span>}
      </button>
      {!open && g.ended && <Outcome e={g.ended} short />}
      {open && (
        <div class={styles.runBody}>
          {g.started?.prompt && <Prompt kind={kind} text={g.started.prompt} />}
          {g.items.map((e) => (
            <RunItem key={e.seq} e={e} g={g} />
          ))}
          {chat && <Queued chat={chat} />}
          {active?.live && <Working live={active.live} />}
          {chat?.waitingUntil && !active?.live && <Waiting until={chat.waitingUntil} />}
          {g.ended && kind !== 'chat' && <Outcome e={g.ended} />}
        </div>
      )}
    </section>
  );
}

/** What a run was given: a task's title and input, or the lead's whole prompt, folded. */
function Prompt({ kind, text }: { kind: WorkerKind; text: string }) {
  if (kind === 'task' && text.length <= 400) return <div class={styles.prompt}>{text}</div>;
  return (
    <details class={styles.thinking}>
      <summary>{kind === 'lead' ? 'What the lead was given' : 'The task'}</summary>
      <pre class={styles.pre}>{text}</pre>
    </details>
  );
}

function Outcome({ e, short }: { e: Of<'run_ended'>; short?: boolean }) {
  const text = e.error ?? e.result ?? '';
  if (!text) return null;
  if (short) return <p class={`${styles.result} ${e.error ? styles.failed : ''}`}>{oneLine(text, 200)}</p>;
  return (
    <div class={`${styles.end} ${e.error ? styles.failed : ''}`}>
      <span class={styles.endLabel}>{e.error ? 'Error' : 'Result'}</span>
      {e.error ? <pre class={styles.pre}>{e.error}</pre> : <Markdown text={text} class={styles.md} />}
    </div>
  );
}

function RunItem({ e, g }: { e: Event; g: RunGroup }) {
  switch (e.type) {
    case 'model':
      return e.chat ? <Answer e={e} /> : <Step e={e} results={g.results} />;
    case 'chat':
      return (
        <div class={styles.you}>
          {e.text}
          <span class={styles.bubbleMeta}>you · {clock(e.at)}</span>
        </div>
      );
    default:
      return <Line e={e} />;
  }
}

/** An event on a line of its own: five's, the person's, or a run's note. */
function Line({ e }: { e: Event }) {
  const line = (icon: IconName, body: preact.ComponentChildren, cls = '') => (
    <p class={`${styles.line} ${cls}`}>
      <At iso={e.at} />
      <Kind icon={icon} />
      {body}
    </p>
  );
  switch (e.type) {
    case 'task':
      return line(
        'board',
        <>
          {e.action === 'posted' ? `${e.by === 'person' ? 'you' : e.by} posted` : e.action} task{' '}
          <a href={`/board?task=${e.id}`}>#{e.id}</a> for {e.worker}: {e.title}
        </>,
        e.action === 'failed' ? styles.warn : '',
      );
    case 'chat_ended':
      return line('chat', `Chat ended: ${e.reason === 'left' ? 'you left it' : 'no answer from you in time'}${e.saved ? ` · saved to ${e.saved}` : ''}`);
    case 'goal':
      return line('flag', <>{e.by === 'person' ? 'you' : e.by} set the goal: {oneLine(e.text, 240)}</>);
    case 'worker':
      return line(
        'worker',
        <>
          worker <a href={`/workspace/workers/${e.name}`}>{e.name}</a> {e.action}
          {e.revision ? ` (revision ${e.revision})` : ''}
        </>,
      );
    case 'inbox':
      return line(
        'inbox',
        <>
          {e.from === 'five' ? 'to you' : 'you wrote'}: {e.subject && <strong>{e.subject} — </strong>}
          {oneLine(e.text, 240)} · <a href="/inbox">inbox</a>
        </>,
        styles.inbox,
      );
    case 'settings':
      return line('config', <><a href="/config">config</a>: {e.change}</>);
    case 'loop':
      return line(e.state === 'started' ? 'play' : e.state === 'paused' ? 'pause' : 'stop', `Five ${e.state}${e.reason ? `: ${e.reason}` : ''}`);
    default:
      return null;
  }
}

/** The person's messages waiting for five to finish its answer. */
function Queued({ chat }: { chat: ChatStatus }) {
  return (
    <>
      {chat.queued.map((text, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the queue only grows until it is taken whole
        <div key={i} class={`${styles.you} ${styles.queued}`}>
          {text}
          <span class={styles.bubbleMeta}>five reads it once it has answered</span>
        </div>
      ))}
    </>
  );
}

function Waiting({ until }: { until: string }) {
  const left = Math.max(0, Math.round((Date.parse(until) - Date.now()) / 1000));
  return (
    <p class={styles.waiting}>
      five waits for you · {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')} left
    </p>
  );
}

/** The image view_image attached, from its result: "attached results/images/x.jpg (…)". */
function Attached({ result }: { result: string }) {
  const path = /^attached (\S+) \(/.exec(result)?.[1];
  if (!path) return null;
  return (
    <a href={fileHref(path)} class={styles.attached} title={path}>
      <img src={rawUrl(path)} alt={path} loading="lazy" />
    </a>
  );
}

/**
 * The step in progress, so the page feels alive: a pulsing dot, what the run
 * is doing and for how long, and the model's thinking and reply as they stream in.
 */
function Working({ live }: { live: LiveWork }) {
  const thinking = useRef<HTMLPreElement>(null);
  useLayoutEffect(() => {
    if (thinking.current) thinking.current.scrollTop = thinking.current.scrollHeight;
  }, [live.thinking]);
  const secs = Math.max(0, Math.round((Date.now() - Date.parse(live.startedAt)) / 1000));
  const doing =
    live.phase === 'queued'
      ? 'waiting for a model slot'
      : live.phase === 'tool'
        ? `running ${live.tool}`
        : live.phase === 'code'
          ? 'running its code'
          : live.content
            ? 'writing'
            : live.thinking
              ? 'thinking'
              : 'working';
  return (
    <div class={styles.working} role="status" aria-live="polite">
      <div class={styles.workingHead}>
        <span class={styles.pulse} aria-hidden="true" />
        <span>
          {live.step > 0 && `call ${live.step} · `}
          {doing}… <span class={styles.elapsed}>{secs} s</span>
        </span>
      </div>
      {live.phase === 'model' && live.thinking && (
        <pre ref={thinking} class={styles.liveThinking}>
          {live.thinking}
        </pre>
      )}
      {live.phase === 'model' && live.content && <div class={styles.liveContent}>{live.content}</div>}
    </div>
  );
}

/** When an event happened, at the right edge of its box. */
function At({ iso }: { iso: string }) {
  return <span class={styles.at}>{clock(iso)}</span>;
}

/** What kind of event a line is, and so whose. */
function Kind({ icon }: { icon: IconName }) {
  return (
    <span class={styles.kind}>
      <Icon name={icon} size={14} />
    </span>
  );
}

/** Five's reply in a chat: a bubble on the left, the thinking behind it folded. */
function Answer({ e }: { e: Of<'model'> }) {
  return (
    <div class={styles.five}>
      {e.thinking && (
        <details class={styles.thinking}>
          <summary>Thinking</summary>
          <pre class={styles.pre}>{e.thinking}</pre>
        </details>
      )}
      <Markdown text={e.content ?? ''} class={styles.md} />
      <span class={styles.bubbleMeta}>
        five · {clock(e.at)} · {duration(e.durationMs)}
      </span>
    </div>
  );
}

function Step({ e, results }: { e: Of<'model'>; results: Map<string, Of<'tool'>> }) {
  return (
    <div class={styles.step}>
      <div class={styles.stepHead}>
        <At iso={e.at} />
        call {e.step} · {duration(e.durationMs)}
        {e.waitedMs !== undefined && ` · waited ${duration(e.waitedMs)} for the model`}
        {e.promptTokens !== undefined && ` · ${e.promptTokens.toLocaleString()} tokens in`}
        {e.fromText && ' · calls read from text'}
      </div>
      {e.prompt && (
        <details class={styles.thinking}>
          <summary>Asked</summary>
          <pre class={styles.pre}>{e.prompt}</pre>
        </details>
      )}
      {e.thinking && (
        <details class={styles.thinking}>
          <summary>Thinking</summary>
          <pre class={styles.pre}>{e.thinking}</pre>
        </details>
      )}
      {e.content && !e.fromText && (e.prompt ? <Code class={styles.pre} text={e.content} /> : <Markdown text={e.content} class={styles.md} />)}
      {e.calls.map((c) => {
        const r = results.get(c.id);
        return (
          <details key={c.id} class={styles.tool}>
            <summary>
              <span class={styles.toolName}>{c.name}</span>
              {r && <span class={styles.toolTime}>{duration(r.durationMs)}</span>}
              <span class={`${styles.toolState} ${r && !r.ok ? styles.failed : 'muted'}`}>
                {r ? oneLine(r.result, 120) : 'running…'}
              </span>
              {r && <At iso={r.at} />}
            </summary>
            <Code class={styles.pre} text={prettyArgs(c.arguments)} lang="json" />
            {r && <Code class={styles.pre} text={r.result} />}
            {r && <Attached result={r.result} />}
          </details>
        );
      })}
    </div>
  );
}

/**
 * Where the person chats with five. A message opens the chat — a run of its
 * own, beside the others — or follows in it; five's answers come back in the
 * timeline, and it waits for the person until they leave.
 */
function Composer({ chat }: { chat?: ChatStatus }) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const send = async () => {
    const t = text.trim();
    if (!t || sending) return;
    setSending(true);
    setError(null);
    try {
      await post('/chat', { text: t });
      setText('');
      await refresh();
    } catch (err) {
      setError(message(err));
    } finally {
      setSending(false);
    }
  };
  const leave = async () => {
    setError(null);
    try {
      await post('/chat/leave');
      await refresh();
    } catch (err) {
      setError(message(err));
    }
  };
  const hint = chat?.waitingUntil
    ? 'five is waiting for you'
    : chat?.busy
      ? 'five is answering…'
      : 'chat with five: it answers in a run of its own while the others keep working';
  return (
    <form
      class={styles.composer}
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
    >
      <div class={styles.composerRow}>
        <textarea
          rows={2}
          value={text}
          placeholder="Ask five something, or redirect it…"
          aria-label="Chat with five"
          onInput={(e) => setText(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <div class={styles.composerActions}>
          <button type="submit" class={styles.action} disabled={!text.trim() || sending}>
            <Icon name="send" size={16} />
            Send
          </button>
          {chat && (
            <button
              type="button"
              class={styles.action}
              onClick={() => void leave()}
              title="End the chat: the lead reads it at its next run"
            >
              <Icon name="leave" size={16} />
              Leave chat
            </button>
          )}
        </div>
      </div>
      <span class={styles.composerHint}>
        {chat?.waitingUntil && <span class={styles.pulse} aria-hidden="true" />}
        {hint} · Enter sends, Shift+Enter for a new line
      </span>
      {error && <p class="error">{error}</p>}
    </form>
  );
}
