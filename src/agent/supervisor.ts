// The supervisor: every way five steps into the agent's loop, in one place,
// with one set of settings that can be changed while the loop runs.
//
// Five keeps out of the context but for these. Before a turn: a note when the
// last turn did no work, a warning when the window is filling, a trim when it
// is all but full, and a note when the next prompt has not changed for a while.
// At a turn's end: its messages are folded into the agent's summary or last
// reply, or dropped when it did no work, and turns that do no work, several in
// a row, pause the loop. Through the agent's tools: a next prompt that would
// waste a turn is refused, the self note is kept short, the person gets at
// most so many messages a turn, and a long result of a run goes to a file.
// With every model call: the self block, after the messages.
//
// The settings start from the environment (config.ts); changes made through
// the API are saved in five's state and outlive a restart. Each applies from
// the next time it is checked — most at the next turn.

import * as fs from "node:fs";
import * as path from "node:path";
import type { SupervisorField, SupervisorSettings, SupervisorView } from "../api/types.ts";
import type { Message, ToolCall } from "../llm/model.ts";
import type { Logger } from "../log.ts";
import type { Context, EventBody, State, TurnEnd } from "../state.ts";
import type { LibraryStore } from "../tools/libs.ts";
import type { ToolStore } from "../tools/store.ts";

export type { SupervisorSettings } from "../api/types.ts";

/** The memory directory, in the workspace. */
export const MEMORY_DIR = "memory";
/** The note the self block sends with every call. */
export const SELF_NOTE = "self";
/** Where long results of runs are kept, in the workspace. */
export const RESULTS_DIR = "results";
/** Tools that only read, message or end the turn: a turn that calls nothing else did no work. */
const NO_WORK = new Set(["read_context", "memory_read", "set_next_prompt", "end_turn", "message_person", "read_inbox"]);
/** A tool result longer than this is cut, whatever the settings. */
const MAX_RESULT_CHARS = 16_000;

/** Every setting, how the web UI shows it, and its bounds. */
export const FIELDS: SupervisorField[] = [
  {
    key: "contextWarn",
    group: "Working memory",
    label: "Warn above",
    unit: "%",
    min: 0,
    max: 100,
    help: "When the last call used more of the window than this, the turn's prompt starts with a warning to save and delete messages. 0: never.",
  },
  {
    key: "contextTrim",
    group: "Working memory",
    label: "Trim above",
    unit: "%",
    min: 0,
    max: 100,
    help: "Above this, the model can no longer free its window: five drops the oldest messages before the turn. 0: never.",
  },
  {
    key: "trimTo",
    group: "Working memory",
    label: "Trim down to",
    unit: "%",
    min: 10,
    max: 90,
    help: "About how full the window is after a trim.",
  },
  {
    key: "foldReplies",
    group: "Turn endings",
    label: "Fold a turn into its last reply",
    help: "A turn that did work and ends with a reply, not end_turn, is replaced by that reply, as end_turn replaces one with its summary.",
  },
  {
    key: "replySummaryChars",
    group: "Turn endings",
    label: "Longest reply kept",
    unit: "characters",
    min: 100,
    max: 10_000,
    help: "A reply a turn is folded into is cut to this.",
  },
  {
    key: "dropIdle",
    group: "Turn endings",
    label: "Drop a turn that did no work",
    help: "A turn that ends with a reply and did no work leaves nothing in the context: its reply only says what it meant to do, and a pile of those gets copied.",
  },
  {
    key: "idleTurns",
    group: "Idle turns",
    label: "Pause after",
    unit: "idle turns",
    min: 0,
    max: 100,
    help: "A turn does no work when it calls nothing beyond reading, messaging, ending the turn and writing the self note. After one, the next prompt starts with a note; after this many in a row, the loop pauses. 0: neither.",
  },
  {
    key: "staleTurns",
    group: "Idle turns",
    label: "Stale prompt after",
    unit: "turns",
    min: 0,
    max: 100,
    help: "When this many turns in a row start with the same prompt, the next one starts with a note that it may ask for work already done. 0: never.",
  },
  {
    key: "refuseRepeat",
    group: "Next prompt",
    label: "Refuse a repeat",
    help: "set_next_prompt and end_turn refuse a next prompt that is the turn's own.",
  },
  {
    key: "refuseDone",
    group: "Next prompt",
    label: "Refuse a report",
    help: 'Refuse a next prompt that opens by reporting what is done ("Turn 22 complete…").',
  },
  {
    key: "refuseWaiting",
    group: "Next prompt",
    label: "Refuse waiting",
    help: 'Refuse a next prompt that waits for a user, a request or approval ("Awaiting user request…", "standby").',
  },
  {
    key: "selfBlock",
    group: "Self and inbox",
    label: "Send the self block",
    help: "Every model call ends with five's self block: who the agent is, the turn, how full its window is, its notes, tools and inbox, and its self note.",
  },
  {
    key: "selfNoteChars",
    group: "Self and inbox",
    label: "Self note at most",
    unit: "characters",
    min: 100,
    max: 10_000,
    help: "memory_write refuses a longer self note: it is sent with every call.",
  },
  {
    key: "messagesPerTurn",
    group: "Self and inbox",
    label: "Messages to the person",
    unit: "a turn",
    min: 0,
    max: 20,
    help: "How many times a turn message_person sends. 0: it sends none.",
  },
  {
    key: "resultChars",
    group: "Results",
    label: "Result to a file above",
    unit: "characters",
    min: 0,
    max: MAX_RESULT_CHARS,
    help: "A run's result longer than this is kept whole in results/, and the context gets its start and the file's path. 0: never; results are cut at 16,000.",
  },
  {
    key: "imageSide",
    group: "Results",
    label: "Images shrunk to",
    unit: "px",
    min: 256,
    max: 2048,
    help: "view_image shrinks an image to fit this many pixels a side before the model sees it: a bigger image costs more context.",
  },
];

/** The settings when the environment sets none. */
export const DEFAULTS: SupervisorSettings = {
  contextWarn: 60,
  contextTrim: 85,
  trimTo: 50,
  foldReplies: true,
  replySummaryChars: 1500,
  dropIdle: true,
  idleTurns: 3,
  staleTurns: 3,
  refuseRepeat: true,
  refuseDone: true,
  refuseWaiting: true,
  selfBlock: true,
  selfNoteChars: 1500,
  messagesPerTurn: 1,
  resultChars: 3000,
  imageSide: 1024,
};

/** A next prompt that waits for someone: "Awaiting user request …", "Maintain standby mode …". */
const WAITING =
  /\b(awaiting|wait(ing)? (for|on|until) (the |a |an |further |new )?(user|request|instruction|input|approval|reply|response|feedback|direction)|stand(ing)?[ -]?by|on hold|until (the )?user|user('s)? (request|input|instruction|reply|response|approval))/i;

/** A next prompt that opens by reporting a finished turn or goal: "Turn 22 complete", "End turn …", "Done …". */
const DONE_REPORT =
  /^(\W*)(turn \d+ (is )?(complete|completed|done|finished|over)\b|end(ing)? (of )?turn\b|(all )?done\b|complete[d!.]|finished\b|goal (is )?(complete|achieved|done))/i;

export interface SupervisorOptions {
  state: State;
  store: ToolStore;
  libs: LibraryStore;
  workspace: string;
  contextTokens: number;
  /** The settings from the environment; saved changes go on top. */
  defaults: SupervisorSettings;
  log: Logger;
  emit: (body: EventBody) => void;
}

export class Supervisor {
  private readonly o: SupervisorOptions;
  private overrides: Partial<SupervisorSettings>;
  /** Turns in a row that did no work. */
  private idle = 0;
  /** Turns in a row that started with the prompt the turn before started with. */
  private stale = 0;
  /** Messages sent to the person this turn. */
  private messaged = 0;

  constructor(opts: SupervisorOptions) {
    this.o = opts;
    this.overrides = sanitize(parse(opts.state.getMeta("supervisor")));
  }

  get settings(): SupervisorSettings {
    return { ...this.o.defaults, ...this.overrides };
  }

  view(): SupervisorView {
    return {
      settings: this.settings,
      defaults: this.o.defaults,
      changed: Object.keys(this.overrides) as (keyof SupervisorSettings)[],
      fields: FIELDS,
      state: { idle: this.idle, stale: this.stale },
    };
  }

  /** Change some settings; an error names the first that is not valid, and nothing changes. */
  update(change: Record<string, unknown>): void {
    const next = { ...this.overrides };
    const said: string[] = [];
    for (const [key, value] of Object.entries(change)) {
      const field = FIELDS.find((f) => f.key === key);
      if (!field) throw new Error(`no setting "${key}"`);
      const k = key as keyof SupervisorSettings;
      const bad = check(field, value);
      if (bad) throw new Error(`${key}: ${bad}`);
      if (value === this.o.defaults[k]) delete next[k];
      else (next as Record<string, unknown>)[k] = value;
      if (value !== this.settings[k]) said.push(`${key} ${String(this.settings[k])} → ${String(value)}`);
    }
    this.save(next, said.join(", "));
  }

  /** Back to the settings the environment gives. */
  resetSettings(): void {
    this.save({}, "back to the defaults");
  }

  /** Forget the counts, for a context that starts over. */
  reset(): void {
    this.idle = 0;
    this.stale = 0;
  }

  /** The loop starts: an idle count from before, when it paused, no longer counts. */
  started(): void {
    this.idle = 0;
  }

  // ── before a turn ─────────────────────────────────────────────────────────

  /**
   * The notes the turn's prompt starts with, trimming the context first when
   * the last call filled nearly all of it. promptTokens: the last call's.
   */
  opening(ctx: Context, promptTokens: number | null): string[] {
    this.messaged = 0;
    const trimmed = this.trim(ctx, promptTokens);
    return [this.idleNote(), trimmed ?? this.contextWarning(ctx, promptTokens), this.staleNote()].filter(
      (n): n is string => n !== undefined,
    );
  }

  /**
   * When the last call filled nearly all the window, drop the oldest messages
   * until about trimTo of it is left, and return the note that says so. A
   * model with a full window can no longer make the call that frees it.
   */
  private trim(ctx: Context, used: number | null): string | undefined {
    const { contextTrim, trimTo } = this.settings;
    const { contextTokens } = this.o;
    const { messages } = ctx;
    if (contextTrim <= 0 || used === null || used < (contextTrim / 100) * contextTokens || !messages.length) {
      return undefined;
    }
    const sizes = messages.map(chars);
    const total = sizes.reduce((a, b) => a + b, 0);
    // Characters stand in for tokens: drop the share of them that is over the aim.
    const over = total * (1 - ((trimTo / 100) * contextTokens) / used);
    let cut = 0;
    for (let dropped = 0; cut < messages.length && dropped < over; cut++) dropped += sizes[cut] ?? 0;
    // A tool result without the call before it is no message the model can read.
    while (messages[cut]?.role === "tool") cut++;
    messages.splice(0, cut);
    this.o.emit({ type: "context", by: "five", change: `the ${cut} oldest messages dropped to free the window` });
    this.o.log.warn("context trimmed", { messages: cut, prompt_tokens: used });
    return `[five] Your context was ${tokens(used)} of ${tokens(contextTokens)} tokens (${share(used, contextTokens)}%), too full to work in, so five dropped your ${cut} oldest messages. What you saved with memory_write is still there: memory_read lists it. Keep the window small from now on: end every turn with end_turn(summary, next), and delete messages you no longer need.`;
  }

  /** The warning when the last call filled most of the window. */
  private contextWarning(ctx: Context, used: number | null): string | undefined {
    const { contextWarn } = this.settings;
    const { contextTokens } = this.o;
    if (contextWarn <= 0 || used === null || used < (contextWarn / 100) * contextTokens) return undefined;
    const before = ctx.messages.length;
    const drop =
      before > 0
        ? ` Messages 0–${before - 1} came before this turn: delete_messages with start 0 and end ${before - 1} drops them all, or pick the ones to drop with read_context.`
        : "";
    return `[five] Your context is ${tokens(used)} of ${tokens(contextTokens)} tokens (${share(used, contextTokens)}%). When it is full the oldest text is silently lost and you can no longer work. Before anything else, save what you still need with memory_write, then delete messages you no longer need.${drop}`;
  }

  /** The note after a turn that did no work. */
  private idleNote(): string | undefined {
    if (this.idle === 0 || this.settings.idleTurns <= 0) return undefined;
    return "[five] Your last turn did no work: it called nothing beyond reading, messaging and ending the turn, so it was wasted. What you do next is yours to decide: do the next piece of work now. If your goal is done, rewrite ## Goal in your system prompt with a new goal and start it. End the turn with end_turn(summary, next), where next says what to do — not what was done, and never to wait.";
  }

  /** The note when the turns before all started with this same prompt. */
  private staleNote(): string | undefined {
    const { staleTurns } = this.settings;
    if (staleTurns <= 0 || this.stale < staleTurns) return undefined;
    return `[five] Your next prompt has not changed for ${this.stale} turns, so it may ask for work that is done. Read your progress notes, decide what comes next, and set it with end_turn(summary, next).`;
  }

  // ── during a turn ─────────────────────────────────────────────────────────

  /** Whether a call does work: anything but reading, messaging, ending the turn, or writing the self note. */
  isWork(call: ToolCall): boolean {
    const { name, arguments: args } = call.function;
    if (NO_WORK.has(name)) return false;
    if (name === "memory_write") {
      try {
        return String((JSON.parse(args) as { name?: unknown }).name).replace(/\.md$/, "") !== SELF_NOTE;
      } catch {
        return true;
      }
    }
    return true;
  }

  /** Why a next prompt would waste the next turn, if it would. turnPrompt: the one this turn started with. */
  checkNext(text: string, turnPrompt: string): string | undefined {
    const { refuseRepeat, refuseDone, refuseWaiting } = this.settings;
    const t = text.trim();
    if (!t) return "error: the next prompt cannot be empty";
    if (refuseRepeat && t === turnPrompt.trim()) {
      return "error: that is this turn's own prompt, so the next turn would redo this one; say what to do next";
    }
    if (refuseWaiting && WAITING.test(t)) {
      return (
        "error: the next prompt waits — for a user, a request or approval — and a prompt is answered by no one: the turn " +
        "would be wasted. To ask the person, use message_person; a reply comes before a later turn, if at all. Decide " +
        "what to do next yourself and say it; if your goal is done, rewrite ## Goal with a new one and start it"
      );
    }
    if (refuseDone && DONE_REPORT.test(t)) {
      return (
        "error: the next prompt reports what is done instead of saying what to do next. Put the report in the summary; " +
        "make the next prompt an instruction, and if your goal is done, rewrite ## Goal with a new one and start it"
      );
    }
    return undefined;
  }

  /** Why a write to the self note would make it too long, if it would. */
  checkSelfNote(length: number): string | undefined {
    const max = this.settings.selfNoteChars;
    if (length <= max) return undefined;
    return `error: the ${SELF_NOTE} note is sent with every call, so it is kept to ${max} characters; this would make it ${length}. Rewrite it shorter.`;
  }

  /** Put a message in the person's inbox, unless this turn sent its share. */
  sendMessage(turn: number, subject: string, text: string): string {
    const max = this.settings.messagesPerTurn;
    if (max <= 0) return "error: messages to the person are off for now. Keep working.";
    if (this.messaged >= max) {
      return `error: you sent the person ${max === 1 ? "a message" : `${max} messages`} this turn already; ${max === 1 ? "one" : max} a turn. Keep working.`;
    }
    this.messaged++;
    const m = this.o.state.addInbox(turn, "five", text, { subject });
    this.o.emit({ type: "inbox", from: "five", subject, text });
    this.o.log.info("message sent", { id: m.id });
    return "sent. The person reads the inbox now and then; a reply, if one comes, is put before the prompt of a later turn. Do not wait for it: go on with your work.";
  }

  /** A run's result, cut to fit the context: a long one is kept whole in a file the context points to. */
  fit(result: string, call: ToolCall, turn: number, contextTool: boolean): string {
    const { resultChars } = this.settings;
    if (resultChars <= 0 || result.length <= resultChars || contextTool) return truncate(result);
    const rel = path.join(RESULTS_DIR, `turn-${turn}-${call.id.replace(/[^\w-]/g, "_")}.txt`);
    try {
      fs.mkdirSync(path.join(this.o.workspace, RESULTS_DIR), { recursive: true });
      fs.writeFileSync(path.join(this.o.workspace, rel), result);
    } catch (err) {
      this.o.log.warn("result not kept", { error: err instanceof Error ? err.message : String(err) });
      return truncate(result);
    }
    return `${result.slice(0, resultChars)}\n… [${result.length - resultChars} more characters; the whole result is in ${rel}]`;
  }

  /**
   * Five's self block, sent after the messages with every model call and
   * never stored; undefined when it is off. Last, because it changes with
   * every call: Ollama reuses its work on the start of a prompt that did not
   * change, and a block at the start would make it read the whole context
   * again on every call.
   */
  selfBlock(ctx: Context, step: number, used: number | null): string | undefined {
    if (!this.settings.selfBlock) return undefined;
    const { contextTokens, state, store, workspace } = this.o;
    const born = state.getMeta("born");
    const goal = /^## Goal[ \t]*\n+([^\n]+)/m.exec(ctx.system)?.[1]?.trim();
    const tools = store.list().map((t) => t.name);
    const libraries = this.o.libs.list().map((l) => l.name);
    let notes = 0;
    let self = "";
    try {
      notes = fs.readdirSync(path.join(workspace, MEMORY_DIR)).filter((f) => f.endsWith(".md")).length;
      self = fs.readFileSync(path.join(workspace, MEMORY_DIR, `${SELF_NOTE}.md`), "utf8").trim();
    } catch {
      // No memory yet, or no self note.
    }
    const inbox = state.inboxCounts();
    return [
      "## You, now",
      "",
      "Five writes this block for every model call, after your messages; it is not one of them, and not part of the prompt you edit.",
      "",
      `You are five. This is turn ${ctx.turn}${step ? `, step ${step}` : ""}${born ? `; you have run since ${born.slice(0, 16).replace("T", " ")} UTC` : ""}.`,
      ...(goal ? [`Your goal: ${clip(goal, 240)}`] : []),
      `Working memory — this context: ${used === null ? "not measured yet" : `${tokens(used)} of ${tokens(contextTokens)} tokens at the last call (${share(used, contextTokens)}%)`}, ${ctx.messages.length} messages.`,
      `Long-term memory: ${notes} note${notes === 1 ? "" : "s"} in ${MEMORY_DIR}/. Tools you built: ${tools.length ? clip(tools.join(", "), 300) : "none yet"}. Libraries: ${libraries.length ? clip(libraries.join(", "), 200) : "none yet"}.`,
      `Inbox: ${inbox.sent} message${inbox.sent === 1 ? "" : "s"} sent to the person${inbox.lastSentTurn === null ? "" : `, the last on turn ${inbox.lastSentTurn}`}; ${inbox.received} from them${inbox.unread ? `, ${inbox.unread} unread: read_inbox shows ${inbox.unread === 1 ? "it" : "them"}` : ""}. read_inbox shows what was said.`,
      "",
      `## Your self note (${MEMORY_DIR}/${SELF_NOTE}.md)`,
      "",
      self ||
        `Not written yet. It is the one note sent with every call: who you are, what you care about, how you work best — in your own words, at most ${this.settings.selfNoteChars} characters. memory_write with name "${SELF_NOTE}" writes it.`,
    ].join("\n");
  }

  // ── at a turn's end ───────────────────────────────────────────────────────

  /** The agent ended the turn with end_turn: fold it into the summary, if one was given. */
  endedWithSummary(ctx: Context, opening: Message, summary: string | undefined): void {
    if (summary) this.fold(ctx, opening, summary);
  }

  /**
   * The agent ended the turn with a reply: a small model often forgets
   * end_turn, so its last reply stands in for the summary. A turn that did no
   * work leaves nothing: its reply would only say what it meant to do, and a
   * context full of those, alike, gets copied rather than acted on.
   */
  endedWithReply(ctx: Context, opening: Message, reply: string | undefined, worked: boolean): void {
    const { foldReplies, dropIdle, replySummaryChars } = this.settings;
    if (!worked && dropIdle) this.drop(ctx, opening);
    else if (foldReplies && reply) this.fold(ctx, opening, clip(reply, replySummaryChars));
  }

  /** Count the turn that ended; the reason to pause the loop, if it should. */
  ended(turn: { worked: boolean; reason: TurnEnd; prompt: string; next: string }): string | undefined {
    const { worked, reason, prompt, next } = turn;
    const counted = reason !== "stopped" && reason !== "error";
    this.idle = worked || !counted ? 0 : this.idle + 1;
    if (counted) this.stale = next === prompt ? this.stale + 1 : 0;
    const { idleTurns } = this.settings;
    return idleTurns > 0 && this.idle >= idleTurns ? `${this.idle} turns in a row did no work` : undefined;
  }

  /**
   * Replace the turn's messages, from its prompt on, with the agent's summary.
   * When the agent deleted its prompt, the turn's messages stay.
   */
  private fold(ctx: Context, opening: Message, summary: string): void {
    const { messages, turn } = ctx;
    const i = messages.indexOf(opening);
    if (i < 0) return;
    const n = messages.length - i;
    messages.splice(i, n, { role: "assistant", content: `[Turn ${turn}, summarized] ${summary}` });
    this.o.emit({ type: "context", by: "model", change: `turn ${turn}'s ${n} messages replaced by its summary` });
    this.o.log.info("turn folded", { turn, messages: n });
  }

  /** Remove the turn's messages, from its prompt on: a turn that did no work. */
  private drop(ctx: Context, opening: Message): void {
    const { messages, turn } = ctx;
    const i = messages.indexOf(opening);
    if (i < 0) return;
    const n = messages.length - i;
    messages.splice(i, n);
    this.o.emit({ type: "context", by: "five", change: `turn ${turn}'s ${n} messages dropped: it did no work` });
    this.o.log.info("turn dropped", { turn, messages: n });
  }

  private save(overrides: Partial<SupervisorSettings>, change: string): void {
    this.overrides = overrides;
    this.o.state.setMeta("supervisor", JSON.stringify(overrides));
    if (!change) return;
    this.o.emit({ type: "supervisor", change });
    this.o.log.info("supervisor settings changed", { change });
  }
}

/** Why a value does not fit a setting, if it does not. */
function check(field: SupervisorField, value: unknown): string | undefined {
  const flag = typeof DEFAULTS[field.key] === "boolean";
  if (flag) return typeof value === "boolean" ? undefined : "must be true or false";
  if (typeof value !== "number" || !Number.isInteger(value)) return "must be a whole number";
  if (field.min !== undefined && value < field.min) return `must be at least ${field.min}`;
  if (field.max !== undefined && value > field.max) return `must be at most ${field.max}`;
  return undefined;
}

/** Saved overrides that still name a setting and fit it: one saved by an older five may not. */
function sanitize(saved: Record<string, unknown>): Partial<SupervisorSettings> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(saved)) {
    const field = FIELDS.find((f) => f.key === key);
    if (field && !check(field, value)) out[key] = value;
  }
  return out as Partial<SupervisorSettings>;
}

function parse(json: string | undefined): Record<string, unknown> {
  try {
    const v = JSON.parse(json ?? "{}") as unknown;
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function truncate(s: string): string {
  if (s.length <= MAX_RESULT_CHARS) return s;
  return `${s.slice(0, MAX_RESULT_CHARS)}\n… [truncated ${s.length - MAX_RESULT_CHARS} of ${s.length} characters]`;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)} … [cut]`;
}

function tokens(n: number): string {
  return n.toLocaleString("en-US");
}

function share(used: number, of: number): number {
  return Math.round((100 * used) / of);
}

/** A message's length in characters: its text and its calls. */
function chars(m: Message): number {
  let n = m.content?.length ?? 0;
  for (const c of (m.role === "assistant" && m.tool_calls) || [])
    n += c.function.name.length + c.function.arguments.length;
  return n;
}
