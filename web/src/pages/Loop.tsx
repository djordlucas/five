import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { type Event, message, post } from '../api/client';
import { Badge, Meter } from '../components/ui';
import { clock, duration, oneLine, prettyArgs } from '../format';
import { events, loadMoreTurns, refresh, status } from '../live';
import { Markdown } from '../markdown';
import styles from './Loop.module.css';

type Of<T extends Event['type']> = Extract<Event, { type: T }>;

interface Turn {
  turn: number;
  started?: Of<'turn_started'>;
  items: (Of<'model'> | Of<'context'> | Of<'loop'>)[];
  ended?: Of<'turn_ended'>;
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
    else if (e.type === 'turn_ended') cur.ended = e;
    else if (e.type === 'tool') cur.results.set(e.id, e);
    else cur.items.push(e);
  }
  return turns;
}

/** The loop as it runs: its controls, then every turn, newest at the bottom, followed as it grows. */
export function Loop() {
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

  const first = turns[0]?.turn ?? 0;
  return (
    <div class={styles.page}>
      <Controls />
      {first > 1 && (
        <button type="button" class={styles.more} onClick={() => void loadMoreTurns()}>
          Show 20 earlier turns
        </button>
      )}
      {turns.length === 0 && <p class="muted">No turns yet. Start the loop, or run one step.</p>}
      {turns.map((t) => (
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
  return (
    <div class={`card ${styles.controls}`}>
      <div class={styles.buttons}>
        {loop.running ? (
          <button type="button" class="button" onClick={() => void act('pause')} title="Stop looping once this turn ends">
            Pause
          </button>
        ) : (
          <button type="button" class="button" onClick={() => void act('start')}>
            Start
          </button>
        )}
        <button
          type="button"
          class={styles.action}
          disabled={loop.running || loop.busy}
          onClick={() => void act('step')}
          title="Run one turn"
        >
          Step
        </button>
        <button
          type="button"
          class={`${styles.action} ${styles.danger}`}
          disabled={!loop.busy}
          onClick={() => void act('stop')}
          title="Pause, and end this turn now"
        >
          Stop turn
        </button>
      </div>
      <div class={styles.facts}>
        <span>
          {s.model}
          {s.think && ' · thinking'}
        </span>
        <span>
          turn {loop.turn}
          {loop.busy && ` · step ${loop.step} of ${s.maxSteps}`}
        </span>
        <span>{s.messages} messages</span>
        {loop.retryAt && <Badge state="warn">retry at {clock(loop.retryAt)}</Badge>}
      </div>
      <div class={styles.window}>
        <Meter value={used} max={s.contextTokens} warnAt={s.contextTokens * 0.8} label="Context window used" />
        <span class="muted">
          {loop.promptTokens === null ? 'context not measured yet' : `${used.toLocaleString()} of ${s.contextTokens.toLocaleString()} tokens`}
        </span>
      </div>
      {error && <p class="error">{error}</p>}
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
          <span class="muted">{clock(t.started.at)}</span>
        </header>
      )}
      {t.started?.warning && <p class={`${styles.line} ${styles.warn}`}>⚠ {t.started.warning}</p>}
      {prompt !== undefined && <div class={styles.prompt}>{prompt}</div>}
      {t.items.map((e) => {
        switch (e.type) {
          case 'model':
            return <Step key={e.seq} e={e} results={t.results} />;
          case 'context':
            return (
              <p key={e.seq} class={styles.line}>
                ✎ {e.by === 'user' ? 'you' : e.by === 'five' ? 'five' : 'the agent'}: {e.change}
              </p>
            );
          case 'loop':
            return (
              <p key={e.seq} class={styles.line}>
                Loop {e.state}
                {e.reason && `: ${e.reason}`} · {clock(e.at)}
              </p>
            );
        }
      })}
      {t.ended && (
        <p class={`${styles.end} ${t.ended.reason === 'error' ? styles.failed : ''}`}>
          Turn {t.turn} ended: {endLabel[t.ended.reason]}
          {t.ended.error && ` — ${t.ended.error}`}
          {prompt !== undefined && (
            <span class={styles.next}>
              {t.ended.next === prompt ? 'next turn: same prompt' : `next prompt: ${oneLine(t.ended.next, 160)}`}
            </span>
          )}
        </p>
      )}
    </section>
  );
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
              <span class={`${styles.toolState} ${r && !r.ok ? styles.failed : 'muted'}`}>
                {r ? oneLine(r.result, 120) : 'running…'}
              </span>
            </summary>
            <pre class={styles.pre}>{prettyArgs(c.arguments)}</pre>
            {r && <pre class={styles.pre}>{r.result}</pre>}
          </details>
        );
      })}
    </div>
  );
}
