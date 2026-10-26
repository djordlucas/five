import { useEffect, useState } from 'preact/hooks';
import { get, message, type ToolDetail, type ToolInfo } from '../api/client';
import { Badge, ui } from '../components/ui';
import { ago, pretty } from '../format';
import { status } from '../live';
import styles from './Tools.module.css';

/** The tools the agent built, and one tool's definition and source. */
export function Tools({ name }: { name?: string }) {
  const [tools, setTools] = useState<ToolInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const count = status.value?.tools;

  useEffect(() => {
    get<{ tools: ToolInfo[] }>('/tools').then(
      (r) => setTools(r.tools),
      (err: unknown) => setError(message(err)),
    );
  }, [count]);

  if (name) return <Tool name={name} />;
  return (
    <div class={styles.page}>
      {error && <p class="error">{error}</p>}
      {tools?.length === 0 && <p class="muted">The agent has not built any tools yet.</p>}
      <ul class={styles.list}>
        {tools?.map((t) => (
          <li key={t.name}>
            <a class={styles.item} href={`/workspace/tools/${t.name}`}>
              <span class={styles.name}>{t.name}</span>
              <span class="muted">
                r{t.revision} · {ago(t.updatedAt)}
              </span>
              {t.disabled && <Badge state="disabled">disabled</Badge>}
              <span class={styles.desc}>{t.description}</span>
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Tool({ name }: { name: string }) {
  const [tool, setTool] = useState<ToolDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    get<ToolDetail>(`/tools/${encodeURIComponent(name)}`).then(setTool, (err: unknown) => setError(message(err)));
  }, [name]);
  return (
    <div class={styles.page}>
      <a href="/workspace/tools">← All tools</a>
      {error && <p class="error">{error}</p>}
      {tool && (
        <>
          <h2 class={styles.name}>
            {tool.name} <span class="muted">r{tool.revision}</span>
          </h2>
          {tool.disabled && (
            <p>
              <Badge state="disabled">disabled</Badge> {tool.disabled.reason}
            </p>
          )}
          <p>{tool.description}</p>
          <h3>Parameters</h3>
          <pre class={ui.pre}>{pretty(tool.parameters)}</pre>
          <h3>Source</h3>
          <pre class={ui.pre}>{tool.source}</pre>
        </>
      )}
    </div>
  );
}
