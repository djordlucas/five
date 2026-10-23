import { useEffect, useState } from 'preact/hooks';
import { type ContextView, del, get, type Message, message, post, put } from '../api/client';
import { prettyArgs } from '../format';
import { refresh, status } from '../live';
import styles from './Context.module.css';

/**
 * Everything the agent is sent, as it stands: the system prompt, the next
 * prompt and every message. While the loop is paused and no turn runs, each
 * can be changed here.
 */
export function Context() {
  const [ctx, setCtx] = useState<ContextView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lastSeq = status.value?.lastSeq;
  const busy = status.value?.loop.busy ?? false;
  const locked = busy || (status.value?.loop.running ?? false);

  // Reload whenever something happened.
  useEffect(() => {
    get<ContextView>('/context').then(setCtx, (err: unknown) => setError(message(err)));
  }, [lastSeq]);

  const change = async (fn: () => Promise<ContextView>) => {
    setError(null);
    try {
      setCtx(await fn());
      await refresh();
      return true;
    } catch (err) {
      setError(message(err));
      return false;
    }
  };

  if (!ctx) return error ? <p class="error">{error}</p> : null;
  return (
    <div class={styles.page}>
      {locked && (
        <p class={`card muted ${styles.note}`}>
          {busy ? 'A turn is running.' : 'The loop is running.'} Pause it, and let the turn end, to change the context.
        </p>
      )}
      {error && <p class="error">{error}</p>}

      <Field
        label="Next prompt"
        hint="The user message that starts the next turn."
        value={ctx.next}
        rows={3}
        locked={locked}
        onSave={(text) => change(() => put('/context/next', { text }))}
      />
      <Field
        label="System prompt"
        hint={`${ctx.system.length.toLocaleString()} characters`}
        value={ctx.system}
        rows={14}
        locked={locked}
        onSave={(text) => change(() => put('/context/system', { text }))}
      />

      <section class={styles.messages} aria-label="Messages">
        <h2>
          Messages <span class="muted">{ctx.messages.length}</span>
        </h2>
        {ctx.messages.length === 0 && <p class="muted">None yet.</p>}
        <ol class={styles.list}>
          {ctx.messages.map((m, i) => (
            <MessageRow
              // The content keys the row so an edit form starts from the current text.
              key={`${i}:${m.content ?? ''}`}
              index={i}
              m={m}
              locked={locked}
              onSave={(content) => change(() => put(`/context/messages/${i}`, { content }))}
              onDelete={() => change(() => del(`/context/messages/${i}`))}
            />
          ))}
        </ol>
      </section>

      <Reset locked={locked} onReset={(clean) => change(() => post('/context/reset', { clean }))} />
    </div>
  );
}

function Field(props: {
  label: string;
  hint: string;
  value: string;
  rows: number;
  locked: boolean;
  onSave: (text: string) => Promise<boolean>;
}) {
  const [text, setText] = useState(props.value);
  const [saving, setSaving] = useState(false);
  const dirty = text !== props.value;
  // Follow the agent's changes unless there is an unsaved edit.
  useEffect(() => {
    if (!dirty) setText(props.value);
  }, [props.value]);

  return (
    <section class={`card ${styles.field}`}>
      <div class={styles.fieldHead}>
        <h2>{props.label}</h2>
        <span class="muted">{props.hint}</span>
      </div>
      <textarea
        class={styles.text}
        rows={props.rows}
        value={text}
        aria-label={props.label}
        onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
      />
      {dirty && (
        <div class={styles.row}>
          <button type="button" class={styles.action} onClick={() => setText(props.value)}>
            Discard
          </button>
          <button
            type="button"
            class="button"
            disabled={props.locked || saving || !text.trim()}
            onClick={async () => {
              setSaving(true);
              await props.onSave(text);
              setSaving(false);
            }}
          >
            Save
          </button>
        </div>
      )}
    </section>
  );
}

function MessageRow(props: {
  index: number;
  m: Message;
  locked: boolean;
  onSave: (content: string) => Promise<boolean>;
  onDelete: () => void;
}) {
  const { m, index } = props;
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(m.content ?? '');
  const calls = m.role === 'assistant' ? (m.tool_calls ?? []) : [];

  return (
    <li class={`${styles.message} ${styles[m.role] ?? ''}`}>
      <div class={styles.messageHead}>
        <span class={styles.index}>[{index}]</span>
        <span class={styles.role}>{m.role === 'tool' ? `tool · ${m.name}` : m.role}</span>
        <span class={styles.spacer} />
        {!editing && (
          <>
            <button type="button" class={styles.small} disabled={props.locked} onClick={() => setEditing(true)}>
              Edit
            </button>
            <button
              type="button"
              class={`${styles.small} ${styles.danger}`}
              disabled={props.locked}
              onClick={props.onDelete}
            >
              Delete
            </button>
          </>
        )}
      </div>
      {editing ? (
        <>
          <textarea
            class={styles.text}
            rows={Math.min(16, Math.max(3, text.split('\n').length + 1))}
            value={text}
            aria-label={`Message ${index}`}
            onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
          />
          <div class={styles.row}>
            <button type="button" class={styles.action} onClick={() => setEditing(false)}>
              Cancel
            </button>
            <button
              type="button"
              class="button"
              disabled={props.locked}
              onClick={async () => {
                if (await props.onSave(text)) setEditing(false);
              }}
            >
              Save
            </button>
          </div>
        </>
      ) : (
        m.content && <pre class={styles.content}>{m.content}</pre>
      )}
      {calls.map((c) => (
        <details key={c.id} class={styles.call}>
          <summary>
            calls <code>{c.function.name}</code>
          </summary>
          <pre class={styles.content}>{prettyArgs(c.function.arguments)}</pre>
        </details>
      ))}
    </li>
  );
}

function Reset({ locked, onReset }: { locked: boolean; onReset: (clean: boolean) => void }) {
  const [sure, setSure] = useState(false);
  const [clean, setClean] = useState(true);
  return (
    <section class={`card ${styles.reset}`}>
      <div>
        <h2>Start over</h2>
        <p class="muted">The seed system prompt and prompt, no messages, turn 0, and the timeline cleared.</p>
      </div>
      {sure ? (
        <div class={styles.row}>
          <label class={styles.check}>
            <input type="checkbox" checked={clean} onChange={(e) => setClean((e.target as HTMLInputElement).checked)} />
            Also delete its tools and workspace files
          </label>
          <button type="button" class={styles.action} onClick={() => setSure(false)}>
            Cancel
          </button>
          <button
            type="button"
            class={`button ${styles.dangerButton}`}
            disabled={locked}
            onClick={() => {
              setSure(false);
              onReset(clean);
            }}
          >
            Reset the context
          </button>
        </div>
      ) : (
        <button type="button" class={`${styles.action} ${styles.danger}`} disabled={locked} onClick={() => setSure(true)}>
          Reset…
        </button>
      )}
    </section>
  );
}
