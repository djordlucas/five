import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, test } from "node:test";
import { SEED_PROMPT } from "../src/agent/prompt.ts";
import { createApi } from "../src/api/server.ts";
import type { ContextView, EventsPage, Status } from "../src/api/types.ts";
import { createFive, type Five } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import type { ChatModel, Completion, CompletionRequest, Message } from "../src/llm/model.ts";

type Reply = { content?: string; calls?: [string, Record<string, unknown>][]; tokens?: number };

/** A model that gives the scripted replies in order, and records every request. */
function scripted(replies: Reply[]): ChatModel & { requests: Message[][] } {
  const requests: Message[][] = [];
  let n = 0;
  return {
    requests,
    async complete(req: CompletionRequest): Promise<Completion> {
      requests.push(structuredClone(req.messages));
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
  const cfg = loadConfig({ FIVE_WORKSPACE: dir, FIVE_TURN_DELAY_MS: "0", FIVE_MAX_STEPS: "5", ...env });
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
  const { five, model } = make([{ content: "a", tokens: 500 }, { content: "b", tokens: 700 }, { content: "c" }], {
    FIVE_CONTEXT_TOKENS: "1000",
  });
  await turn(five);
  await turn(five);
  await turn(five);
  const prompts = model.requests.map((r) => r.at(-1)?.content as string);
  assert.equal(prompts[0], SEED_PROMPT);
  assert.equal(prompts[1], SEED_PROMPT);
  assert.match(prompts[2] ?? "", /^\[five\] Your context is 700 of 1,000 tokens \(70%\)/);
  assert.match(prompts[2] ?? "", /delete_messages with start 0 and end 3 drops them all/);
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
      { calls: [["read_context", {}]] },
      { content: "idle" },
      { content: "idle" },
      { content: "idle" },
    ],
    { FIVE_IDLE_TURNS: "2" },
  );
  five.loop.start();
  while (five.loop.status().running || five.loop.status().busy) await new Promise((r) => setTimeout(r, 5));
  // The call in turn 2 reset the count: turns 3 and 4 paused it.
  assert.equal(five.loop.ctx.turn, 4);
  assert.equal(five.loop.wasRunning, false);
  const paused = five.state.eventsAfter(0, 100).find((e) => e.type === "loop" && e.state === "paused");
  assert.equal(paused?.type === "loop" && paused.reason, "2 turns in a row ended without a tool call");
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
