import { useEffect, useState } from 'preact/hooks';
import { get, message, type ToolDetail, type ToolInfo } from '../api/client';
import { Code } from '../code';
import { Badge, ui } from '../components/ui';
import { ago, pretty } from '../format';
import { status } from '../live';
import { Icon } from '../components/Icon';
import browse from './Workspace.module.css';
import styles from './Tools.module.css';

type Show = 'all' | 'enabled' | 'disabled';
type Sort = 'name' | 'newest' | 'revised';

const SHOWS: { value: Show; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'enabled', label: 'Enabled' },
  { value: 'disabled', label: 'Disabled' },
];

/** The tools the agent built, as a grid to search, filter and sort; and one tool's definition and source. */
export function Tools({ name }: { name?: string }) {
  const [tools, setTools] = useState<ToolInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [show, setShow] = useState<Show>('all');
  const [sort, setSort] = useState<Sort>('name');
  const count = status.value?.tools;

  useEffect(() => {
    get<{ tools: ToolInfo[] }>('/tools').then(
      (r) => setTools(r.tools),
      (err: unknown) => setError(message(err)),
    );
  }, [count]);

  if (name) return <Tool name={name} />;
  const all = tools ?? [];
  const needle = search.trim().toLowerCase();
  const shown = all
    .filter(
      (t) =>
        (show === 'all' || (show === 'disabled') === Boolean(t.disabled)) &&
        (!needle || t.name.toLowerCase().includes(needle) || t.description.toLowerCase().includes(needle)),
    )
    .sort((a, b) =>
      sort === 'newest'
        ? Date.parse(b.updatedAt) - Date.parse(a.updatedAt)
        : sort === 'revised'
          ? b.revision - a.revision || a.name.localeCompare(b.name)
          : a.name.localeCompare(b.name),
    );
  const disabled = all.filter((t) => t.disabled).length;
  const counts = { all: all.length, enabled: all.length - disabled, disabled };

  return (
    <section class={browse.browser} aria-label="Tools">
      <div class={browse.filters}>
        <label class={browse.search}>
          <Icon name="search" size={16} />
          <input
            type="search"
            placeholder="Search names and descriptions"
            value={search}
            aria-label="Search tools"
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
        <label class={browse.sort}>
          Sort
          <select value={sort} onChange={(e) => setSort(e.currentTarget.value as Sort)}>
            <option value="name">Name</option>
            <option value="newest">Recently changed</option>
            <option value="revised">Most revised</option>
          </select>
        </label>
      </div>

      {error && <p class="error">{error}</p>}
      {tools?.length === 0 && <p class="muted">The agent has not built any tools yet.</p>}
      {all.length > 0 && shown.length === 0 && <p class="muted">No tool matches.</p>}
      <ul class={styles.cards}>
        {shown.map((t) => (
          <li key={t.name}>
            <a class={styles.card} href={`/workspace/tools/${t.name}`} data-disabled={t.disabled ? '' : undefined}>
              <span class={styles.icon}>
                <Icon name="tool" size={20} />
              </span>
              <span class={styles.name}>{t.name}</span>
              <span class={styles.meta} title={new Date(t.updatedAt).toLocaleString()}>
                r{t.revision} · {ago(t.updatedAt)}
                {t.libs?.length ? ` · ${t.libs.map((l) => `lib:${l.name}`).join(', ')}` : ''}
                {t.libs?.some((l) => l.current !== undefined && l.current !== l.revision) && (
                  <>
                    {' '}
                    <Badge state="warn">behind</Badge>
                  </>
                )}
                {t.disabled && (
                  <>
                    {' '}
                    <Badge state="disabled">disabled</Badge>
                  </>
                )}
              </span>
              <span class={styles.desc}>{t.description}</span>
            </a>
          </li>
        ))}
      </ul>
    </section>
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
          <h2 class={styles.title}>
            {tool.name} <span class="muted">r{tool.revision}</span>
          </h2>
          {tool.disabled && (
            <p>
              <Badge state="disabled">disabled</Badge> {tool.disabled.reason}
            </p>
          )}
          <p>{tool.description}</p>
          {tool.libs && tool.libs.length > 0 && (
            <>
              <h3>Libraries bundled in</h3>
              <ul class={styles.links}>
                {tool.libs.map((l) => (
                  <li key={l.name}>
                    <a href={`/workspace/libraries/${l.name}`}>lib:{l.name}</a> <span class="muted">r{l.revision}</span>{' '}
                    {l.current === undefined ? (
                      <Badge state="disabled">deleted since</Badge>
                    ) : l.current === l.revision ? (
                      <Badge state="ok">current</Badge>
                    ) : (
                      <Badge state="warn">r{l.current} now: rebuild_tool updates it</Badge>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
          <h3>Parameters</h3>
          <Code class={ui.pre} text={pretty(tool.parameters)} lang="json" />
          <h3>Source</h3>
          <Code class={ui.pre} text={tool.source} lang="js" />
        </>
      )}
    </div>
  );
}
