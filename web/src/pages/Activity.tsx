import { signal } from '@preact/signals';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { type Event, message, post } from '../api/client';
import { Badge, Gauge } from '../components/ui';
import { clock, duration, oneLine, prettyArgs } from '../format';
import { events, loadMoreTurns, refresh, status, turnsLoaded } from '../live';
import { Markdown } from '../markdown';
import styles from './Activity.module.css';

/** The choices of how many turns the page shows, the last first. */
const SHOW = [1, 2, 3, 5, 10, 20, 50];
const shown = signal(readShown());

function readShown(): number {
  try {
    const n = Number(localStorage.getItem('five.showTurns'));
    return SHOW.includes(n) ? n : 3;
  } catch {
    return 3;
  }
}

function setShown(n: number): void {
  shown.value = n;
  try {
    localStorage.setItem('five.showTurns', String(n));
  } catch {
    // Not kept: the default comes back on the next load.
  }
  // The timeline loads 20 turns back at first: load more when asked for more.
  if (n > turnsLoaded.value) void loadMoreTurns(n - turnsLoaded.value);
}

type Of<T extends Event['type']> = Extract<Event, { type: T }>;

interface Turn {
  turn: number;
  started?: Of<'turn_started'>;
  /** Everything after the prompt, in the order it happened, the turn's end among it. */
  items: (Of<'model'> | Of<'context'> | Of<'loop'> | Of<'inbox'> | Of<'supervisor'> | Of<'turn_ended'>)[];
  /** Tool results by call id. */
  results: Map<string, Of<'tool'>>;
}

/** The events, grouped by turn, oldest first. */
function group(list: Event[]): Turn[] {
  const turns: Turn[] = [];
  let cur: Turn | undefined;
  for (const e of list) {
    if (!cur || cur.turn !== e.turn) {
      cur = { turn: e.turn, items: [], results: new Map() };
      turns.push(cur);
    }
    if (e.type === 'turn_started') cur.started = e;
    else if (e.type === 'tool') cur.results.set(e.id, e);
    else cur.items.push(e);
  }
  return turns;
}

/** The loop as it runs: its controls, then every turn, newest at the bottom, followed as it grows. */
export function Activity() {
  const turns = useMemo(() => group(events.value), [events.value]);
  const bottom = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useLayoutEffect(() => {
    if (stick.current) bottom.current?.scrollIntoView({ block: 'end' });
  }, [events.value.length]);
  useEffect(() => {
    const onScroll = () => {
      const b = bottom.current?.getBoundingClientRect();
      if (b) stick.current = b.bottom <= window.innerHeight + 120;
    };
    window.addEventListener('scroll', onScroll, true);
    return () => window.removeEventListener('scroll', onScroll, true);
  }, []);

  const visible = turns.slice(-shown.value);
  const hidden = (visible[0]?.turn ?? 0) - 1;
  const more = SHOW.find((n) => n > shown.value);
  return (
    <div class={styles.page}>
      <Controls />
      {hidden > 0 && more && (
        <button type="button" class={styles.more} onClick={() => setShown(more)}>
          {hidden} earlier {hidden === 1 ? 'turn' : 'turns'} hidden · show the last {more}
        </button>
      )}
      {turns.length === 0 && <p class="muted">No turns yet. Start the loop, or run one step.</p>}
      {visible.map((t) => (
        <TurnView key={t.turn} t={t} />
      ))}
      <div ref={bottom} />
    </div>
  );
}

function Controls() {
  const s = status.value;
  const [error, setError] = useState<string | null>(null);
  if (!s) return null;
  const { loop } = s;
  const act = async (what: 'start' | 'pause' | 'stop' | 'step') => {
    setError(null);
    try {
      await post(`/loop/${what}`);
      await refresh();
    } catch (err) {
      setError(message(err));
    }
  };
  const used = loop.promptTokens ?? 0;
  const facts = [
    loop.busy ? `step ${loop.step} of ${s.maxSteps}` : loop.running ? 'between turns' : 'paused',
    `${s.messages} messages`,
    loop.promptTokens === null
      ? 'context not measured yet'
      : `${used.toLocaleString()} of ${s.contextTokens.toLocaleString()} tokens`,
  ];
  return (
    <header class={styles.bar}>
      <Gauge value={used} max={s.contextTokens} warnAt={s.contextTokens * 0.8} label="Context window used" />
      <div class={styles.title}>
        <h2>
          Turn {loop.turn} · {s.model}
          {s.think && ' · thinking'}
        </h2>
        <span class="muted">{facts.join(' · ')}</span>
      </div>
      <div class={styles.actions}>
        <ShownTurns />
        {loop.retryAt && <Badge state="warn">retry at {clock(loop.retryAt)}</Badge>}
        {loop.running ? (
          <button type="button" class={styles.action} onClick={() => void act('pause')} title="Stop looping once this turn ends">
            Pause
          </button>
        ) : (
          <button type="button" class={styles.action} onClick={() => void act('start')}>
            Start
          </button>
        )}
        {!loop.running && !loop.busy && (
          <button type="button" class={styles.action} onClick={() => void act('step')} title="Run one turn">
            Step
          </button>
        )}
        {loop.busy && (
          <button
            type="button"
            class={styles.action}
            onClick={() => void act('stop')}
            title="Pause, and end this turn now"
          >
            Stop turn
          </button>
        )}
      </div>
      {error && <p class="error">{error}</p>}
    </header>
  );
}

/** ‹ last N turns ›: how much of the timeline the page shows. */
function ShownTurns() {
  const i = SHOW.indexOf(shown.value);
  const n = shown.value;
  return (
    <div class={styles.stepper} role="group" aria-label="Turns shown">
      <button type="button" disabled={i <= 0} onClick={() => setShown(SHOW[i - 1] as number)} aria-label="Fewer turns">
        ‹
      </button>
      <span>
        last {n} {n === 1 ? 'turn' : 'turns'}
      </span>
      <button
        type="button"
        disabled={i >= SHOW.length - 1}
        onClick={() => setShown(SHOW[i + 1] as number)}
        aria-label="More turns"
      >
        ›
      </button>
    </div>
  );
}

function TurnView({ t }: { t: Turn }) {
  const prompt = t.started?.prompt;
  return (
    <section class={styles.turn} aria-label={`Turn ${t.turn}`}>
      {t.started && (
        <header class={styles.turnHead}>
          <span class={styles.turnNo}>Turn {t.turn}</span>
          <At iso={t.started.at} />
        </header>
      )}
      {t.started?.warning && (
        <p class={`${styles.line} ${styles.warn}`}>
          <At iso={t.started.at} />⚠ {t.started.warning}
        </p>
      )}
      {prompt !== undefined && <div class={styles.prompt}>{prompt}</div>}
      {t.items.map((e) => {
        switch (e.type) {
          case 'model':
            return <Step key={e.seq} e={e} results={t.results} />;
          case 'context':
            return (
              <p key={e.seq} class={styles.line}>
                <At iso={e.at} />✎ {e.by === 'user' ? 'you' : e.by === 'five' ? 'five' : 'the agent'}: {e.change}
              </p>
            );
          case 'inbox':
            return (
              <p key={e.seq} class={`${styles.line} ${styles.inbox}`}>
                <At iso={e.at} />✉ {e.from === 'five' ? 'to you' : 'you wrote'}: {oneLine(e.text, 240)} ·{' '}
                <a href="/inbox">inbox</a>
              </p>
            );
          case 'supervisor':
            return (
              <p key={e.seq} class={styles.line}>
                <At iso={e.at} />⚙ <a href="/config">config</a>: {e.change}
              </p>
            );
          case 'turn_ended':
            return (
              <p key={e.seq} class={`${styles.end} ${e.reason === 'error' ? styles.failed : ''}`}>
                <At iso={e.at} />
                <span>
                  Turn {t.turn} ended: {endLabel[e.reason]}
                  {e.error && ` — ${e.error}`}
                  {t.started && ` · ${duration(Date.parse(e.at) - Date.parse(t.started.at))}`}
                </span>
                {prompt !== undefined && (
                  <span class={styles.next}>
                    {e.next === prompt ? 'next turn: same prompt' : `next prompt: ${oneLine(e.next, 160)}`}
                  </span>
                )}
              </p>
            );
          case 'loop':
            return (
              <p key={e.seq} class={styles.line}>
                <At iso={e.at} />
                Loop {e.state}
                {e.reason && `: ${e.reason}`}
              </p>
            );
        }
      })}
    </section>
  );
}

/** When an event happened, at the right edge of its box. */
function At({ iso }: { iso: string }) {
  return <span class={styles.at}>{clock(iso)}</span>;
}

const endLabel: Record<Of<'turn_ended'>['reason'], string> = {
  replied: 'the agent replied',
  end_turn: 'the agent called end_turn',
  max_steps: 'out of steps',
  stopped: 'stopped',
  error: 'failed',
};

function Step({ e, results }: { e: Of<'model'>; results: Map<string, Of<'tool'>> }) {
  return (
    <div class={styles.step}>
      <div class={styles.stepHead}>
        <At iso={e.at} />
        step {e.step} · {duration(e.durationMs)}
        {e.promptTokens !== undefined && ` · ${e.promptTokens.toLocaleString()} prompt tokens`}
        {e.fromText && ' · calls read from text'}
      </div>
      {e.thinking && (
        <details class={styles.thinking}>
          <summary>Thinking</summary>
          <pre class={styles.pre}>{e.thinking}</pre>
        </details>
      )}
      {e.content && !e.fromText && <Markdown text={e.content} class={styles.md} />}
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
            <pre class={styles.pre}>{prettyArgs(c.arguments)}</pre>
            {r && <pre class={styles.pre}>{r.result}</pre>}
          </details>
        );
      })}
    </div>
  );
}
