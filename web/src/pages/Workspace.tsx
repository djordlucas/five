import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { useLocation } from 'preact-iso';
import {
  type DbResult,
  type DbRows,
  type DbTable,
  del,
  get,
  message,
  post,
  put,
  readFile,
  type WorkspaceDir,
  writeFile,
} from '../api/client';
import { Badge, Segments, ui } from '../components/ui';
import { status } from '../live';
import { asText, bytes, cell, crumbs, dirHref, fieldValue, fileHref, join, MAX_EDIT_BYTES, parent, version } from '../workspace';
import styles from './Workspace.module.css';

/**
 * The workspace, as the agent leaves it: its files to read, edit, upload and
 * delete, and its SQLite databases to browse and change. Five's own data,
 * .five/, is not reachable from here.
 */
export function Workspace() {
  const { query } = useLocation();
  const file = query.file || undefined;
  const dir = file !== undefined ? parent(file) : (query.dir ?? '');
  const [changed, setChanged] = useState(0);
  const reload = () => setChanged((n) => n + 1);

  return (
    <div class={`${styles.split} ${file !== undefined ? styles.open : ''}`}>
      <Files dir={dir} file={file} changed={changed} onChanged={reload} />
      <section class={styles.pane} aria-label="File">
        {file === undefined ? (
          <p class="card muted">
            The files the agent reads and writes: its memory/ notes, results/ of long runs, and everything it makes. Choose a
            file to read or edit it; a SQLite database opens its tables.
          </p>
        ) : (
          <Opened key={`${file}#${changed}`} path={file} table={query.table} sql={query.view === 'sql'} onChanged={reload} />
        )}
      </section>
    </div>
  );
}

// Files

function Files({ dir, file, changed, onChanged }: { dir: string; file?: string; changed: number; onChanged: () => void }) {
  const { route } = useLocation();
  const [data, setData] = useState<WorkspaceDir | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The agent writes files as it works: reload whenever something happened.
  const lastSeq = status.value?.lastSeq;

  useEffect(() => {
    get<WorkspaceDir>(`/workspace/files?path=${encodeURIComponent(dir)}`).then(
      (d) => {
        setData(d);
        setError(null);
      },
      (err: unknown) => setError(message(err)),
    );
  }, [dir, changed, lastSeq]);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
      onChanged();
    }
  };

  const newFile = () => {
    const name = prompt('New file (a path such as notes/today.md makes its directories):');
    if (!name?.trim()) return;
    const path = join(dir, name);
    void act(async () => {
      await writeFile(path, '', '');
      route(fileHref(path));
    });
  };

  const upload = (files: FileList | null) => {
    if (!files?.length) return;
    const existing = new Set(data?.entries.map((e) => e.name));
    const replaced = [...files].filter((f) => existing.has(f.name)).map((f) => f.name);
    if (replaced.length && !confirm(`Replace ${replaced.join(', ')}? The current version is lost.`)) return;
    void act(async () => {
      for (const f of files) await writeFile(join(dir, f.name), f);
    });
  };

  return (
    <nav class={styles.list} aria-label="Files">
      <ol class={styles.crumbs} aria-label="Directory">
        {crumbs(dir).map((c) => (
          <li key={c.path}>
            <a href={dirHref(c.path)} aria-current={c.path === dir && file === undefined ? 'page' : undefined}>
              {c.name}
            </a>
          </li>
        ))}
      </ol>
      <div class={styles.actions}>
        <button type="button" class={ui.action} disabled={busy} onClick={newFile}>
          New file
        </button>
        <label class={`${ui.action} ${styles.upload}`}>
          Upload
          <input
            type="file"
            multiple
            disabled={busy}
            onChange={(e) => {
              upload(e.currentTarget.files);
              e.currentTarget.value = '';
            }}
          />
        </label>
        {dir !== '' && data?.entries.length === 0 && (
          <button
            type="button"
            class={`${ui.action} ${ui.danger}`}
            disabled={busy}
            onClick={() =>
              void act(async () => {
                await del(`/workspace/file?path=${encodeURIComponent(dir)}`);
                route(dirHref(parent(dir)));
              })
            }
          >
            Delete directory
          </button>
        )}
      </div>
      {error && <p class="error">{error}</p>}
      {data?.entries.length === 0 && <p class="muted">This directory is empty.</p>}
      <ul class={styles.entries}>
        {data?.entries.map((e) => (
          <li key={e.path}>
            <a
              href={e.dir ? dirHref(e.path) : fileHref(e.path)}
              class={styles.entry}
              aria-current={e.path === file ? 'page' : undefined}
            >
              <span class={styles.kind}>{e.dir ? 'dir' : e.sqlite ? 'db' : 'file'}</span>
              <span class={styles.name}>{e.name}</span>
              <span class={styles.meta}>
                {e.dir ? '' : `${bytes(e.bytes)} · `}
                {new Date(e.modified).toLocaleString()}
              </span>
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

interface Loaded {
  size: number;
  /** The contents, when they are text the editor can hold. */
  text: string | null;
  version?: string;
  modified: string | null;
}

/** An open file: a database's tables, or a text file's editor, or a download. */
function Opened(props: { path: string; table?: string; sql: boolean; onChanged: () => void }) {
  const [loaded, setLoaded] = useState<(Loaded & { sqlite: boolean }) | 'missing' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { path } = props;

  useEffect(() => {
    // The listing says whether it is a database, which is not downloaded whole.
    (async () => {
      const dir = await get<WorkspaceDir>(`/workspace/files?path=${encodeURIComponent(parent(path))}`);
      const entry = dir.entries.find((e) => e.path === path && !e.dir);
      if (!entry) return setLoaded('missing');
      if (entry.sqlite) {
        return setLoaded({ size: entry.bytes, text: null, sqlite: true, version: entry.version, modified: entry.modified });
      }
      const r = await readFile(path);
      if (!r) return setLoaded('missing');
      setLoaded({ size: r.buf.byteLength, text: asText(r.buf), sqlite: false, version: version(r.version), modified: r.modified });
    })().catch((err: unknown) => setError(message(err)));
  }, [path]);

  if (error) return <p class="card error">{error}</p>;
  if (loaded === 'missing') return <p class="card muted">No file {path}.</p>;
  if (loaded === null) return <p class="card muted">Loading…</p>;
  if (loaded.sqlite) return <Database path={path} table={props.table} sql={props.sql} file={loaded} onChanged={props.onChanged} />;
  return <FileView path={path} file={loaded} onChanged={props.onChanged} />;
}

function FileHead(props: { path: string; file: Loaded; children?: ComponentChildren }) {
  const { path, file } = props;
  const name = path.split('/').pop();
  return (
    <header class={styles.head}>
      <a class={styles.back} href={dirHref(parent(path))} aria-label="The directory">
        ‹
      </a>
      <div class={styles.title}>
        <h2>{name}</h2>
        <span class="muted">
          {[path, bytes(file.size), file.modified ? new Date(file.modified).toLocaleString() : '']
            .filter(Boolean)
            .join(' · ')}
        </span>
      </div>
      <div class={styles.actions}>
        {props.children}
        <a class={ui.action} href={`/api/v1/workspace/file?path=${encodeURIComponent(path)}&download=true`} download={name}>
          Download
        </a>
      </div>
    </header>
  );
}

function FileView(props: { path: string; file: Loaded; onChanged: () => void }) {
  const { route } = useLocation();
  const { path } = props;
  const [file, setFile] = useState(props.file);
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const dirty = draft !== null && draft !== file.text;

  const save = async () => {
    if (draft === null) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const e = await writeFile(path, draft, file.version);
      setFile({ size: e.bytes, text: draft, version: e.version, modified: e.modified });
      setDraft(null);
      setNotice('Saved.');
      props.onChanged();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!confirm(`Delete ${path}? It cannot be brought back.`)) return;
    setBusy(true);
    try {
      await del(`/workspace/file?path=${encodeURIComponent(path)}`, file.version ? { 'if-match': `"${file.version}"` } : {});
      props.onChanged();
      route(dirHref(parent(path)));
    } catch (err) {
      setError(message(err));
      setBusy(false);
    }
  };

  return (
    <article class={`card ${styles.detail}`}>
      <FileHead path={path} file={file}>
        {file.text !== null && (
          <button type="button" class={`button ${styles.save}`} disabled={busy || !dirty} onClick={() => void save()}>
            Save
          </button>
        )}
        <button type="button" class={`${ui.action} ${ui.danger}`} disabled={busy} onClick={() => void remove()}>
          Delete
        </button>
      </FileHead>
      {error && (
        <p class="error" role="alert">
          {error}
          {error.includes('changed since') && ' Copy your changes, then reopen the file to see the new version.'}
        </p>
      )}
      {notice && <p class={styles.notice}>{notice}</p>}
      {file.text !== null ? (
        <textarea
          class={styles.editor}
          aria-label={`Contents of ${path}`}
          spellcheck={false}
          value={draft ?? file.text}
          onInput={(e) => setDraft(e.currentTarget.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 's') {
              e.preventDefault();
              if (dirty && !busy) void save();
            }
          }}
        />
      ) : (
        <p class="muted">
          {file.size > MAX_EDIT_BYTES ? `Over ${bytes(MAX_EDIT_BYTES)}, too large to edit here.` : 'Not a text file.'}{' '}
          Download it to open it, or upload a new version in its directory.
        </p>
      )}
    </article>
  );
}

// Databases

const PAGE = 100;

function Database(props: { path: string; table?: string; sql: boolean; file: Loaded; onChanged: () => void }) {
  const { path, table } = props;
  const [tables, setTables] = useState<DbTable[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [changed, setChanged] = useState(0);
  const lastSeq = status.value?.lastSeq;
  const q = `path=${encodeURIComponent(path)}`;

  useEffect(() => {
    get<{ tables: DbTable[] }>(`/workspace/db/tables?${q}`).then(
      (r) => setTables(r.tables),
      (err: unknown) => setError(message(err)),
    );
  }, [q, changed, lastSeq]);

  const current = tables?.find((t) => t.name === table);
  const segments = [
    ...(tables ?? []).map((t) => ({ href: fileHref(path, { table: t.name }), label: t.name, current: !props.sql && t.name === table })),
    { href: fileHref(path, { sql: true }), label: 'SQL', current: props.sql },
  ];
  return (
    <article class={`card ${styles.detail}`}>
      <FileHead path={path} file={props.file} />
      {error && <p class="error">{error}</p>}
      {tables && <Segments items={segments} />}
      {tables?.length === 0 && !props.sql && <p class="muted">No tables yet. The SQL view can create one.</p>}
      {props.sql ? (
        <Sql path={path} onChanged={() => setChanged((n) => n + 1)} />
      ) : table === undefined ? (
        tables &&
        tables.length > 0 && (
          <ul class={styles.tables}>
            {tables.map((t) => (
              <li key={t.name}>
                <a href={fileHref(path, { table: t.name })} class={styles.entry}>
                  <span class={styles.kind}>{t.kind}</span>
                  <span class={styles.name}>{t.name}</span>
                  <span class={styles.meta}>
                    {t.rows} rows · {t.columns.length} columns
                  </span>
                </a>
              </li>
            ))}
          </ul>
        )
      ) : current ? (
        <TableView key={table} path={path} table={current} onChanged={() => setChanged((n) => n + 1)} />
      ) : (
        tables && <p class="muted">No table {table}.</p>
      )}
    </article>
  );
}

/** The row form's target: a row by its rowid, or a new row. */
type Editing = { rowid: number; values: unknown[] } | { rowid: null } | null;

function TableView({ path, table, onChanged }: { path: string; table: DbTable; onChanged: () => void }) {
  const [offset, setOffset] = useState(0);
  const [editing, setEditing] = useState<Editing>(null);
  const [data, setData] = useState<DbRows | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [changed, setChanged] = useState(0);
  // Follow the agent's writes, unless a row is being edited.
  const lastSeq = editing ? -1 : status.value?.lastSeq;
  const q = `path=${encodeURIComponent(path)}&table=${encodeURIComponent(table.name)}`;

  useEffect(() => {
    if (lastSeq === -1) return;
    get<DbRows>(`/workspace/db/rows?${q}&offset=${offset}&limit=${PAGE}`).then(
      (r) => {
        setData(r);
        setError(null);
      },
      (err: unknown) => setError(message(err)),
    );
  }, [q, offset, changed, lastSeq]);

  const done = () => {
    setEditing(null);
    setChanged((n) => n + 1);
    onChanged();
  };
  return (
    <div class={styles.table}>
      <div class={styles.tableHead}>
        <span class="muted">
          {table.kind} · {table.rows} rows · {table.columns.map((c) => c.name).join(', ')}
        </span>
        {table.kind === 'table' && table.rowid && (
          <button type="button" class={ui.action} onClick={() => setEditing({ rowid: null })}>
            Add row
          </button>
        )}
      </div>
      {!table.rowid && (
        <p class="muted">
          {table.kind === 'view' ? 'A view shows rows other tables hold.' : 'This table has no rowid.'} Change it from{' '}
          <a href={fileHref(path, { sql: true })}>SQL</a>.
        </p>
      )}
      {editing && <RowForm key={editing.rowid ?? 'new'} path={path} table={table} editing={editing} onDone={done} onCancel={() => setEditing(null)} />}
      {error && <p class="error">{error}</p>}
      {data && (
        <>
          <Grid
            columns={data.columns}
            rows={data.rows}
            label={`Rows of ${table.name}`}
            onRow={table.rowid && data.rowids ? (i) => setEditing({ rowid: data.rowids?.[i] as number, values: data.rows[i] as unknown[] }) : undefined}
          />
          <div class={styles.pager}>
            <button type="button" class={ui.action} disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>
              Previous
            </button>
            <span class="muted">{data.total === 0 ? 'No rows' : `${offset + 1}–${offset + data.rows.length} of ${data.total}`}</span>
            <button type="button" class={ui.action} disabled={offset + PAGE >= data.total} onClick={() => setOffset(offset + PAGE)}>
              Next
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function RowForm(props: { path: string; table: DbTable; editing: NonNullable<Editing>; onDone: () => void; onCancel: () => void }) {
  const { path, table, editing } = props;
  const existing = editing.rowid !== null ? (editing as { values: unknown[] }).values : null;
  const initial = table.columns.map((_, i) => (existing ? existing[i] : undefined));
  const [texts, setTexts] = useState(initial.map((v) => (v === null || v === undefined ? '' : cell(v))));
  const [nulls, setNulls] = useState(initial.map((v) => existing !== null && v === null));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const q = `/workspace/db/rows?path=${encodeURIComponent(path)}`;

  /** The columns the form changed, as the values to store. */
  const values = () => {
    const out: Record<string, unknown> = {};
    table.columns.forEach((c, i) => {
      const was = initial[i];
      const touched = existing
        ? texts[i] !== (was === null ? '' : cell(was)) || nulls[i] !== (was === null)
        : texts[i] !== '' || nulls[i];
      if (touched) out[c.name] = fieldValue(texts[i] ?? '', nulls[i] ?? false, c.type);
    });
    return out;
  };
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      props.onDone();
    } catch (err) {
      setError(message(err));
      setBusy(false);
    }
  };
  const submit = (e: Event) => {
    e.preventDefault();
    const v = values();
    if (editing.rowid === null) return void run(() => post<DbResult>(q, { table: table.name, values: v }));
    if (Object.keys(v).length === 0) return props.onCancel();
    void run(() => put<DbResult>(q, { table: table.name, rowid: editing.rowid, values: v }));
  };
  const remove = () => {
    if (editing.rowid === null || !confirm(`Delete row ${editing.rowid} of ${table.name}?`)) return;
    void run(() => del<DbResult>(`${q}&table=${encodeURIComponent(table.name)}&rowid=${editing.rowid}`));
  };

  return (
    <form class={styles.form} onSubmit={submit} aria-label={editing.rowid === null ? 'New row' : `Row ${editing.rowid}`}>
      <h3>{editing.rowid === null ? 'New row' : `Row ${editing.rowid}`}</h3>
      {table.columns.map((c, i) => (
        <div key={c.name} class={styles.field}>
          <label for={`col-${i}`}>
            {c.name} <span class="muted">{[c.type, c.pk ? 'key' : '', c.notNull ? 'required' : ''].filter(Boolean).join(' · ')}</span>
          </label>
          <textarea
            id={`col-${i}`}
            class="input"
            rows={1}
            disabled={nulls[i]}
            placeholder={editing.rowid === null ? (c.default !== null ? `default ${c.default}` : c.pk ? 'automatic' : '') : ''}
            value={texts[i]}
            onInput={(e) => setTexts(texts.map((t, j) => (j === i ? e.currentTarget.value : t)))}
          />
          <label class={styles.nullBox}>
            <input
              type="checkbox"
              checked={nulls[i]}
              onChange={(e) => setNulls(nulls.map((n, j) => (j === i ? e.currentTarget.checked : n)))}
            />
            NULL
          </label>
        </div>
      ))}
      {error && (
        <p class="error" role="alert">
          {error}
        </p>
      )}
      <div class={styles.actions}>
        <button type="submit" class="button" disabled={busy}>
          {editing.rowid === null ? 'Insert' : 'Save'}
        </button>
        <button type="button" class={ui.action} disabled={busy} onClick={props.onCancel}>
          Cancel
        </button>
        {editing.rowid !== null && (
          <button type="button" class={`${ui.action} ${ui.danger}`} disabled={busy} onClick={remove}>
            Delete row
          </button>
        )}
      </div>
    </form>
  );
}

function Grid(props: { columns: string[]; rows: unknown[][]; label: string; onRow?: (i: number) => void }) {
  if (props.rows.length === 0) return null;
  return (
    <div class={styles.gridWrap}>
      <table class={styles.grid} aria-label={props.label}>
        <thead>
          <tr>
            {props.columns.map((c, i) => (
              <th key={i} scope="col">
                {c}
              </th>
            ))}
            {props.onRow && <th scope="col" aria-label="Edit" />}
          </tr>
        </thead>
        <tbody>
          {props.rows.map((r, i) => (
            <tr key={i}>
              {r.map((v, j) => (
                <td key={j} class={v === null ? styles.isNull : undefined} title={cell(v)}>
                  {cell(v)}
                </td>
              ))}
              {props.onRow && (
                <td>
                  <button type="button" class={styles.edit} onClick={() => props.onRow?.(i)}>
                    Edit
                  </button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Sql({ path, onChanged }: { path: string; onChanged: () => void }) {
  const [sql, setSql] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<DbResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async (e: Event) => {
    e.preventDefault();
    if (!sql.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const r = await post<DbResult>(`/workspace/db/sql?path=${encodeURIComponent(path)}`, { sql });
      setResult(r);
      if (r.write) onChanged();
    } catch (err) {
      setResult(null);
      setError(message(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class={styles.table}>
      <p class="muted">
        One statement on this database; anything after the first is ignored. A read shows up to 1000 rows. ATTACH and VACUUM
        INTO are refused.
      </p>
      <form class={styles.form} onSubmit={(e) => void run(e)}>
        <textarea
          class={`${styles.editor} ${styles.sqlBox}`}
          aria-label="Statement"
          spellcheck={false}
          placeholder="SELECT * FROM …"
          value={sql}
          onInput={(e) => setSql(e.currentTarget.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') void run(e);
          }}
        />
        <div class={styles.actions}>
          <button type="submit" class="button" disabled={busy || !sql.trim()}>
            Run
          </button>
          <span class="muted">⌘Enter or Ctrl+Enter</span>
        </div>
      </form>
      {error && (
        <p class="error" role="alert">
          {error}
        </p>
      )}
      {result?.write && (
        <p class={styles.notice} role="status">
          {result.changes} {result.changes === 1 ? 'row' : 'rows'} changed
          {result.lastInsertRowid ? `; last inserted rowid ${result.lastInsertRowid}` : ''}.
        </p>
      )}
      {result && !result.write && (
        <>
          <p class="muted" role="status">
            {result.rows.length} {result.rows.length === 1 ? 'row' : 'rows'}
            {result.truncated ? ', the first 1000 shown' : ''}. <Badge state="info">read</Badge>
          </p>
          <Grid columns={result.columns} rows={result.rows} label="Result" />
        </>
      )}
    </div>
  );
}
