// The context tools: the agent reads and rewrites everything it is sent —
// the system prompt, every message, and the prompt that starts its next turn.
// A change applies from the next model call; nothing else keeps a copy, so
// what the agent deletes is gone.

import type { Message, ToolDef } from "../llm/model.ts";
import type { Context } from "../state.ts";

export interface ContextTool extends ToolDef {
  run(args: Record<string, unknown>, env: ContextEnv): string;
}

export interface ContextEnv {
  ctx: Context;
  /** Prompt tokens of the last model call, when known. */
  promptTokens?: number;
  contextTokens: number;
  /** Records a change for the event log. */
  changed(change: string): void;
  /** Ends the turn once this step's calls are done. */
  endTurn(): void;
}

/** Characters of each message read_context shows unless asked for full text. */
const PREVIEW_CHARS = 200;

export const contextTools: ContextTool[] = [
  {
    name: "read_context",
    description:
      "Show your context: token use, the next prompt, the system prompt's size, and your messages with their " +
      "indices, which edit_message, insert_message and delete_messages take. Indices shift after an insert or " +
      "delete, so read again before the next edit.",
    parameters: {
      type: "object",
      properties: {
        start: { type: "integer", description: "First message index to show. Default 0." },
        end: { type: "integer", description: "Last message index to show, inclusive. Default the last." },
        full: { type: "boolean", description: `Show whole messages, not the first ${PREVIEW_CHARS} characters.` },
        system: { type: "boolean", description: "Also show the system prompt in full." },
      },
    },
    run(a, env) {
      const { ctx } = env;
      const last = ctx.messages.length - 1;
      const start = clamp(int(a.start, 0), 0, Math.max(0, last));
      const end = clamp(int(a.end, last), start, last);
      const used = env.promptTokens === undefined ? "not measured yet" : `${env.promptTokens} of ${env.contextTokens}`;
      const lines = [
        `Tokens used by the last model call: ${used}. When the window is full, the oldest text is silently lost.`,
        `Turn ${ctx.turn}. Next prompt: ${JSON.stringify(ctx.next)}`,
        `System prompt: ${ctx.system.length} characters.`,
        ctx.messages.length === 0
          ? "Messages: none."
          : `Messages: ${ctx.messages.length} (indices 0–${last}); showing ${start}–${end}.`,
      ];
      if (a.system === true) lines.push("", "=== system prompt ===", ctx.system);
      for (let i = start; i <= end && i <= last; i++) {
        const m = ctx.messages[i] as Message;
        lines.push("", `=== [${i}] ${label(m)} ===`, a.full === true ? (m.content ?? "") : clip(m.content ?? ""));
      }
      return lines.join("\n");
    },
  },
  {
    name: "set_system_prompt",
    description: "Replace your whole system prompt. It applies from your next model call.",
    parameters: {
      type: "object",
      properties: { text: { type: "string", description: "The new system prompt." } },
      required: ["text"],
    },
    run(a, env) {
      const text = String(a.text);
      if (!text.trim()) return "error: the system prompt cannot be empty";
      const before = env.ctx.system.length;
      env.ctx.system = text;
      env.changed(`system prompt replaced (${before} → ${text.length} characters)`);
      return `system prompt replaced: ${before} → ${text.length} characters`;
    },
  },
  {
    name: "edit_system_prompt",
    description:
      "Replace one exact passage of your system prompt with new text (empty to delete it). The passage must occur " +
      "exactly once. It applies from your next model call.",
    parameters: {
      type: "object",
      properties: {
        old: { type: "string", description: "The exact text to replace." },
        new: { type: "string", description: "Its replacement." },
      },
      required: ["old", "new"],
    },
    run(a, env) {
      const old = String(a.old);
      const count = old ? env.ctx.system.split(old).length - 1 : 0;
      if (count === 0) return "error: that text is not in the system prompt; read_context with system=true shows it";
      if (count > 1) return `error: that text occurs ${count} times; include more of it so it occurs once`;
      env.ctx.system = env.ctx.system.replace(old, () => String(a.new));
      env.changed(`system prompt edited (now ${env.ctx.system.length} characters)`);
      return `system prompt edited: now ${env.ctx.system.length} characters`;
    },
  },
  {
    name: "edit_message",
    description: "Replace the text of the message at an index.",
    parameters: {
      type: "object",
      properties: { index: { type: "integer" }, content: { type: "string" } },
      required: ["index", "content"],
    },
    run(a, env) {
      const i = int(a.index, -1);
      const m = env.ctx.messages[i];
      if (!m) return outOfRange(i, env.ctx);
      m.content = String(a.content);
      env.changed(`message ${i} edited`);
      return `message ${i} (${label(m)}) edited`;
    },
  },
  {
    name: "insert_message",
    description:
      "Insert a message into your context, at an index or at the end: a note to yourself, a summary that replaces " +
      "messages you delete, or anything you want to see from now on.",
    parameters: {
      type: "object",
      properties: {
        content: { type: "string" },
        role: { type: "string", enum: ["user", "assistant"], description: "Default user." },
        index: { type: "integer", description: "Where to insert it. Default the end." },
      },
      required: ["content"],
    },
    run(a, env) {
      const { messages } = env.ctx;
      const i = a.index === undefined ? messages.length : int(a.index, -1);
      if (i < 0 || i > messages.length) return outOfRange(i, env.ctx, true);
      const role = a.role === "assistant" ? "assistant" : "user";
      messages.splice(i, 0, { role, content: String(a.content) });
      env.changed(`${role} message inserted at ${i}`);
      return `inserted a ${role} message at index ${i}; the messages after it moved up by one`;
    },
  },
  {
    name: "delete_messages",
    description: "Delete the messages from start to end, inclusive, from your context, for good.",
    parameters: {
      type: "object",
      properties: {
        start: { type: "integer" },
        end: { type: "integer", description: "Default start: one message." },
      },
      required: ["start"],
    },
    run(a, env) {
      const { messages } = env.ctx;
      const start = int(a.start, -1);
      const end = a.end === undefined ? start : int(a.end, -1);
      if (!messages[start]) return outOfRange(start, env.ctx);
      if (!messages[end] || end < start) return outOfRange(end, env.ctx);
      messages.splice(start, end - start + 1);
      const n = end - start + 1;
      env.changed(`messages ${start}–${end} deleted`);
      return `deleted ${n} message${n === 1 ? "" : "s"} (${start}–${end}); ${messages.length} remain`;
    },
  },
  {
    name: "set_next_prompt",
    description:
      "Set the user message that starts your next turn. Without it, the next turn starts with the same prompt as this one.",
    parameters: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
    run(a, env) {
      const text = String(a.text);
      if (!text.trim()) return "error: the next prompt cannot be empty";
      env.ctx.next = text;
      env.changed("next prompt set");
      return `next prompt set (${text.length} characters)`;
    },
  },
  {
    name: "end_turn",
    description:
      "End this turn after this step's calls. Replying without any tool call ends it too. The next turn starts with the next prompt.",
    parameters: { type: "object", properties: {} },
    run(_a, env) {
      env.endTurn();
      return "the turn ends after this step";
    },
  },
];

export const contextToolsByName = new Map(contextTools.map((t) => [t.name, t]));

function label(m: Message): string {
  if (m.role === "tool") return `tool result of ${m.name}`;
  if (m.role === "assistant" && m.tool_calls?.length) {
    return `assistant, calling ${m.tool_calls.map((c) => `${c.function.name} ${clip(c.function.arguments, 120)}`).join("; ")}`;
  }
  return m.role;
}

function clip(s: string, n = PREVIEW_CHARS): string {
  return s.length > n ? `${s.slice(0, n)}… (${s.length} characters)` : s;
}

function outOfRange(i: number, ctx: Context, insert = false): string {
  const max = insert ? ctx.messages.length : ctx.messages.length - 1;
  return ctx.messages.length === 0 && !insert
    ? "error: there are no messages"
    : `error: no message at index ${i}; indices run from 0 to ${max}`;
}

function int(v: unknown, fallback: number): number {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isInteger(n) ? n : fallback;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(Math.max(n, lo), hi);
}
