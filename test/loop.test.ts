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

type Reply = { content?: string; calls?: [string, Record<string, unknown>][] };

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
        usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
      };
    },
  };
}

const open: Five[] = [];
afterEach(async () => {
  for (const f of open.splice(0)) await f.close();
});

function make(replies: Reply[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "five-test-"));
  const cfg = loadConfig({ FIVE_WORKSPACE: dir, FIVE_TURN_DELAY_MS: "0", FIVE_MAX_STEPS: "5" });
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
