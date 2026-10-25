// The context tools: the agent reads and rewrites everything it is sent —
// the system prompt, every message, and the prompt that starts its next turn.
// A change applies from the next model call; nothing else keeps a copy, so
// what the agent deletes is gone — but for its memory: notes it saves as files
// in <workspace>/memory, to read back in any later turn. One note, self, is
// sent with every call in five's self block. message_person writes to the
// inbox the person reads; it never waits for an answer.

import * as fs from "node:fs";
import * as path from "node:path";
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
  /** Where the memory directory lives. */
  workspace: string;
  /** The prompt this turn started with, without five's warnings. */
  turnPrompt: string;
  /** Records a change for the event log. */
  changed(change: string): void;
  /** Ends the turn once this step's calls are done; with a summary, it replaces the turn's messages. */
  endTurn(summary?: string): void;
  /** Five's self block, as the next model call will send it. */
  selfBlock(): string;
  /** Puts a message in the person's inbox; an error when one was sent this turn already. */
  sendMessage(text: string): string;
}

/** Characters of each message read_context shows unless asked for full text. */
const PREVIEW_CHARS = 200;
/** The memory directory, in the workspace. */
export const MEMORY_DIR = "memory";
const NOTE_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** The note five's self block sends with every call. */
export const SELF_NOTE = "self";
/** The longest the self note may be. */
export const SELF_NOTE_CHARS = 1500;

export const contextTools: ContextTool[] = [
  {
    name: "read_context",
    description:
      "Show your context — your working memory: token use, the next prompt, the system prompt's size, and your " +
      "messages with their indices, which edit_message, insert_message and delete_messages take. Indices shift " +
      "after an insert or delete, so read again before the next edit.",
    parameters: {
      type: "object",
      properties: {
        start: { type: "integer", description: "First message index to show. Default 0." },
        end: { type: "integer", description: "Last message index to show, inclusive. Default the last." },
        full: { type: "boolean", description: `Show whole messages, not the first ${PREVIEW_CHARS} characters.` },
        system: { type: "boolean", description: "Also show the system prompt and five's self block in full." },
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
        `System prompt: ${ctx.system.length} characters. Five's self block, after your messages: ${env.selfBlock().length} characters.`,
        ctx.messages.length === 0
          ? "Messages: none."
          : `Messages: ${ctx.messages.length} (indices 0–${last}); showing ${start}–${end}.`,
      ];
      if (a.system === true) {
        lines.push("", "=== system prompt ===", ctx.system, "", "=== five's self block ===", env.selfBlock());
      }
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
      const bad = checkNext(text, env);
      if (bad) return bad;
      env.ctx.next = text;
      env.changed("next prompt set");
      return `next prompt set (${text.length} characters)`;
    },
  },
  {
    name: "memory_write",
    description:
      "Save a note to your memory, which outlives your context: a file memory/<name>.md in the workspace. It " +
      "replaces the note of that name, or adds to its end with append=true; empty text deletes it. Save anything " +
      "you will need later before you delete the messages it is in.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Lowercase letters, digits, - and _: e.g. plan, progress, lessons." },
        text: { type: "string", description: "Markdown. Make the first line a summary: memory_read lists it." },
        append: { type: "boolean", description: "Add to the end of the note instead of replacing it." },
      },
      required: ["name", "text"],
    },
    run(a, env) {
      const name = String(a.name).replace(/\.md$/, "");
      if (!NOTE_NAME.test(name)) return `error: "${name}" is not a note name: use lowercase letters, digits, - and _`;
      const file = notePath(env, name);
      const text = String(a.text);
      if (name === SELF_NOTE) {
        const before = a.append === true && fs.existsSync(file) ? fs.readFileSync(file, "utf8").length : 0;
        if (before + text.length > SELF_NOTE_CHARS) {
          return `error: the ${SELF_NOTE} note is sent with every call, so it is kept to ${SELF_NOTE_CHARS} characters; this would make it ${before + text.length}. Rewrite it shorter.`;
        }
      }
      if (!text.trim() && a.append !== true) {
        if (!fs.existsSync(file)) return `error: there is no note "${name}"`;
        fs.rmSync(file);
        env.changed(`note ${name} deleted`);
        return `note "${name}" deleted`;
      }
      fs.mkdirSync(path.dirname(file), { recursive: true });
      if (a.append === true) fs.appendFileSync(file, text.endsWith("\n") ? text : `${text}\n`);
      else fs.writeFileSync(file, text.endsWith("\n") ? text : `${text}\n`);
      const size = fs.statSync(file).size;
      env.changed(`note ${name} ${a.append === true ? "appended to" : "saved"}`);
      return `note "${name}" ${a.append === true ? "appended to" : "saved"}: ${size} bytes in ${MEMORY_DIR}/${name}.md`;
    },
  },
  {
    name: "memory_read",
    description:
      "Read your memory: without a name, the list of your notes with their first lines; with a name, that note.",
    parameters: {
      type: "object",
      properties: { name: { type: "string", description: "The note to read. Default: list them all." } },
    },
    run(a, env) {
      if (a.name === undefined || a.name === "") {
        const dir = path.join(env.workspace, MEMORY_DIR);
        const names = fs.existsSync(dir)
          ? fs
              .readdirSync(dir)
              .filter((f) => f.endsWith(".md"))
              .map((f) => f.slice(0, -3))
              .sort()
          : [];
        if (names.length === 0) return "Your memory is empty. memory_write saves a note.";
        return [
          `${names.length} note${names.length === 1 ? "" : "s"}:`,
          ...names.map((n) => {
            const text = fs.readFileSync(notePath(env, n), "utf8");
            return `- ${n} (${text.length} characters): ${clip(text.split("\n", 1)[0] ?? "", 120)}`;
          }),
        ].join("\n");
      }
      const name = String(a.name).replace(/\.md$/, "");
      if (!NOTE_NAME.test(name) || !fs.existsSync(notePath(env, name))) {
        return `error: there is no note "${name}"; memory_read without a name lists them`;
      }
      return fs.readFileSync(notePath(env, name), "utf8");
    },
  },
  {
    name: "message_person",
    description:
      "Send a message to the person who follows your work: progress, a finding, a question. At most one a turn. It " +
      "does not wait: a reply, if one comes, is put before the prompt of a later turn. Keep working meanwhile.",
    parameters: {
      type: "object",
      properties: { text: { type: "string", description: "The message, in a few lines." } },
      required: ["text"],
    },
    run(a, env) {
      const text = String(a.text).trim();
      if (!text) return "error: the message is empty";
      return env.sendMessage(text);
    },
  },
  {
    name: "end_turn",
    description:
      "End this turn after this step's calls. With a summary, every message of this turn — from its prompt on — is " +
      "replaced by the summary, which keeps your context small. With next, set the prompt of your next turn. " +
      "Replying without any tool call ends the turn too: your reply then stands in for the summary.",
    parameters: {
      type: "object",
      properties: {
        summary: {
          type: "string",
          description:
            "A few lines: what this turn did and found, and what is in memory. Replaces the turn's messages.",
        },
        next: {
          type: "string",
          description: "The prompt of your next turn: what to do, and which notes and files to read first.",
        },
      },
    },
    run(a, env) {
      const next = typeof a.next === "string" ? a.next.trim() : "";
      const bad = next ? checkNext(next, env) : undefined;
      if (bad) return `${bad}. The turn goes on: call end_turn again with a next prompt that does.`;
      if (next) {
        env.ctx.next = next;
        env.changed("next prompt set");
      }
      const summary = typeof a.summary === "string" ? a.summary.trim() : "";
      env.endTurn(summary || undefined);
      return [
        "the turn ends after this step",
        summary ? "its messages are replaced by your summary" : "its messages stay: pass a summary to replace them",
        next ? "next prompt set" : "the next prompt is unchanged",
      ].join("; ");
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

/** Why a next prompt would waste the next turn, if it would. */
function checkNext(text: string, env: ContextEnv): string | undefined {
  const t = text.trim();
  if (!t) return "error: the next prompt cannot be empty";
  if (t === env.turnPrompt.trim()) {
    return "error: that is this turn's own prompt, so the next turn would redo this one; say what to do next";
  }
  if (WAITING.test(t)) {
    return (
      "error: the next prompt waits — for a user, a request or approval — and a prompt is answered by no one: the turn " +
      "would be wasted. To ask the person, use message_person; a reply comes before a later turn, if at all. Decide " +
      "what to do next yourself and say it; if your goal is done, rewrite ## Goal with a new one and start it"
    );
  }
  if (DONE_REPORT.test(t)) {
    return (
      "error: the next prompt reports what is done instead of saying what to do next. Put the report in the summary; " +
      "make the next prompt an instruction, and if your goal is done, rewrite ## Goal with a new one and start it"
    );
  }
  return undefined;
}

/** A next prompt that waits for someone: "Awaiting user request …", "Maintain standby mode …". */
const WAITING =
  /\b(awaiting|wait(ing)? (for|on|until) (the |a |an |further |new )?(user|request|instruction|input|approval|reply|response|feedback|direction)|stand(ing)?[ -]?by|on hold|until (the )?user|user('s)? (request|input|instruction|reply|response|approval))/i;

/** A next prompt that opens by reporting a finished turn or goal: "Turn 22 complete", "End turn …", "Done …". */
const DONE_REPORT =
  /^(\W*)(turn \d+ (is )?(complete|completed|done|finished|over)\b|end(ing)? (of )?turn\b|(all )?done\b|complete[d!.]|finished\b|goal (is )?(complete|achieved|done))/i;

function notePath(env: ContextEnv, name: string): string {
  return path.join(env.workspace, MEMORY_DIR, `${name}.md`);
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
