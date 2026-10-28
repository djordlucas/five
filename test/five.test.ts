import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, test } from "node:test";
import { createApi } from "../src/api/server.ts";
import type {
  BoardPage,
  DbResult,
  DbRows,
  DbTable,
  Event,
  LibraryDetail,
  LibraryInfo,
  ProcessDetail,
  ProcessInfo,
  SettingsView,
  Status,
  Task,
  ToolDetail,
  WorkerDetail,
  WorkerInfo,
  WorkspaceDir,
  WorkspaceEntry,
} from "../src/api/types.ts";
import { createFive, type Five } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import type { ChatModel, Completion, CompletionRequest, Message } from "../src/llm/model.ts";
import { noopLogger } from "../src/log.ts";
import { State } from "../src/state.ts";
import { type AgentResult, runAgent } from "../src/workers/agent.ts";
import { Board } from "../src/workers/board.ts";
import { ModelPool } from "../src/workers/pool.ts";
import { Run, runScope } from "../src/workers/run.ts";
import { toolsByName } from "../src/workers/tools.ts";
import { feedItems, htmlToText, parseResults } from "../src/workers/web.ts";

type Reply = { content?: string; calls?: [string, Record<string, unknown>][]; tokens?: number };

/**
 * A model that gives scripted replies, and records every request's messages
 * and the images it would send. Replies come in order, or from a function of
 * the request — to answer the lead, the chat and the workers each their own way.
 */
function scripted(
  replies: Reply[] | ((req: CompletionRequest, n: number) => Reply),
): ChatModel & { requests: Message[][]; images: (string | undefined)[][] } {
  const requests: Message[][] = [];
  const images: (string | undefined)[][] = [];
  let n = 0;
  return {
    requests,
    images,
    async complete(req: CompletionRequest): Promise<Completion> {
      const messages = structuredClone(req.messages);
      // What a model that sees would get: each attached image's bytes, as base64.
      images.push(messages.flatMap((m) => ("images" in m && m.images ? m.images.map((p) => req.image?.(p)) : [])));
      requests.push(messages);
      const i = n++;
      const r = (typeof replies === "function" ? replies(req, i) : replies[i]) ?? { content: "done" };
      return {
        message: {
          role: "assistant",
          content: r.content ?? null,
          ...(r.calls && {
            tool_calls: r.calls.map(([name, args], j) => ({
              id: `c${i + 1}_${j}`,
              type: "function" as const,
              function: { name, arguments: JSON.stringify(args) },
            })),
          }),
        },
        usage: { prompt_tokens: r.tokens ?? 100, completion_tokens: 10, total_tokens: (r.tokens ?? 100) + 10 },
      };
    },
  };
}

const open: Five[] = [];
afterEach(async () => {
  for (const f of open.splice(0)) await f.close();
});

function make(replies: Reply[] | ((req: CompletionRequest, n: number) => Reply), env: Record<string, string> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "five-test-"));
  const cfg = loadConfig({ FIVE_WORKSPACE: dir, FIVE_TICK_MS: "20", ...env });
  const model = scripted(replies);
  const five = createFive(cfg, model);
  open.push(five);
  return { five, model, cfg };
}

/** Tools an agent in these tests gets, besides the tools it built. */
const TOOLS = [
  "run_js",
  "define_tool",
  "read_tool",
  "start_tool",
  "define_library",
  "read_library",
  "delete_library",
  "rebuild_tool",
  "view_image",
  "read_pdf",
  "read_file",
  "write_file",
  "list_files",
];

/** One agent, as a worker runs one: its own run, the tools above and those it built. */
async function agent(five: Five, prompt = "go"): Promise<AgentResult> {
  const d = five.five.d;
  const run = new Run({ n: d.state.nextRun(), worker: "test", kind: "task", log: noopLogger, emit: d.emit });
  const { tools } = toolsByName(d, [...TOOLS, ...five.store.list().map((t) => t.name)]);
  return runScope.run(run, () =>
    runAgent(d, run, { system: "You are a test.", messages: [{ role: "user", content: prompt }], tools }),
  );
}

/** Wait until a condition holds. */
async function until(ok: () => boolean, what: string, ms = 10_000): Promise<void> {
  const t0 = Date.now();
  while (!ok()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** A request's system prompt, after the date line every one starts with. */
const system = (req: CompletionRequest) =>
  req.messages[0]?.role === "system" ? String(req.messages[0].content).replace(/^Today is [^\n]*\n\n/, "") : "";
const events = (five: Five): Event[] => five.state.eventsAfter(0, 10_000);

async function serve(five: Five, cfg: ReturnType<typeof loadConfig>) {
  const server = createApi({ five, cfg, log: noopLogger });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1`;
  const json = { "content-type": "application/json" };
  const call = async <T>(method: string, url: string, body?: unknown): Promise<{ status: number; body: T }> => {
    const res = await fetch(`${base}${url}`, {
      method,
      headers: json,
      ...(method !== "GET" && { body: JSON.stringify(body ?? {}) }),
    });
    return { status: res.status, body: (await res.json()) as T };
  };
  return { server, base, call };
}

test("the board: tasks posted, taken oldest first, finished; a task running when five stopped is open again", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "five-test-"));
  const state = new State(path.join(dir, "five.db"));
  const board = new Board(state);
  const a = board.post({ worker: "research", title: "A", input: "", by: "lead" });
  const b = board.post({ worker: "feeds", title: "B", input: "x", by: "person" });
  assert.deepEqual(board.counts(), { open: 2, running: 0, done: 0, failed: 0 });
  const first = board.claim(() => 7);
  assert.deepEqual([first?.id, first?.status, first?.run], [a.id, "running", 7]);
  board.finish(a.id, { ok: true, result: "found it, in research/a.md" });
  board.claim(() => 8);
  assert.equal(board.cancel(b.id), false, "a running task cannot be cancelled");
  assert.match(board.summary(), /#2 \[running\] feeds: B[\s\S]*Latest ended:\n- #1 research: A → found it/);
  assert.deepEqual(board.tally("research"), { done: 1, failed: 0 });
  state.close();
  // Five stopped with B running: it is open again.
  const again = new State(path.join(dir, "five.db"));
  assert.equal(new Board(again).get(b.id)?.status, "open");
  again.close();
});

test("the model pool sends no more calls than its slots, and the chat's go first", async () => {
  const order: string[] = [];
  let release: (() => void)[] = [];
  const model: ChatModel = {
    complete: (req) =>
      new Promise((resolve) => {
        order.push(String(req.messages[0]?.content));
        release.push(() => resolve({ message: { role: "assistant", content: "ok" } }));
      }),
  };
  const pool = new ModelPool(model, () => 2);
  const ask = (name: string, priority = 0) =>
    pool.complete({ messages: [{ role: "user", content: name }] }, { priority });
  const calls = [ask("a"), ask("b"), ask("c"), ask("d"), ask("chat", 1)];
  await until(() => order.length === 2, "two calls");
  assert.equal(pool.waiting, 3);
  const free = () => {
    const r = release;
    release = [];
    for (const f of r) f();
  };
  free();
  await until(() => order.length === 4, "the next two");
  assert.deepEqual(order, ["a", "b", "chat", "c"]);
  free();
  await until(() => order.length === 5, "the last");
  free();
  const done = await Promise.all(calls);
  assert.ok(done.some((r) => r.waitedMs > 0));
});

test("web: a page's text, a feed's items, the results of a search", () => {
  const page = `<html><head><title>T &amp; co</title><style>x{}</style></head><body><nav>menu</nav>
    <h1>Big news</h1><p>First <b>para</b>.</p><script>alert(1)</script><ul><li>one</li><li>two</li></ul></body></html>`;
  assert.equal(htmlToText(page), "T & co\n\n# Big news\nFirst para.\n- one\n- two");
  const rss = `<?xml version="1.0"?><rss><channel><title>Feed</title>
    <item><title><![CDATA[Quake hits]]></title><link>https://x.test/1</link><pubDate>Mon, 26 Oct 2026</pubDate><description>&lt;p&gt;Strong&lt;/p&gt;</description></item>
    <item><title>Vote held</title><link>https://x.test/2</link></item></channel></rss>`;
  assert.deepEqual(feedItems(rss), [
    { title: "Quake hits", link: "https://x.test/1", date: "Mon, 26 Oct 2026", summary: "Strong" },
    { title: "Vote held", link: "https://x.test/2" },
  ]);
  const atom = `<feed><entry><title>A</title><link href="https://y.test/a"/><updated>2026-10-27</updated></entry></feed>`;
  assert.deepEqual(feedItems(atom), [{ title: "A", link: "https://y.test/a", date: "2026-10-27" }]);
  const ddg = `<div class="result results_links"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fnews.test%2Fa&amp;rut=1">News <b>A</b></a>
    <a class="result__snippet" href="x">What <b>happened</b></a></div>
    <div class="result result--ad"><a class="result__a" href="https://duckduckgo.com/y.js?ad=1">Ad</a></div>`;
  assert.deepEqual(parseResults(ddg), [{ title: "News A", url: "https://news.test/a", snippet: "What happened" }]);
});

test("seven's tools work in an agent: run_js, and define_tool then, in the next agent, the tool", async () => {
  const { five, model } = make([
    { calls: [["run_js", { code: "export default 6 * 7" }]] },
    {
      calls: [
        [
          "define_tool",
          {
            name: "double",
            description: "Doubles n.",
            code: "export default async ({ n }) => n * 2",
            test_args: { n: 1 },
          },
        ],
      ],
    },
    { content: "next" },
    { calls: [["double", { n: 21 }]] },
    { content: "ok" },
  ]);
  await agent(five);
  assert.equal((await agent(five)).text, "ok");
  const results = new Map(
    model.requests.flat().flatMap((m) => (m.role === "tool" ? [[m.tool_call_id, m.content]] : [])),
  );
  assert.deepEqual(
    [...results.values()].map((r) => r.slice(0, 12)),
    ["42", "saved double", "42"],
  );
});

test("the workspace API reads and writes files and databases, and keeps out of .five", async () => {
  const { five, cfg } = make([]);
  const server = createApi({ five, cfg, log: noopLogger });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1/workspace`;
  const json = { "content-type": "application/json" };
  const bytes = { "content-type": "application/octet-stream" };
  const q = (p: string) => `?path=${encodeURIComponent(p)}`;
  try {
    // A new file, its directory made; one that exists is not overwritten by a create.
    const made = await fetch(`${base}/file${q("notes/a.md")}`, {
      method: "PUT",
      headers: { ...bytes, "if-match": '""' },
      body: "one",
    });
    const entry = (await made.json()) as WorkspaceEntry;
    assert.equal(entry.path, "notes/a.md");
    const again = await fetch(`${base}/file${q("notes/a.md")}`, {
      method: "PUT",
      headers: { ...bytes, "if-match": '""' },
      body: "x",
    });
    assert.equal(again.status, 409);

    const read = await fetch(`${base}/file${q("notes/a.md")}`);
    assert.equal(await read.text(), "one");
    assert.equal(read.headers.get("content-type"), "application/octet-stream");
    assert.equal(read.headers.get("content-security-policy"), "sandbox");
    const version = read.headers.get("etag") ?? "";

    // A write with the version read succeeds once; with it stale, 409.
    const ok = await fetch(`${base}/file${q("notes/a.md")}`, {
      method: "PUT",
      headers: { ...bytes, "if-match": version },
      body: "two",
    });
    assert.equal(ok.status, 200);
    const stale = await fetch(`${base}/file${q("notes/a.md")}`, {
      method: "PUT",
      headers: { ...bytes, "if-match": version },
      body: "three",
    });
    assert.equal(stale.status, 409);
    assert.equal(fs.readFileSync(path.join(cfg.workspace, "notes/a.md"), "utf8"), "two");

    const root = (await (await fetch(`${base}/files`)).json()) as WorkspaceDir;
    assert.deepEqual(
      root.entries.map((e) => [e.name, e.dir]),
      [["notes", true]],
    );

    // Five's own data and anything outside the workspace are out of reach.
    for (const p of [".five/five.db", "../x", "notes/../../x"]) {
      const r = await fetch(`${base}/file${q(p)}`);
      assert.ok(r.status === 403 || r.status === 400, `${p}: ${r.status}`);
    }
    fs.symlinkSync(path.join(cfg.workspace, ".five"), path.join(cfg.workspace, "link"));
    assert.equal((await fetch(`${base}/file${q("link/five.db")}`)).status, 403);
    const json415 = await fetch(`${base}/file${q("x.txt")}`, { method: "PUT", headers: json, body: "{}" });
    assert.equal(json415.status, 415);

    // A database: create it with SQL, then rows by rowid.
    const db = path.join(cfg.workspace, "data.db");
    const { DatabaseSync } = await import("node:sqlite");
    new DatabaseSync(db).close();
    const sql = async (s: string) =>
      (await (
        await fetch(`${base}/db/sql${q("data.db")}`, {
          method: "POST",
          headers: json,
          body: JSON.stringify({ sql: s }),
        })
      ).json()) as DbResult;
    await sql("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT NOT NULL, n REAL DEFAULT 0)");
    const listed = (await (await fetch(`${base}/files`)).json()) as WorkspaceDir;
    assert.equal(listed.entries.find((e) => e.name === "data.db")?.sqlite, true);

    const ins = await fetch(`${base}/db/rows${q("data.db")}`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ table: "t", values: { name: "a", n: 1.5 } }),
    });
    assert.equal(((await ins.json()) as DbResult).lastInsertRowid, 1);
    await fetch(`${base}/db/rows${q("data.db")}`, {
      method: "PUT",
      headers: json,
      body: JSON.stringify({ table: "t", rowid: 1, values: { name: "b" } }),
    });
    const tables = ((await (await fetch(`${base}/db/tables${q("data.db")}`)).json()) as { tables: DbTable[] }).tables;
    assert.deepEqual(
      tables.map((t) => [t.name, t.kind, t.rows, t.rowid, t.columns.map((c) => c.name)]),
      [["t", "table", 1, true, ["id", "name", "n"]]],
    );
    const rows = (await (await fetch(`${base}/db/rows${q("data.db")}&table=t`)).json()) as DbRows;
    assert.deepEqual(rows, { columns: ["id", "name", "n"], rows: [[1, "b", 1.5]], rowids: [1], total: 1 });
    const read2 = await sql("SELECT name FROM t");
    assert.deepEqual([read2.write, read2.rows], [false, [["b"]]]);
    const bad = await fetch(`${base}/db/sql${q("data.db")}`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ sql: "ATTACH '.five/five.db' AS f" }),
    });
    assert.equal(bad.status, 400);
    const del = await fetch(`${base}/db/rows${q("data.db")}&table=t&rowid=1`, {
      method: "DELETE",
      headers: json,
      body: "{}",
    });
    assert.equal(((await del.json()) as DbResult).changes, 1);
    assert.equal((await fetch(`${base}/db/tables${q("notes/a.md")}`)).status, 400);

    // Delete a file, then its directory once empty.
    const rm = (p: string, headers: Record<string, string> = {}) =>
      fetch(`${base}/file${q(p)}`, { method: "DELETE", headers: { ...json, ...headers }, body: "{}" });
    assert.equal((await rm("notes")).status, 409);
    assert.equal((await rm("notes/a.md", { "if-match": version })).status, 409);
    assert.equal((await rm("notes/a.md")).status, 200);
    assert.equal((await rm("notes")).status, 200);
  } finally {
    server.close();
  }
});

test("every child process is recorded, with its source, output and result, and a live one can be killed", async () => {
  const { five, cfg } = make([
    { calls: [["run_js", { code: "console.log('hi'); export default 6 * 7" }]] },
    { calls: [["start_tool", { tool: "run_js", args: { code: "await new Promise((r) => setTimeout(r, 60000))" } }]] },
    { content: "ok" },
  ]);
  await agent(five);
  const server = createApi({ five, cfg, log: noopLogger });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1/processes`;
  try {
    const list = ((await (await fetch(base)).json()) as { processes: ProcessInfo[] }).processes;
    assert.equal(list.length, 2);
    const [bg, done] = list as [ProcessInfo, ProcessInfo];
    assert.deepEqual([done.kind, done.label, done.state, done.run, done.step], ["code", "run_js", "ok", 1, 1]);
    assert.deepEqual([bg.runId, bg.step], ["r1", 2]);
    assert.ok(bg.state === "installing" || bg.state === "running", bg.state);
    const detail = (await (await fetch(`${base}/${done.id}`)).json()) as ProcessDetail;
    assert.deepEqual(detail.logs, ["hi"]);
    assert.equal(detail.value, 42);
    assert.match(detail.source, /console\.log\('hi'\)/);

    const json = { "content-type": "application/json" };
    const killed = await fetch(`${base}/${bg.id}/kill`, { method: "POST", headers: json, body: "{}" });
    assert.equal(killed.status, 200);
    await five.runs.settled("r1");
    const after = (await (await fetch(`${base}/${bg.id}`)).json()) as ProcessDetail;
    assert.equal(after.state, "killed");
    assert.equal((await fetch(`${base}/${bg.id}/kill`, { method: "POST", headers: json, body: "{}" })).status, 409);
  } finally {
    server.close();
  }
});

function twoPagePdf(): Buffer {
  const stream = (s: string) => `<< /Length ${s.length} >>\nstream\n${s}\nendstream`;
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 7 0 R >> >> >>",
    stream("BT /F1 18 Tf 20 100 Td (Hello from page one) Tj ET"),
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 6 0 R >>",
    stream("0 0 1 rg 50 50 200 100 re f"),
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

test("view_image shrinks an image and shows it after the step's results; read_pdf reads text and renders the rest", async () => {
  const { createCanvas } = await import("@napi-rs/canvas");
  const { five, model, cfg } = make([
    {
      calls: [
        ["view_image", { path: "photo.png" }],
        ["view_image", { path: "notes.txt" }],
        ["read_pdf", { path: "doc.pdf" }],
      ],
    },
    { content: "a red picture and a document" },
  ]);
  const canvas = createCanvas(2000, 1000);
  const g = canvas.getContext("2d");
  g.fillStyle = "#c00";
  g.fillRect(0, 0, 2000, 1000);
  fs.writeFileSync(path.join(cfg.workspace, "photo.png"), await canvas.encode("png"));
  fs.writeFileSync(path.join(cfg.workspace, "notes.txt"), "not an image");
  fs.writeFileSync(path.join(cfg.workspace, "doc.pdf"), twoPagePdf());

  await agent(five);
  const sent = model.requests[1] ?? [];
  const results = sent.filter((m) => m.role === "tool").map((m) => m.content);
  assert.match(results[0] ?? "", /^attached results\/images\/photo-\w+\.jpg \(1024×512, shrunk from 2000×1000\)/);
  assert.match(results[1] ?? "", /^error: .*not an image/);
  assert.match(results[2] ?? "", /^doc\.pdf: 2 pages; pages 1–2 follow\./);
  assert.match(results[2] ?? "", /--- page 1 ---\nHello from page one/);
  assert.match(results[2] ?? "", /--- page 2 --- no text .*rendered as results\/images\/doc-p2\.png/);
  assert.ok(fs.existsSync(path.join(cfg.workspace, "results/images/doc-p2.png")));

  // After the tool results, a user message with the image; the call sends its bytes.
  const shown = sent.at(-1);
  assert.equal(shown?.role, "user");
  const paths = shown && "images" in shown ? shown.images : undefined;
  assert.equal(paths?.length, 1);
  assert.match(paths?.[0] ?? "", /^results\/images\/photo-\w+\.jpg$/);
  const data = model.images[1]?.[0];
  assert.ok(
    data &&
      Buffer.from(data, "base64")
        .subarray(0, 2)
        .equals(Buffer.from([0xff, 0xd8])),
    "a JPEG",
  );
});

test("libraries: bundled into a tool at their revision, with the tools a change leaves behind, and rebuild_tool", async () => {
  const lib = (code: string, extra: Record<string, unknown> = {}): [string, Record<string, unknown>] => [
    "define_library",
    { name: "greet", description: "hello(name)", code, ...extra },
  ];
  const { five, model, cfg } = make([
    {
      calls: [
        lib("export const hello = (n: string) => `hello ${n}`;", {
          test_code: 'import { hello } from "lib:greet"; export default hello("test");',
        }),
        [
          "define_tool",
          {
            name: "say",
            description: "Greets.",
            parameters: { type: "object", properties: { who: { type: "string" } }, required: ["who"] },
            code: 'import { hello } from "lib:greet";\nexport default async ({ who }) => hello(who);',
            test_args: { who: "trial" },
          },
        ],
        ["run_js", { code: 'import { hello } from "lib:nope"; export default 1;' }],
      ],
    },
    { content: "next" },
    { calls: [["say", { who: "ada" }]] },
    { content: "next" },
    {
      calls: [
        lib("export const hello = (n: string) => `HI ${n}`;", {
          test_code: 'import { hello } from "lib:greet"; throw new Error("no");',
        }),
        lib("export const hello = (n: string) => `HI ${n}`;"),
        ["say", { who: "bo" }],
        ["read_tool", { name: "say" }],
        ["delete_library", { name: "greet" }],
        ["rebuild_tool", { name: "say", test_args: { who: "x" } }],
      ],
    },
    { content: "next" },
    {
      calls: [
        ["say", { who: "cy" }],
        ["read_library", {}],
      ],
    },
    { content: "done" },
  ]);
  // One agent a phase: a tool defined in one is in the next one's tools.
  for (let i = 0; i < 4; i++) await agent(five);
  // The results of the step before request i: the tool messages after its last assistant message.
  const results = (i: number) => {
    const sent = model.requests[i] ?? [];
    const last = sent.findLastIndex((m) => m.role === "assistant");
    return sent.slice(last + 1).flatMap((m) => (m.role === "tool" ? [m.content] : []));
  };

  const [defined, tool, missing] = results(1);
  assert.match(defined ?? "", /^saved lib:greet \(revision 1\)[\s\S]*No tool is built on it yet[\s\S]*hello test/);
  assert.match(tool ?? "", /^saved say \(revision 1\)[\s\S]*Built on lib:greet r1/);
  assert.match(missing ?? "", /^error: .*no library "nope"/);
  assert.match(results(3)[0] ?? "", /hello ada/);

  const [failed, revised, stillOld, read, refused, rebuilt] = results(5);
  assert.match(failed ?? "", /^not saved: the test failed/);
  assert.match(
    revised ?? "",
    /^saved lib:greet \(revision 2\)[\s\S]*say \(r1\)[\s\S]*say still runs an older revision: rebuild_tool/,
  );
  // The tool keeps the revision it was built on.
  assert.match(stillOld ?? "", /hello bo/);
  assert.match(read ?? "", /lib:greet r1: the library is at r2 now; rebuild_tool/);
  assert.match(refused ?? "", /^error: lib:greet is in use by the tool say/);
  assert.match(rebuilt ?? "", /^rebuilt say \(revision 2\) on lib:greet r2[\s\S]*HI x/);

  // Rebuilt on r2.
  assert.deepEqual(five.store.get("say")?.meta.libs, [{ name: "greet", revision: 2 }]);
  const [now, listed] = results(7);
  assert.match(now ?? "", /HI cy/);
  assert.match(listed ?? "", /^lib:greet r2 — hello\(name\) \(used by say\)/);

  // The API: the library, who uses it, and each tool's libraries.
  const server = createApi({ five, cfg, log: noopLogger });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1`;
  try {
    const list = (await (await fetch(`${base}/libraries`)).json()) as { libraries: LibraryInfo[] };
    assert.deepEqual(list.libraries, [
      {
        name: "greet",
        description: "hello(name)",
        revision: 2,
        updatedAt: list.libraries[0]?.updatedAt,
        usedBy: [{ tool: "say", revision: 2 }],
      },
    ]);
    const one = (await (await fetch(`${base}/libraries/greet`)).json()) as LibraryDetail;
    assert.match(one.source, /HI/);
    assert.deepEqual(one.importedBy, []);
    assert.equal((await fetch(`${base}/libraries/nope`)).status, 404);
    const tool = (await (await fetch(`${base}/tools/say`)).json()) as ToolDetail;
    assert.deepEqual(tool.libs, [{ name: "greet", revision: 2, current: 2 }]);
    assert.equal(((await (await fetch(`${base}/status`)).json()) as Status).libraries, 1);
  } finally {
    server.close();
  }
});

test("the Ollama client reads a streamed reply as it arrives", async () => {
  const http = await import("node:http");
  const chunks = [
    { message: { thinking: "Hm" } },
    { message: { thinking: "m." } },
    { message: { content: "Hel" } },
    { message: { content: "lo" }, done: true, done_reason: "stop", prompt_eval_count: 7, eval_count: 3 },
  ];
  const server = http.createServer(async (req, res) => {
    if (req.url === "/api/show") return res.end("{}");
    res.writeHead(200, { "content-type": "application/x-ndjson" });
    for (const c of chunks) {
      res.write(`${JSON.stringify(c)}\n`);
      await new Promise((r) => setTimeout(r, 15));
    }
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const { Ollama } = await import("../src/llm/ollama.ts");
    const port = (server.address() as { port: number }).port;
    const client = new Ollama({ model: "m", endpoint: `http://127.0.0.1:${port}`, contextTokens: 1000 });
    const progress: string[] = [];
    const out = await client.complete({
      messages: [{ role: "user", content: "hi" }],
      onProgress: (p) => progress.push(`${p.thinking}|${p.content}`),
    });
    assert.equal(out.message.content, "Hello");
    assert.equal(out.message.thinking, "Hmm.");
    assert.equal(out.usage?.prompt_tokens, 7);
    assert.ok(progress.length >= 3, `progress came in pieces: ${progress.join(", ")}`);
    assert.equal(progress.at(-1), "Hmm.|Hello");
  } finally {
    server.close();
  }
});

test("the lead posts a task; the research worker does it through five.llm.agent, and its result is on the board", async () => {
  const { five, model, cfg } = make((req) => {
    const sys = system(req);
    const steps = req.messages.filter((m) => m.role === "assistant").length;
    if (sys.startsWith("You are the lead")) {
      return steps === 0
        ? { calls: [["post_task", { worker: "research", title: "Find what X is", input: "Write research/x.md." }]] }
        : { content: "Posted one research task." };
    }
    if (sys.startsWith("You are a research worker")) {
      return steps === 0
        ? { calls: [["write_file", { path: "research/x.md", content: "X is a letter. (https://x.test)" }]] }
        : { content: "X is a letter: research/x.md" };
    }
    return { content: "?" };
  });
  five.five.settings.update({ minOpenTasks: 0 });
  five.five.start();
  await until(() => five.five.board.counts().done === 1, "the task to be done");
  five.five.pause();
  const task = five.five.board.list()[0] as Task;
  assert.deepEqual(
    [task.worker, task.status, task.postedBy, task.result],
    ["research", "done", "lead", "X is a letter: research/x.md"],
  );
  assert.equal(fs.readFileSync(path.join(cfg.workspace, "research/x.md"), "utf8"), "X is a letter. (https://x.test)");

  // The lead's prompt: the goal, the board, the task workers — built fresh.
  const lead = model.requests[0] ?? [];
  assert.match(
    String(lead[1]?.content),
    /^## Goal\n\nFollow what is happening in the world[\s\S]*## Task workers\n\n- feeds \(r1[\s\S]*- research \(r1/,
  );
  // The research agent's context: its own prompt, nothing of the lead's.
  const research = model.requests.find((r) => system({ messages: r }).startsWith("You are a research worker")) ?? [];
  assert.match(String(research[1]?.content), /^Task #1: Find what X is\n\nWrite research\/x\.md\./);

  const seen = events(five);
  const runs = seen
    .filter((e) => e.type === "run_started")
    .map((e) => e.type === "run_started" && `${e.run}:${e.worker}`);
  assert.deepEqual(runs, ["1:lead", "2:research"]);
  const work = seen.filter((e) => e.run === 2).map((e) => (e.type === "tool" ? `tool:${e.name}` : e.type));
  assert.deepEqual(work, ["run_started", "model", "tool:write_file", "model", "task", "run_ended"]);
  const ended = seen.find((e) => e.type === "run_ended" && e.run === 2);
  assert.equal(ended?.type === "run_ended" && ended.outcome, "done");
  // The worker's code ran as a process of its run.
  const proc = five.processes.list().find((p) => p.kind === "worker");
  assert.deepEqual([proc?.label, proc?.run, proc?.state], ["worker research", 2, "ok"]);
});

test("define_worker: tried on a trial task first, refused for five's own workers; then it does a task", async () => {
  const code = `export default async ({ task }) => {
  const out = await five.llm.ask("Count the words: " + task.input, { schema: { type: "object", properties: { n: { type: "integer" } }, required: ["n"] } });
  fs.writeFileSync("count.txt", String(out.n));
  return "counted " + out.n;
};`;
  const { five, model, cfg } = make((req) => {
    const sys = system(req);
    const steps = req.messages.filter((m) => m.role === "assistant").length;
    if (sys.startsWith("You are the lead")) {
      if (steps === 0) {
        return {
          calls: [
            ["define_worker", { name: "chat", description: "mine", code }],
            ["define_worker", { name: "count", description: "Counts words.", code: "export const x = 1;" }],
            [
              "define_worker",
              { name: "count", description: "Counts words. Input: the text.", code, test_input: "a b c" },
            ],
            ["post_task", { worker: "count", title: "Count", input: "one two" }],
            ["define_worker", { name: "count", description: "Counts.", code }],
          ],
        };
      }
      return { content: "Wrote count." };
    }
    // llm.ask: the format asked for is the schema.
    if (req.format)
      return { content: JSON.stringify({ n: String(req.messages.at(-1)?.content).split(" ").length - 3 }) };
    return { content: "?" };
  });
  five.five.settings.update({ minOpenTasks: 0 });
  five.five.start();
  await until(() => five.five.board.counts().done === 1, "the count task");
  five.five.pause();
  const lead = model.requests.find((r) => r.some((m) => m.role === "tool")) ?? [];
  const results = lead.filter((m) => m.role === "tool").map((m) => m.content);
  assert.match(results[0] ?? "", /^error: "chat" is one of five's own workers/);
  assert.match(results[1] ?? "", /^not saved: the code needs `export default/);
  assert.match(results[2] ?? "", /^saved worker count \(revision 1\)[\s\S]*trial result:\ncounted 3/);
  assert.match(results[4] ?? "", /^not saved: count exists and works; a revision needs test_input/);
  assert.equal((five.five.board.list()[0] as Task).result, "counted 2");
  assert.equal(fs.readFileSync(path.join(cfg.workspace, "count.txt"), "utf8"), "2");
  const asked = events(five).find((e) => e.type === "model" && e.prompt);
  assert.equal(asked?.type === "model" && asked.prompt, "Count the words: a b c");

  const { server, call } = await serve(five, cfg);
  try {
    const { body } = await call<{ workers: WorkerInfo[] }>("GET", "/workers");
    assert.deepEqual(
      body.workers.map((w) => `${w.name}:${w.kind}:${w.fixed}:${w.revision ?? "-"}:${w.done}`),
      [
        "lead:lead:true:-:0",
        "chat:chat:true:-:0",
        "count:task:false:1:1",
        "feeds:task:false:1:0",
        "research:task:false:1:0",
      ],
    );
    const one = await call<WorkerDetail>("GET", "/workers/count");
    assert.match(one.body.source, /llm\.ask/);
    assert.match((await call<WorkerDetail>("GET", "/workers/lead")).body.source, /^You are the lead of five/);
  } finally {
    server.close();
  }
});

test("an agent near its context budget is told to finish, and past it ends", async () => {
  const { five, model } = make(
    [
      { calls: [["list_files", {}]], tokens: 500 },
      { calls: [["list_files", {}]], tokens: 900 },
      { calls: [["list_files", {}]], tokens: 1100 },
      { content: "never asked" },
    ],
    { FIVE_RUN_TOKENS: "1000" },
  );
  const r = await agent(five);
  assert.equal(r.outcome, "budget");
  assert.equal(model.requests.length, 3);
  assert.match(
    String(model.requests[2]?.at(-1)?.content),
    /^\[five\] Your context is nearly full \(900 of 1000 tokens\)\. Finish now/,
  );
  // The context only grew: each call's messages start with the last one's.
  assert.deepEqual(model.requests[2]?.slice(0, model.requests[1]?.length), model.requests[1]);
});

test("the chat: answers while five is paused, keeps its context, changes the goal; the lead reads it after", async () => {
  const { five, model, cfg } = make((req) => {
    const sys = system(req);
    const steps = req.messages.filter((m) => m.role === "assistant").length;
    if (sys.startsWith("You are five, talking live")) {
      if (steps === 0) return { content: "Hello! I follow the news." };
      if (steps === 1) return { calls: [["set_goal", { goal: "Follow science news, above all space." }]] };
      return { content: "Done: the goal is science and space now." };
    }
    if (sys.startsWith("You are the lead")) return { content: "Read the chat; nothing to post yet." };
    return { content: "?" };
  });
  five.five.settings.update({ minOpenTasks: 0 });
  five.five.say("What are you doing?");
  await until(() => five.five.status().chat?.waitingUntil !== undefined, "the first answer");
  assert.match(
    String(model.requests[0]?.[1]?.content),
    /^## Five now\n\nGoal: Follow what is happening[\s\S]*## The person says\n\nWhat are you doing\?$/,
  );
  five.five.say("Switch to science, space above all.");
  await until(
    () => model.requests.length === 3 && five.five.status().chat?.waitingUntil !== undefined,
    "the second answer",
  );
  // The same context, grown: the first exchange, then the new message.
  assert.deepEqual(
    model.requests[1]?.slice(0, 3),
    model.requests[0]?.concat([{ role: "assistant", content: "Hello! I follow the news." }]),
  );
  assert.equal(model.requests[1]?.at(-1)?.content, "Switch to science, space above all.");
  assert.equal(five.five.d.goal(), "Follow science news, above all space.");

  five.five.leaveChat();
  await until(() => five.five.status().chat === undefined && five.five.status().active.length === 0, "the chat to end");
  const ended = events(five).find((e) => e.type === "chat_ended");
  assert.ok(ended?.type === "chat_ended" && ended.reason === "left" && ended.saved);
  const saved = ended.type === "chat_ended" ? (ended.saved ?? "") : "";
  assert.match(
    fs.readFileSync(path.join(cfg.workspace, saved), "utf8"),
    /The person: What are you doing\?\n\nFive: Hello!/,
  );
  const answers = events(five).filter((e) => e.type === "model" && e.chat).length;
  assert.equal(answers, 2);
  assert.equal(
    model.requests.filter((r) => system({ messages: r }).startsWith("You are the lead")).length,
    0,
    "paused: no lead",
  );

  five.five.start();
  await until(() => events(five).some((e) => e.type === "run_ended" && e.run === 2), "the lead's run");
  five.five.pause();
  const lead = model.requests.find((r) => system({ messages: r }).startsWith("You are the lead")) ?? [];
  assert.match(String(lead[1]?.content), /^## Goal\n\nFollow science news, above all space\./);
  assert.match(
    String(lead[1]?.content),
    /## From the person\n\nYour latest chat with them:\n\(chats\/[^)]+\) The person: What are you doing\?/,
  );
});

test("the API: status, the board, settings, the goal, the inbox, and a reset", async () => {
  const { five, cfg } = make(() => ({ content: "ok" }));
  const { server, call } = await serve(five, cfg);
  try {
    const status = (await call<Status>("GET", "/status")).body;
    assert.deepEqual(
      [status.running, status.slots, status.workers, status.board],
      [false, 4, 2, { open: 0, running: 0, done: 0, failed: 0 }],
    );
    assert.match(status.goal, /^Follow what is happening/);

    assert.equal((await call("POST", "/board", { worker: "nobody", title: "x" })).status, 400);
    const posted = await call<Task>("POST", "/board", { worker: "feeds", title: "Read the feeds" });
    assert.deepEqual([posted.status, posted.body.status, posted.body.postedBy], [200, "open", "person"]);
    const page = (await call<BoardPage>("GET", "/board?status=open")).body;
    assert.deepEqual(
      page.tasks.map((t) => t.title),
      ["Read the feeds"],
    );
    assert.equal((await call<Task>("DELETE", `/board/${posted.body.id}`)).body.status, "cancelled");
    assert.equal((await call("DELETE", `/board/${posted.body.id}`)).status, 409);

    assert.equal((await call("PUT", "/settings", { slots: 0 })).status, 400);
    const set = (await call<SettingsView>("PUT", "/settings", { slots: 2, taskRuns: 3 })).body;
    assert.deepEqual([set.settings.slots, set.settings.taskRuns, set.changed], [2, 3, ["slots", "taskRuns"]]);
    assert.equal(
      (await call<{ goal: string }>("PUT", "/goal", { goal: "Watch the weather." })).body.goal,
      "Watch the weather.",
    );
    assert.equal((await call("POST", "/inbox", { text: "hello" })).status, 200);
    assert.deepEqual(
      events(five).map((e) => e.type),
      ["task", "task", "settings", "goal", "inbox"],
    );

    fs.writeFileSync(path.join(cfg.workspace, "notes.md"), "x");
    const reset = (await call<Status>("POST", "/reset", { clean: true })).body;
    assert.deepEqual([reset.lastSeq, reset.board.open, reset.workers], [0, 0, 2]);
    assert.match(reset.goal, /^Follow what is happening/);
    assert.ok(!fs.existsSync(path.join(cfg.workspace, "notes.md")));
  } finally {
    server.close();
  }
});

test("the seed task workers are modules with a default export", async () => {
  const { transformSync } = await import("esbuild");
  const { SEEDS } = await import("../src/workers/seeds.ts");
  for (const w of SEEDS) {
    const out = transformSync(w.source, { loader: "ts", format: "esm" }).code;
    assert.match(out, /as default\b|export default/, w.name);
  }
});

test("write_file does not replace a file unless asked to, and every agent is told today's date", async () => {
  const { five, cfg, model } = make([
    { calls: [["write_file", { path: "news/day.md", content: "theirs" }]] },
    { calls: [["write_file", { path: "news/day.md", content: "mine" }]] },
    { calls: [["write_file", { path: "news/day.md", content: "mine", replace: true }]] },
    { content: "ok" },
  ]);
  await agent(five);
  const results = events(five).flatMap((e) => (e.type === "tool" ? [e.result] : []));
  assert.match(results[0] ?? "", /^wrote news\/day\.md/);
  assert.match(results[1] ?? "", /^error: news\/day\.md exists .*append_file/);
  assert.match(results[2] ?? "", /^wrote news\/day\.md/);
  assert.equal(fs.readFileSync(path.join(cfg.workspace, "news/day.md"), "utf8"), "mine");
  const first = model.requests[0]?.[0];
  assert.match(String(first?.content), /^Today is \w+day, \d{4}-\d\d-\d\d \(UTC\)\.[^\n]*\n\nYou are a test\./);
});
