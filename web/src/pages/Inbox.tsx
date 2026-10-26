import { useEffect, useState } from 'preact/hooks';
import { get, type InboxMessage, type InboxPage, message, post } from '../api/client';
import { Icon } from '../components/Icon';
import { ui } from '../components/ui';
import { ago, clock } from '../format';
import { markInboxSeen, status } from '../live';
import { Markdown } from '../markdown';
import styles from './Inbox.module.css';

/**
 * The messages between five and you: what the agent chose to tell you with
 * message_person, and what you wrote back, newest first. A message you send is
 * put before the prompt of the next turn, or, sent as the next prompt, is that
 * prompt; the loop never waits for one.
 */
export function Inbox() {
  const [list, setList] = useState<InboxMessage[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const last = status.value?.inboxLast ?? 0;
  const turn = status.value?.loop.turn ?? 0;

  const load = () =>
    get<InboxPage>('/inbox').then(
      (r) => {
        setList(r.messages);
        setError(null);
      },
      (err: unknown) => setError(message(err)),
    );

  // Reload when five sends one, and as turns pass: a delivery shows then.
  useEffect(() => {
    void load();
  }, [last, turn]);
  useEffect(() => markInboxSeen(last), [last]);

  const send = async (asPrompt = false) => {
    setSending(true);
    try {
      await post<InboxMessage>('/inbox', { text: text.trim(), ...(asPrompt && { asPrompt }) });
      setText('');
      await load();
    } catch (err) {
      setError(message(err));
    } finally {
      setSending(false);
    }
  };

  return (
    <div class={styles.page}>
      <form
        class={`card ${styles.compose}`}
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim() && !sending) void send();
        }}
      >
        <textarea
          class={styles.text}
          rows={3}
          value={text}
          placeholder="Write to five. It reads this before its next turn, and goes on with its own work."
          aria-label="Message to five"
          onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && text.trim() && !sending) void send();
          }}
        />
        <div class={styles.row}>
          <span class="muted">⌘↩ sends</span>
          <span class={styles.actions}>
            <button
              type="button"
              class={ui.action}
              disabled={sending || !text.trim()}
              onClick={() => void send(true)}
              title="The next turn starts with this message as its prompt, in place of the one the agent set"
            >
              <Icon name="next" size={16} />
              Send as next prompt
            </button>
            <button type="submit" class="button" disabled={sending || !text.trim()}>
              {sending ? 'Sending…' : 'Send'}
            </button>
          </span>
        </div>
      </form>

      {error && <p class="error">{error}</p>}
      {list === null && <p class="muted">Loading…</p>}
      {list?.length === 0 && (
        <p class="card muted">No messages yet. The agent writes here with message_person, at most once a turn.</p>
      )}
      <ol class={styles.list}>
        {list?.map((m) => (
          <li key={m.id} class={`card ${styles.msg} ${m.from === 'person' ? styles.mine : ''}`}>
            <header class={styles.head}>
              <strong>{m.from === 'five' ? 'five' : 'you'}</strong>
              <span class="muted">
                turn {m.turn} · {clock(m.at)} · {ago(m.at)}
              </span>
              {m.from === 'person' && (
                <span class="muted">
                  {m.asPrompt
                    ? m.deliveredTurn
                      ? `turn ${m.deliveredTurn}'s prompt`
                      : 'the next turn\'s prompt'
                    : m.deliveredTurn
                      ? `read before turn ${m.deliveredTurn}`
                      : 'goes before the next turn'}
                </span>
              )}
            </header>
            {m.subject && <h2 class={styles.subject}>{m.subject}</h2>}
            <Markdown text={m.text} class={styles.body} />
          </li>
        ))}
      </ol>
    </div>
  );
}
