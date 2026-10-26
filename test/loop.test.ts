import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, test } from "node:test";
import { SEED_PROMPT } from "../src/agent/prompt.ts";
import { createApi } from "../src/api/server.ts";
import type {
  ContextView,
  DbResult,
  DbRows,
  DbTable,
  EventsPage,
  InboxMessage,
  InboxPage,
  ProcessDetail,
  ProcessInfo,
  Status,
  SupervisorView,
  WorkspaceDir,
  WorkspaceEntry,
} from "../src/api/types.ts";
import { createFive, type Five } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import type { ChatModel, Completion, CompletionRequest, Message } from "../src/llm/model.ts";

type Reply = { content?: string; calls?: [string, Record<string, unknown>][]; tokens?: number };

/**
 * A model that gives the scripted replies in order, and records every request:
 * its messages without five's self block, which ends each one, and the block
 * ("" when it is off).
 */
function scripted(replies: Reply[]): ChatModel & { requests: Message[][]; selves: string[] } {
  const requests: Message[][] = [];
  const selves: string[] = [];
  let n = 0;
  return {
    requests,
    selves,
    async complete(req: CompletionRequest): Promise<Completion> {
      const messages = structuredClone(req.messages);
      const last = messages.at(-1);
      const self = last?.role === "user" && last.content.startsWith("## You, now") ? messages.pop() : undefined;
      selves.push(self?.content ?? "");
      requests.push(messages);
      const r = replies[n++] ?? { content: "done" };
      return {
        message: {
          role: "assistant",
          content: r.content ?? null,
          ...(r.calls && {
            tool_calls: r.calls.map(([name, args], i) => ({
              id: `c${n}_${i}`,
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

function make(replies: Reply[], env: Record<string, string> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "five-test-"));
  // The idle guard, the trim and folding replies are off unless a test is about them.
  const cfg = loadConfig({
    FIVE_WORKSPACE: dir,
    FIVE_TURN_DELAY_MS: "0",
    FIVE_MAX_STEPS: "5",
    FIVE_IDLE_TURNS: "0",
    FIVE_CONTEXT_TRIM: "0",
    FIVE_FOLD_REPLIES: "off",
    ...env,
  });
  const model = scripted(replies);
  const five = createFive(cfg, model);
  open.push(five);
  return { five, model, cfg };
}

/** Run one turn and wait for it to end. */
async function turn(five: Five): Promise<void> {
  five.loop.stepOnce();
  while (five.loop.status().busy) await new Promise((r) => setTimeout(r, 5));
}

test("a turn runs tool calls until the model replies, and the next turn repeats the prompt", async () => {
  const { five, model } = make([
    { calls: [["read_context", {}]] },
    { content: "first turn over" },
    { content: "second turn over" },
  ]);
  await turn(five);
  await turn(five);
  const roles = five.loop.ctx.messages.map((m) => m.role);
  assert.deepEqual(roles, ["user", "assistant", "tool", "assistant", "user", "assistant"]);
  assert.equal(five.loop.ctx.messages[0]?.content, SEED_PROMPT);
  assert.equal(five.loop.ctx.messages[4]?.content, SEED_PROMPT);
  assert.equal(five.loop.ctx.turn, 2);
  assert.equal(model.requests.length, 3);
  const ends = five.state.eventsAfter(0, 100).filter((e) => e.type === "turn_ended");
  assert.deepEqual(
    ends.map((e) => e.type === "turn_ended" && e.reason),
    ["replied", "replied"],
  );
});

test("the agent rewrites its system prompt, its messages and its next prompt", async () => {
  const { five, model } = make([
    {
      calls: [
        ["set_system_prompt", { text: "You are a counter." }],
        ["set_next_prompt", { text: "Count." }],
      ],
    },
    { calls: [["delete_messages", { start: 0, end: 2 }]] },
    { calls: [["end_turn", {}]] },
    { content: "1" },
  ]);
  await turn(five);
  // The system prompt changed from the call after the one that changed it.
  assert.notEqual(model.requests[0]?.[0]?.content, "You are a counter.");
  assert.equal(model.requests[1]?.[0]?.content, "You are a counter.");
  // Deleting messages 0–2 (the prompt, the first call, its first result) left
  // the second result, the delete call and its result.
  assert.deepEqual(
    model.requests[2]?.map((m) => m.role),
    ["system", "tool", "assistant", "tool"],
  );
  await turn(five);
  const last = model.requests[3] as Message[];
  assert.equal(last.at(-1)?.content, "Count.");
  assert.equal(five.loop.ctx.next, "Count.");
});

test("a tool call written as text is taken as a call", async () => {
  const { five } = make([
    { content: '{"name": "set_next_prompt", "parameters": {"text": "Again."}}' },
    { content: "ok" },
  ]);
  await turn(five);
  assert.equal(five.loop.ctx.next, "Again.");
});

test("a turn ends after max steps", async () => {
  const { five } = make(Array.from({ length: 10 }, () => ({ calls: [["read_context", {}]] }) as Reply));
  await turn(five);
  const end = five.state.eventsAfter(0, 100).find((e) => e.type === "turn_ended");
  assert.equal(end?.type === "turn_ended" && end.reason, "max_steps");
});

test("the context survives a restart", async () => {
  const { five, cfg } = make([{ calls: [["set_next_prompt", { text: "Resume." }]] }, { content: "ok" }]);
  await turn(five);
  await five.close();
  open.splice(open.indexOf(five), 1);
  const again = createFive(cfg, scripted([]));
  open.push(again);
  assert.equal(again.loop.ctx.next, "Resume.");
  assert.equal(again.loop.ctx.turn, 1);
});

test("the API reports status, edits the context and pages events", async () => {
  const { five, cfg } = make([{ content: "hello" }]);
  const server = createApi({ five, cfg, log: (await import("../src/log.ts")).noopLogger });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}/api/v1`;
  const json = { "content-type": "application/json" };
  try {
    const status = (await (await fetch(`${base}/status`)).json()) as Status;
    assert.equal(status.model, "qwen3.5:9b");
    assert.equal(status.loop.running, false);

    const put = await fetch(`${base}/context/next`, { method: "PUT", headers: json, body: '{"text":"Hi."}' });
    assert.equal(((await put.json()) as ContextView).next, "Hi.");

    const form = await fetch(`${base}/context/next`, { method: "PUT", body: "text=x" });
    assert.equal(form.status, 415);
    const cross = await fetch(`${base}/loop/start`, {
      method: "POST",
      headers: { ...json, origin: "http://evil.example" },
      body: "{}",
    });
    assert.equal(cross.status, 403);

    await fetch(`${base}/loop/step`, { method: "POST", headers: json, body: "{}" });
    while (five.loop.status().busy) await new Promise((r) => setTimeout(r, 5));
    const page = (await (await fetch(`${base}/events`)).json()) as EventsPage;
    assert.deepEqual(
      page.events.map((e) => e.type),
      ["context", "turn_started", "model", "turn_ended"],
    );
    const after = (await (await fetch(`${base}/events?after=${page.last}`)).json()) as EventsPage;
    assert.equal(after.events.length, 0);
  } finally {
    server.close();
  }
});

test("seven's tools work: run_js, and define_tool then calling the tool", async () => {
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
    { calls: [["double", { n: 21 }]] },
    { content: "ok" },
  ]);
  await turn(five);
  const results = five.loop.ctx.messages.filter((m) => m.role === "tool").map((m) => m.content);
  assert.equal(results[0], "42");
  assert.match(results[1] ?? "", /^saved double/);
  assert.equal(results[2], "42");
  assert.ok(model.requests[2]?.length);
});

test("a clean reset deletes the agent's tools and workspace files, but not five's data", async () => {
  const { five, cfg } = make([
    { calls: [["define_tool", { name: "noop", description: "Nothing.", code: "export default async () => 1" }]] },
    { content: "ok" },
  ]);
  await turn(five);
  fs.writeFileSync(path.join(cfg.workspace, "notes.txt"), "x");
  five.loop.reset({ clean: true });
  assert.equal(five.store.list().length, 0);
  assert.deepEqual(fs.readdirSync(cfg.workspace), [".five"]);
  assert.equal(five.loop.ctx.turn, 0);
});

test("whether the loop was running survives a restart; a pause is remembered too", async () => {
  const { five, cfg } = make([]);
  assert.equal(five.loop.wasRunning, false);
  five.loop.start();
  await five.close();
  open.splice(open.indexOf(five), 1);
  const again = createFive(cfg, scripted([]));
  open.push(again);
  assert.equal(again.loop.wasRunning, true);
  again.loop.pause();
  assert.equal(again.loop.wasRunning, false);
});

test("a near-full context puts a warning before the turn's prompt", async () => {
  const end: [string, Record<string, unknown>][] = [["end_turn", {}]];
  const { five, model } = make([{ calls: end, tokens: 500 }, { calls: end, tokens: 700 }, { content: "c" }], {
    FIVE_CONTEXT_TOKENS: "1000",
  });
  await turn(five);
  await turn(five);
  await turn(five);
  const prompts = model.requests.map((r) => r.at(-1)?.content as string);
  assert.equal(prompts[0], SEED_PROMPT);
  assert.equal(prompts[1], SEED_PROMPT);
  assert.match(prompts[2] ?? "", /^\[five\] Your context is 700 of 1,000 tokens \(70%\)/);
  assert.match(prompts[2] ?? "", /delete_messages with start 0 and end 5 drops them all/);
  assert.ok(prompts[2]?.endsWith(SEED_PROMPT));
  const started = five.state.eventsAfter(0, 100).filter((e) => e.type === "turn_started");
  assert.deepEqual(
    started.map((e) => e.type === "turn_started" && e.prompt),
    [SEED_PROMPT, SEED_PROMPT, SEED_PROMPT],
  );
  assert.ok(started[2]?.type === "turn_started" && started[2].warning);
});

test("turns in a row without a tool call pause the loop", async () => {
  const { five } = make(
    [
      { content: "idle" },
      { calls: [["memory_write", { name: "n", text: "work" }]] },
      { content: "idle" },
      { calls: [["memory_read", {}]] },
      { content: "idle" },
      { content: "idle" },
    ],
    { FIVE_IDLE_TURNS: "2" },
  );
  five.loop.start();
  while (five.loop.status().running || five.loop.status().busy) await new Promise((r) => setTimeout(r, 5));
  // The work in turn 2 reset the count; turn 3 replied, and turn 4 only read: they paused it.
  assert.equal(five.loop.ctx.turn, 4);
  assert.equal(five.loop.wasRunning, false);
  const paused = five.state.eventsAfter(0, 100).find((e) => e.type === "loop" && e.state === "paused");
  assert.equal(paused?.type === "loop" && paused.reason, "2 turns in a row did no work");
});

test("memory notes outlive the messages they came from", async () => {
  const { five, cfg } = make([
    {
      calls: [
        ["memory_write", { name: "plan", text: "Plan: count to three.\n1, 2, 3" }],
        ["memory_write", { name: "plan", text: "Done: 1", append: true }],
        ["memory_write", { name: "../escape", text: "no" }],
        ["delete_messages", { start: 0, end: 0 }],
      ],
    },
    {
      calls: [
        ["memory_read", {}],
        ["memory_read", { name: "plan" }],
        ["memory_read", { name: "nope" }],
      ],
    },
    { content: "ok" },
  ]);
  await turn(five);
  const file = path.join(cfg.workspace, "memory", "plan.md");
  assert.equal(fs.readFileSync(file, "utf8"), "Plan: count to three.\n1, 2, 3\nDone: 1\n");
  assert.deepEqual(fs.readdirSync(path.join(cfg.workspace, "memory")), ["plan.md"]);
  const results = five.state.eventsAfter(0, 100).flatMap((e) => (e.type === "tool" ? [e] : []));
  assert.equal(results[2]?.ok, false);
  assert.match(results[4]?.result ?? "", /^1 note:\n- plan \(\d+ characters\): Plan: count to three\.$/);
  assert.equal(results[5]?.result, "Plan: count to three.\n1, 2, 3\nDone: 1\n");
  assert.equal(results[6]?.ok, false);
});

test("end_turn with a summary folds the turn into it and sets the next prompt", async () => {
  const { five, model } = make([
    { content: "turn one" },
    { calls: [["read_context", {}]] },
    { calls: [["end_turn", { summary: "Read my context.", next: "Go on." }]] },
    { content: "turn three" },
  ]);
  await turn(five);
  await turn(five);
  const msgs = five.loop.ctx.messages;
  assert.deepEqual(
    msgs.map((m) => m.role),
    ["user", "assistant", "assistant"],
  );
  assert.equal(msgs[2]?.content, "[Turn 2, summarized] Read my context.");
  assert.equal(five.loop.ctx.next, "Go on.");
  await turn(five);
  assert.equal(model.requests[3]?.at(-1)?.content, "Go on.");
});

test("a long result of a run is kept in a file, its start in the context", async () => {
  const { five, cfg } = make(
    [{ calls: [["run_js", { code: "console.log('x'.repeat(500))" }]] }, { calls: [["read_context", { full: true }]] }],
    { FIVE_RESULT_CHARS: "100" },
  );
  await turn(five);
  const results = five.state.eventsAfter(0, 100).flatMap((e) => (e.type === "tool" ? [e] : []));
  const cut = results[0]?.result ?? "";
  const file = /the whole result is in (results\/\S+\.txt)\]$/.exec(cut)?.[1];
  assert.ok(file, cut);
  assert.ok(fs.readFileSync(path.join(cfg.workspace, file), "utf8").includes("x".repeat(500)));
  // A context tool's result is never cut this way.
  assert.ok((results[1]?.result.length ?? 0) > 100);
  assert.deepEqual(fs.readdirSync(path.join(cfg.workspace, "results")), [path.basename(file)]);
});

test("a next prompt that repeats the turn or reports what is done is refused", async () => {
  const { five, model } = make(
    [
      {
        calls: [
          ["set_next_prompt", { text: SEED_PROMPT }],
          ["end_turn", { summary: "s", next: "Turn 1 complete: wrote the plan." }],
          ["end_turn", { summary: "s", next: "Awaiting user request for the next chapter." }],
          ["end_turn", { summary: "s", next: "Maintain standby mode." }],
        ],
      },
      { calls: [["end_turn", { summary: "s", next: "Write chapter two." }]] },
      { content: "idle" },
      { content: "ok" },
    ],
    { FIVE_IDLE_TURNS: "3" },
  );
  await turn(five);
  const results = five.state.eventsAfter(0, 100).flatMap((e) => (e.type === "tool" ? [e] : []));
  assert.match(results[0]?.result ?? "", /^error: that is this turn's own prompt/);
  assert.match(results[1]?.result ?? "", /^error: the next prompt reports what is done/);
  assert.match(results[2]?.result ?? "", /^error: the next prompt waits/);
  assert.match(results[3]?.result ?? "", /^error: the next prompt waits/);
  assert.equal(five.loop.ctx.next, "Write chapter two.");
  // A turn without a tool call leaves the prompt to repeat, led by a note.
  await turn(five);
  await turn(five);
  const third = model.requests[3]?.at(-1)?.content as string;
  assert.match(third, /^\[five\] Your last turn did no work/);
  assert.ok(third.endsWith("Write chapter two."));
});

test("the workspace API reads and writes files and databases, and keeps out of .five", async () => {
  const { five, cfg } = make([]);
  const server = createApi({ five, cfg, log: (await import("../src/log.ts")).noopLogger });
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
  await turn(five);
  const server = createApi({ five, cfg, log: (await import("../src/log.ts")).noopLogger });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1/processes`;
  try {
    const list = ((await (await fetch(base)).json()) as { processes: ProcessInfo[] }).processes;
    assert.equal(list.length, 2);
    const [bg, done] = list as [ProcessInfo, ProcessInfo];
    assert.deepEqual([done.kind, done.label, done.state, done.turn, done.step], ["code", "run_js", "ok", 1, 1]);
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

test("the context warning survives a restart", async () => {
  const { five, cfg } = make([{ content: "a", tokens: 900 }], { FIVE_CONTEXT_TOKENS: "1000" });
  await turn(five);
  await five.close();
  open.splice(open.indexOf(five), 1);
  const model = scripted([{ content: "b" }]);
  const again = createFive(cfg, model);
  open.push(again);
  assert.equal(again.loop.status().promptTokens, 900);
  await turn(again);
  assert.match(model.requests[0]?.at(-1)?.content as string, /^\[five\] Your context is 900 of 1,000 tokens/);
});

test("a nearly full context has its oldest messages dropped before the turn", async () => {
  const text = "x".repeat(400);
  const { five, model } = make(
    [
      { calls: [["run_js", { code: `"${text}"` }]], tokens: 300 },
      { content: text, tokens: 600 },
      { calls: [["run_js", { code: `"${text}"` }]], tokens: 900 },
      { content: text, tokens: 950 },
      { content: "c" },
    ],
    { FIVE_CONTEXT_TOKENS: "1000", FIVE_CONTEXT_TRIM: "90" },
  );
  await turn(five);
  await turn(five);
  assert.equal(five.loop.ctx.messages.length, 8);
  await turn(five);
  const sent = model.requests.at(-1) ?? [];
  const prompt = sent.at(-1)?.content as string;
  assert.match(
    prompt,
    /^\[five\] Your context was 950 of 1,000 tokens \(95%\), too full to work in, so five dropped your 5 oldest messages/,
  );
  assert.doesNotMatch(prompt, /\[five\] Your context is/);
  // The first turn and the second's prompt are gone: about half the characters.
  assert.equal(sent.length, 5);
  assert.equal(sent[1]?.role, "assistant");
  const change = five.state.eventsAfter(0, 100).find((e) => e.type === "context" && e.by === "five");
  assert.ok(change);
});

test("a turn that ends with a reply is folded into it if it did work, and leaves nothing if not", async () => {
  const { five } = make(
    [
      { calls: [["memory_write", { name: "plan", text: "Map the coast." }]] },
      { content: "Saved my plan." },
      { calls: [["end_turn", { summary: "Ended.", next: "Go on." }]] },
      { calls: [["read_context", {}]] },
      { content: "I will map the coast next." },
      { content: "  " },
    ],
    { FIVE_FOLD_REPLIES: "on" },
  );
  await turn(five);
  assert.deepEqual(
    five.loop.ctx.messages.map((m) => m.content),
    ["[Turn 1, summarized] Saved my plan."],
  );
  // end_turn's summary wins, even after no work.
  await turn(five);
  assert.equal(five.loop.ctx.messages[1]?.content, "[Turn 2, summarized] Ended.");
  // Reading and replying is no work: the turn is dropped, as is one with an empty reply.
  await turn(five);
  await turn(five);
  assert.deepEqual(
    five.loop.ctx.messages.map((m) => m.content),
    ["[Turn 1, summarized] Saved my plan.", "[Turn 2, summarized] Ended."],
  );
  const dropped = five.state.eventsAfter(0, 100).filter((e) => e.type === "context" && e.by === "five");
  assert.equal(dropped.length, 2);
});

test("a next prompt unchanged for three turns gets a note", async () => {
  const work: Reply = { calls: [["memory_write", { name: "n", text: "x" }]] };
  const { five, model } = make([
    work,
    { content: "a" },
    work,
    { content: "b" },
    work,
    { content: "c" },
    { content: "d" },
  ]);
  await turn(five);
  await turn(five);
  await turn(five);
  assert.doesNotMatch(model.requests[4]?.at(-1)?.content as string, /has not changed/);
  await turn(five);
  assert.match(model.requests[6]?.at(-1)?.content as string, /^\[five\] Your next prompt has not changed for 3 turns/);
});

test("every call ends with five's self block, with the self note; the system prompt stays as it is", async () => {
  const self: [string, Record<string, unknown>][] = [["memory_write", { name: "self", text: "I am curious." }]];
  const { five, model } = make(
    [
      { calls: self, tokens: 400 },
      { calls: [["memory_write", { name: "self", text: "x".repeat(1501) }]] },
      { content: "a" },
      { content: "b" },
    ],
    { FIVE_CONTEXT_TOKENS: "1000", FIVE_IDLE_TURNS: "3" },
  );
  await turn(five);
  assert.deepEqual(model.requests[0]?.[0], { role: "system", content: five.loop.ctx.system });
  const first = model.selves[0] ?? "";
  assert.match(first, /You are five\. This is turn 1, step 1/);
  assert.match(first, /Not written yet/);
  const second = model.selves[1] ?? "";
  assert.match(second, /this context: 400 of 1,000 tokens at the last call \(40%\)/);
  assert.match(second, /## Your self note \(memory\/self\.md\)\n\nI am curious\./);
  const tool = model.requests[2]?.at(-1)?.content as string;
  assert.match(tool, /kept to 1500 characters/);
  // Writing only the self note is no work.
  await turn(five);
  assert.match(model.requests[3]?.at(-1)?.content as string, /^\[five\] Your last turn did no work/);
});

test("the inbox: one message a turn to the person, and their reply put before the next prompt", async () => {
  const send = (text: string): [string, Record<string, unknown>] => [
    "message_person",
    { subject: `About ${text}`, text },
  ];
  const { five, cfg, model } = make([
    { calls: [["message_person", { subject: " ", text: "No subject." }], send("Found a map."), send("And another.")] },
    { content: "a" },
    { content: "b" },
  ]);
  const server = createApi({ five, cfg, log: (await import("../src/log.ts")).noopLogger });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1`;
  const json = { "content-type": "application/json" };
  try {
    await turn(five);
    const results = model.requests[1]?.filter((m) => m.role === "tool").map((m) => m.content) ?? [];
    assert.match(results[0] ?? "", /^error: give the message a subject/);
    assert.match(results[1] ?? "", /^sent\./);
    assert.match(results[2] ?? "", /one a turn/);
    const status = (await (await fetch(`${base}/status`)).json()) as Status;
    let page = (await (await fetch(`${base}/inbox`)).json()) as InboxPage;
    assert.deepEqual(
      page.messages.map((m) => [m.from, m.subject, m.text, m.turn]),
      [["five", "About Found a map.", "Found a map.", 1]],
    );
    assert.equal(status.inboxLast, page.messages[0]?.id);

    const empty = await fetch(`${base}/inbox`, { method: "POST", headers: json, body: '{"text":" "}' });
    assert.equal(empty.status, 400);
    const sent = await fetch(`${base}/inbox`, { method: "POST", headers: json, body: '{"text":"Which map?"}' });
    assert.equal(((await sent.json()) as InboxMessage).from, "person");

    await turn(five);
    const prompt = model.requests[2]?.at(-1)?.content as string;
    assert.match(prompt, /^\[The person wrote to you, during turn 1\] Which map\?/);
    assert.ok(prompt.endsWith(SEED_PROMPT));
    page = (await (await fetch(`${base}/inbox`)).json()) as InboxPage;
    assert.equal(page.messages[0]?.deliveredTurn, 2);
    // Delivered once only.
    await turn(five);
    assert.equal(model.requests[3]?.at(-1)?.content, SEED_PROMPT);
    assert.deepEqual(
      five.state
        .eventsAfter(0, 100)
        .filter((e) => e.type === "inbox")
        .map((e) => e.type === "inbox" && e.from),
      ["five", "person"],
    );
  } finally {
    server.close();
  }
});

test("the supervisor's settings change live through the API, outlive a restart, and reset", async () => {
  const send = (text: string): [string, Record<string, unknown>] => [
    "message_person",
    { subject: `About ${text}`, text },
  ];
  const { five, cfg, model } = make([{ calls: [send("One."), send("Two."), send("Three.")] }, { content: "a" }]);
  const server = createApi({ five, cfg, log: (await import("../src/log.ts")).noopLogger });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1`;
  const put = (body: unknown) =>
    fetch(`${base}/supervisor`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  try {
    let view = (await (await fetch(`${base}/supervisor`)).json()) as SupervisorView;
    assert.equal(view.settings.messagesPerTurn, 1);
    assert.deepEqual(view.changed, []);
    assert.ok(view.fields.some((f) => f.key === "contextTrim"));

    assert.equal((await put({ nope: 1 })).status, 400);
    assert.equal((await put({ messagesPerTurn: 1.5 })).status, 400);
    assert.equal((await put({ selfBlock: "no" })).status, 400);
    // A refused change changes nothing, even its valid parts.
    assert.equal((await put({ messagesPerTurn: 2, contextTrim: 101 })).status, 400);
    view = (await (await put({ messagesPerTurn: 2, selfBlock: false })).json()) as SupervisorView;
    assert.deepEqual(view.changed.sort(), ["messagesPerTurn", "selfBlock"]);

    await turn(five);
    // No self block, and two messages a turn.
    assert.equal(model.requests[0]?.at(-1)?.content, SEED_PROMPT);
    const results = model.requests[1]?.filter((m) => m.role === "tool").map((m) => m.content) ?? [];
    assert.deepEqual(
      results.map((r) => r?.slice(0, 5)),
      ["sent.", "sent.", "error"],
    );
    const changes = five.state.eventsAfter(0, 100).filter((e) => e.type === "supervisor");
    assert.equal(changes.length, 1);
    assert.match(
      changes[0]?.type === "supervisor" ? changes[0].change : "",
      /messagesPerTurn 1 → 2, selfBlock true → false/,
    );
  } finally {
    server.close();
  }

  await five.close();
  open.splice(open.indexOf(five), 1);
  const again = createFive(cfg, scripted([]));
  open.push(again);
  assert.equal(again.loop.supervisor.settings.messagesPerTurn, 2);
  again.loop.supervisor.resetSettings();
  assert.deepEqual(again.loop.supervisor.view().changed, []);
  assert.equal(again.loop.supervisor.settings.selfBlock, true);
});
