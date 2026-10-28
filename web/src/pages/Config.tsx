import { useEffect, useState } from 'preact/hooks';
import { del, get, message, put, type SettingField, type Settings, type SettingsView } from '../api/client';
import { status } from '../live';
import { Icon } from '../components/Icon';
import type { IconName } from '../sections';
import styles from './Config.module.css';

type Draft = Partial<Record<keyof Settings, number | boolean>>;

/**
 * Five's goal, and how it schedules its workers: change them while it runs. A
 * change applies at the next decision and is kept across restarts; the
 * defaults come from the environment.
 */
export function Config() {
  const [view, setView] = useState<SettingsView | null>(null);
  const [draft, setDraft] = useState<Draft>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    get<SettingsView>('/settings').then(setView, (err: unknown) => setError(message(err)));
  }, []);

  const act = async (fn: () => Promise<SettingsView>) => {
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
  const set = (key: keyof Settings, value: number | boolean) => {
    const next = { ...draft };
    if (value === view.settings[key]) delete next[key];
    else next[key] = value;
    setDraft(next);
  };

  return (
    <div class={styles.page}>
      <Goal />
      <p class={`card muted ${styles.intro}`}>
        How five schedules its workers. A change applies at the next decision, and is kept across restarts.
      </p>

      {groups.map((g) => (
        <section key={g} class={`card ${styles.group}`} aria-label={g}>
          <h2>
            <Icon name={groupIcons[g] ?? 'config'} size={18} />
            {g}
          </h2>
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
            if (confirm('Put every setting back to its default?')) void act(() => del<SettingsView>('/settings'));
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
          onClick={() => void act(() => put<SettingsView>('/settings', draft))}
        >
          {saving ? 'Saving…' : `Apply${dirty ? ` (${Object.keys(draft).length})` : ''}`}
        </button>
      </div>
    </div>
  );
}

/** An icon for each group of settings. */
const groupIcons: Record<string, IconName> = {
  Model: 'chip',
  Workers: 'layers',
  Runs: 'clock',
  Chat: 'chat',
};

/** The goal every worker's work is for: the lead plans from it, and may sharpen it. */
function Goal() {
  const goal = status.value?.goal ?? '';
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const editing = text !== null;
  const save = async () => {
    try {
      await put('/goal', { goal: text });
      setText(null);
      setError(null);
    } catch (err) {
      setError(message(err));
    }
  };
  return (
    <section class={`card ${styles.group}`} aria-label="Goal">
      <h2>
        <Icon name="flag" size={18} />
        Goal
      </h2>
      {editing ? (
        <textarea class={styles.goal} rows={5} value={text} onInput={(e) => setText(e.currentTarget.value)} />
      ) : (
        <p class={styles.goalText}>{goal}</p>
      )}
      <div class={styles.goalActions}>
        {error && <p class="error">{error}</p>}
        {editing ? (
          <>
            <button type="button" class={styles.action} onClick={() => setText(null)}>
              Discard
            </button>
            <button type="button" class="button" disabled={!text?.trim() || text === goal} onClick={() => void save()}>
              Set the goal
            </button>
          </>
        ) : (
          <button type="button" class={styles.action} onClick={() => setText(goal)}>
            <Icon name="edit" size={16} />
            Change
          </button>
        )}
      </div>
    </section>
  );
}

function Row(props: {
  f: SettingField;
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

function show(v: number | boolean, f: SettingField): string {
  if (typeof v === 'boolean') return v ? 'on' : 'off';
  return f.unit ? `${v} ${f.unit}` : String(v);
}
