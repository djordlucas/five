import { useEffect, useState } from 'preact/hooks';
import { del, get, message, put, type SupervisorField, type SupervisorSettings, type SupervisorView } from '../api/client';
import { status } from '../live';
import styles from './Config.module.css';

type Draft = Partial<Record<keyof SupervisorSettings, number | boolean>>;

/**
 * Every way five steps into the loop, and its settings: change them while the
 * loop runs. A change applies from the next time it is checked — most at the
 * next turn — and is kept across restarts; the defaults come from the
 * environment.
 */
export function Config() {
  const [view, setView] = useState<SupervisorView | null>(null);
  const [draft, setDraft] = useState<Draft>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Reloaded as turns pass, for the counts.
  const turn = status.value?.loop.turn;

  useEffect(() => {
    get<SupervisorView>('/supervisor').then(setView, (err: unknown) => setError(message(err)));
  }, [turn]);

  const act = async (fn: () => Promise<SupervisorView>) => {
    setSaving(true);
    try {
      setView(await fn());
      setDraft({});
      setError(null);
    } catch (err) {
      setError(message(err));
    } finally {
      setSaving(false);
    }
  };

  if (!view) return error ? <p class="card error">{error}</p> : <p class="card muted">Loading…</p>;
  const dirty = Object.keys(draft).length > 0;
  const groups = [...new Set(view.fields.map((f) => f.group))];
  const set = (key: keyof SupervisorSettings, value: number | boolean) => {
    const next = { ...draft };
    if (value === view.settings[key]) delete next[key];
    else next[key] = value;
    setDraft(next);
  };

  return (
    <div class={styles.page}>
      <p class={`card muted ${styles.intro}`}>
        How five steps into the agent's loop. A change applies from the next time it is checked — most at the next turn
        — and is kept across restarts. Now: {count(view.state.idle, 'idle turn')} in a row; the next prompt unchanged for{' '}
        {count(view.state.stale, 'turn')}.
      </p>

      {groups.map((g) => (
        <section key={g} class={`card ${styles.group}`} aria-label={g}>
          <h2>{g}</h2>
          {view.fields
            .filter((f) => f.group === g)
            .map((f) => (
              <Row
                key={f.key}
                f={f}
                value={draft[f.key] ?? view.settings[f.key]}
                fallback={view.defaults[f.key]}
                changed={view.changed.includes(f.key)}
                edited={f.key in draft}
                onChange={(v) => set(f.key, v)}
              />
            ))}
        </section>
      ))}

      <div class={styles.bar}>
        {error && <p class="error">{error}</p>}
        <button
          type="button"
          class={styles.action}
          disabled={saving || view.changed.length === 0}
          onClick={() => {
            if (confirm('Put every setting back to its default?')) void act(() => del<SupervisorView>('/supervisor'));
          }}
        >
          Reset to defaults
        </button>
        <span class={styles.grow} />
        <button type="button" class={styles.action} disabled={!dirty || saving} onClick={() => setDraft({})}>
          Discard
        </button>
        <button
          type="button"
          class="button"
          disabled={!dirty || saving}
          onClick={() => void act(() => put<SupervisorView>('/supervisor', draft))}
        >
          {saving ? 'Saving…' : `Apply${dirty ? ` (${Object.keys(draft).length})` : ''}`}
        </button>
      </div>
    </div>
  );
}

function Row(props: {
  f: SupervisorField;
  value: number | boolean;
  fallback: number | boolean;
  changed: boolean;
  edited: boolean;
  onChange: (v: number | boolean) => void;
}) {
  const { f, value, fallback } = props;
  const id = `sv-${f.key}`;
  return (
    <div class={`${styles.row} ${props.edited ? styles.edited : ''}`}>
      <div class={styles.text}>
        <label for={id} class={styles.label}>
          {f.label}
          {props.changed && (
            <span class={styles.changed} title="Changed from its default">
              changed · default {show(fallback, f)}
            </span>
          )}
        </label>
        <span class="muted">{f.help}</span>
      </div>
      {typeof value === 'boolean' ? (
        <input
          id={id}
          type="checkbox"
          class={styles.check}
          checked={value}
          onChange={(e) => props.onChange((e.target as HTMLInputElement).checked)}
        />
      ) : (
        <span class={styles.number}>
          <input
            id={id}
            type="number"
            class="input"
            min={f.min}
            max={f.max}
            step={1}
            value={value}
            onInput={(e) => {
              const n = Number((e.target as HTMLInputElement).value);
              if (Number.isInteger(n)) props.onChange(n);
            }}
          />
          {f.unit && <span class="muted">{f.unit}</span>}
        </span>
      )}
    </div>
  );
}

function show(v: number | boolean, f: SupervisorField): string {
  if (typeof v === 'boolean') return v ? 'on' : 'off';
  return f.unit ? `${v} ${f.unit}` : String(v);
}

function count(n: number, what: string): string {
  return `${n} ${what}${n === 1 ? '' : 's'}`;
}
