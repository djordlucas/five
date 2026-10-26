import { useEffect, useState } from 'preact/hooks';
import { get, type LibraryDetail, type LibraryInfo, message } from '../api/client';
import { Code } from '../code';
import { Icon } from '../components/Icon';
import { Badge, ui } from '../components/ui';
import { ago } from '../format';
import { status } from '../live';
import styles from './Tools.module.css';
import browse from './Workspace.module.css';

type Show = 'all' | 'used' | 'unused';
type Sort = 'name' | 'newest' | 'used';

const SHOWS: { value: Show; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'used', label: 'In use' },
  { value: 'unused', label: 'Unused' },
];

/** Tools built on an older revision of the library than its current one. */
const behind = (l: LibraryInfo) => l.usedBy.filter((u) => u.revision !== l.revision);

/**
 * The libraries the agent wrote — code its tools share — as a grid like
 * Tools, each with the tools built on it; and one library's links and source.
 */
export function Libraries({ name }: { name?: string }) {
  const [libs, setLibs] = useState<LibraryInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [show, setShow] = useState<Show>('all');
  const [sort, setSort] = useState<Sort>('name');
  // A library or a tool changes with an event.
  const lastSeq = status.value?.lastSeq;

  useEffect(() => {
    get<{ libraries: LibraryInfo[] }>('/libraries').then(
      (r) => setLibs(r.libraries),
      (err: unknown) => setError(message(err)),
    );
  }, [lastSeq]);

  if (name) return <Library name={name} />;
  const all = libs ?? [];
  const needle = search.trim().toLowerCase();
  const shown = all
    .filter(
      (l) =>
        (show === 'all' || (show === 'used') === l.usedBy.length > 0) &&
        (!needle || l.name.toLowerCase().includes(needle) || l.description.toLowerCase().includes(needle)),
    )
    .sort((a, b) =>
      sort === 'newest'
        ? Date.parse(b.updatedAt) - Date.parse(a.updatedAt)
        : sort === 'used'
          ? b.usedBy.length - a.usedBy.length || a.name.localeCompare(b.name)
          : a.name.localeCompare(b.name),
    );
  const used = all.filter((l) => l.usedBy.length > 0).length;
  const counts = { all: all.length, used, unused: all.length - used };

  return (
    <section class={browse.browser} aria-label="Libraries">
      <div class={browse.filters}>
        <label class={browse.search}>
          <Icon name="search" size={16} />
          <input
            type="search"
            placeholder="Search names and descriptions"
            value={search}
            aria-label="Search libraries"
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
            <option value="used">Most used</option>
          </select>
        </label>
      </div>

      {error && <p class="error">{error}</p>}
      {libs?.length === 0 && (
        <p class="muted">
          No libraries yet. The agent writes one with define_library, and its tools import it as lib:name.
        </p>
      )}
      {all.length > 0 && shown.length === 0 && <p class="muted">No library matches.</p>}
      <ul class={styles.cards}>
        {shown.map((l) => {
          const old = behind(l).length;
          return (
            <li key={l.name}>
              <a class={styles.card} href={`/workspace/libraries/${l.name}`}>
                <span class={styles.icon}>
                  <Icon name="library" size={20} />
                </span>
                <span class={styles.name}>lib:{l.name}</span>
                <span class={styles.meta} title={new Date(l.updatedAt).toLocaleString()}>
                  r{l.revision} · {ago(l.updatedAt)} ·{' '}
                  {l.usedBy.length ? `${l.usedBy.length} ${l.usedBy.length === 1 ? 'tool' : 'tools'}` : 'unused'}
                  {old > 0 && (
                    <>
                      {' '}
                      <Badge state="warn">{old} behind</Badge>
                    </>
                  )}
                </span>
                <span class={styles.desc}>{l.description}</span>
              </a>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Library({ name }: { name: string }) {
  const [lib, setLib] = useState<LibraryDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    get<LibraryDetail>(`/libraries/${encodeURIComponent(name)}`).then(setLib, (err: unknown) => setError(message(err)));
  }, [name]);
  const deps = lib ? Object.entries(lib.deps) : [];
  return (
    <div class={styles.page}>
      <a href="/workspace/libraries">← All libraries</a>
      {error && <p class="error">{error}</p>}
      {lib && (
        <>
          <h2 class={styles.title}>
            lib:{lib.name} <span class="muted">r{lib.revision}</span>
          </h2>
          <p>{lib.description}</p>
          <h3>Used by</h3>
          {lib.usedBy.length === 0 ? (
            <p class="muted">No tool is built on it.</p>
          ) : (
            <ul class={styles.links}>
              {lib.usedBy.map((u) => (
                <li key={u.tool}>
                  <a href={`/workspace/tools/${u.tool}`}>{u.tool}</a> <span class="muted">built on r{u.revision}</span>{' '}
                  {u.revision === lib.revision ? (
                    <Badge state="ok">current</Badge>
                  ) : (
                    <Badge state="warn">behind: rebuild_tool updates it</Badge>
                  )}
                </li>
              ))}
            </ul>
          )}
          {lib.importedBy.length > 0 && (
            <p>
              Imported by{' '}
              {lib.importedBy.map((l, i) => (
                <span key={l}>
                  {i > 0 && ', '}
                  <a href={`/workspace/libraries/${l}`}>lib:{l}</a>
                </span>
              ))}
            </p>
          )}
          {deps.length > 0 && (
            <p>
              npm: <code>{deps.map(([n, v]) => `${n}@${v}`).join(', ')}</code>
            </p>
          )}
          <h3>Source</h3>
          <Code class={ui.pre} text={lib.source} lang="js" />
        </>
      )}
    </div>
  );
}
