// The supervisor: one agent, one context, turns without end.
//
// A turn appends the next prompt to the context as a user message, then asks
// the model, runs the tools it calls and asks again, until it replies without
// a call, calls end_turn, or runs out of steps. The next turn starts with the
// prompt the agent set with set_next_prompt, or the same one. The context is
// saved after every change, so a restart resumes it.
//
// Five keeps out of the context but for its guards: when the last call filled
// most of the window, the turn's prompt starts with a warning, and when it
// filled nearly all of it, five drops the oldest messages itself; and turns
// that do no work, several in a row, pause the loop. A turn is folded into
// the summary the agent ends it with, or into its last reply, and a long
// result of a run is kept in a file, with only its start in the context.
//
// Every model call also ends with five's self block, after the messages: who
// the agent is, how full its working memory is, what it has built, and its own
// self note. Last, because it changes with every call: Ollama reuses its work
// on the start of a prompt that did not change, and a block at the start would
// make it read the whole context again on every call. The person's inbox replies are put before the next turn's prompt.

import * as fs from "node:fs";
import * as path from "node:path";
import type { InboxMessage, LoopStatus } from "../api/types.ts";
import type { ChatModel, Message, ToolCall, ToolDef } from "../llm/model.ts";
import { recoverToolCalls } from "../llm/textcalls.ts";
import { type Logger, noopLogger, preview } from "../log.ts";
import type { Runner } from "../runner/index.ts";
import type { Context, Event, EventBody, State, TurnEnd } from "../state.ts";
import type { ToolStore } from "../tools/store.ts";
import { checkArgs, coerceArgs, parseArgs } from "./args.ts";
import { awaitRun, type BuiltinContext, builtins, disabledError, formatRun, startGenerated } from "./builtins/index.ts";
import { sleep } from "./builtins/shared.ts";
import {
  type ContextEnv,
  contextTools,
  contextToolsByName,
  MEMORY_DIR,
  SELF_NOTE,
  SELF_NOTE_CHARS,
} from "./context.ts";
import { SEED_PROMPT, seedSystemPrompt } from "./prompt.ts";
import type { RunTable } from "./runs.ts";

/** Who calls tools, in run histories. */
export const AGENT_ID = "five";

/** A tool result longer than this is cut. */
const MAX_RESULT_CHARS = 16_000;
/** Tools that only read or end the turn: a turn that calls nothing else did no work. */
const NO_WORK = new Set(["read_context", "memory_read", "set_next_prompt", "end_turn", "message_person"]);
/** Where long results of runs are kept, in the workspace. */
export const RESULTS_DIR = "results";
/** The longest last reply a turn is folded into. */
const MAX_REPLY_SUMMARY_CHARS = 1500;
/** Share of the window a trim aims to leave the context at. */
const TRIM_TO = 0.5;
/** Waits after a failed turn, doubling up to the last. */
const BACKOFF_MS = [5_000, 10_000, 30_000, 60_000];

export interface LoopOptions {
  state: State;
  store: ToolStore;
  runner: Runner;
  runs: RunTable;
  model: ChatModel;
  workspace: string;
  stateDb: string;
  contextTokens: number;
  maxSteps: number;
  turnDelayMs: number;
  /** Share of the window above which a turn's prompt starts with a warning; 0 never. */
  contextWarn?: number;
  /** Share of the window above which five drops the oldest messages before a turn; 0 never. */
  contextTrim?: number;
  /** Fold a turn that ends with a reply into that reply, as end_turn would into its summary. */
  foldReplies?: boolean;
  /** Turns in a row without a tool call after which the loop pauses; 0 never. */
  idleTurns?: number;
  /** A result of a run longer than this goes to a file, its start to the context; 0 never. */
  resultChars?: number;
  log?: Logger;
  onEvent?: (e: Event) => void;
}

export class Loop {
  readonly ctx: Context;
  private readonly o: LoopOptions & { log: Logger };
  private running = false;
  private busy = false;
  private step = 0;
  private promptTokens: number | null = null;
  private failures = 0;
  /** Turns in a row that did no work: no tool call beyond reading and ending the turn. */
  private idle = 0;
  /** The prompt the current turn started with. */
  private turnPrompt = "";
  /** Whether this turn sent the person a message already. */
  private messaged = false;
  private retryAt: number | null = null;
  private abort?: AbortController;
  /** Interrupts the wait between turns. */
  private wait?: AbortController;
  private driving?: Promise<void>;
  private current?: Promise<void>;

  constructor(opts: LoopOptions) {
    this.o = { log: noopLogger, ...opts, ...(opts.log && { log: opts.log.child({ component: "loop" }) }) };
    this.ctx = opts.state.loadContext() ?? this.seed();
    if (!opts.state.loadContext()) opts.state.saveContext(this.ctx);
    // The last call's size outlives a restart, so the first turn after one is warned too.
    this.promptTokens = Number(opts.state.getMeta("prompt_tokens")) || null;
  }

  status(): LoopStatus {
    return {
      running: this.running,
      busy: this.busy,
      turn: this.ctx.turn,
      step: this.step,
      promptTokens: this.promptTokens,
      retryAt: this.retryAt ? new Date(this.retryAt).toISOString() : null,
    };
  }

  /** Whether the loop was running when five last stopped: it resumes at the next start. */
  get wasRunning(): boolean {
    return this.o.state.getMeta("running") === "1";
  }

  /** Loop: one turn after another until paused. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.o.state.setMeta("running", "1");
    this.failures = 0;
    this.idle = 0;
    this.emit({ type: "loop", state: "started" });
    this.o.log.info("loop started", { turn: this.ctx.turn });
    this.driving ??= this.drive().finally(() => {
      this.driving = undefined;
    });
  }

  /** Stop looping once the current turn ends; the reason, when five pauses itself. */
  pause(reason?: string): void {
    this.o.state.setMeta("running", "0");
    if (!this.running) return;
    this.running = false;
    this.wait?.abort();
    this.emit({ type: "loop", state: "paused", ...(reason && { reason }) });
    this.o.log.info("loop paused", { turn: this.ctx.turn, busy: this.busy, ...(reason && { reason }) });
  }

  /** Pause, and end the current turn now. */
  stop(): void {
    this.pause();
    this.abort?.abort();
  }

  /** A message from the person: put before the next turn's prompt. */
  receive(text: string): InboxMessage {
    const m = this.o.state.addInbox(this.ctx.turn, "person", text);
    this.emit({ type: "inbox", from: "person", text });
    this.o.log.info("message received", { id: m.id });
    return m;
  }

  /** Five's self block: sent after the messages with every model call, never stored. */
  selfBlock(): string {
    const { ctx } = this;
    const { contextTokens, state, store, workspace } = this.o;
    const born = state.getMeta("born");
    const goal = /^## Goal[ \t]*\n+([^\n]+)/m.exec(ctx.system)?.[1]?.trim();
    const used = this.promptTokens;
    const tools = store.list().map((t) => t.name);
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
      `You are five. This is turn ${ctx.turn}${this.step ? `, step ${this.step}` : ""}${born ? `; you have run since ${born.slice(0, 16).replace("T", " ")} UTC` : ""}.`,
      ...(goal ? [`Your goal: ${clip(goal, 240)}`] : []),
      `Working memory — this context: ${used === null ? "not measured yet" : `${used.toLocaleString("en-US")} of ${contextTokens.toLocaleString("en-US")} tokens at the last call (${Math.round((100 * used) / contextTokens)}%)`}, ${ctx.messages.length} messages.`,
      `Long-term memory: ${notes} note${notes === 1 ? "" : "s"} in ${MEMORY_DIR}/. Tools you built: ${tools.length ? clip(tools.join(", "), 300) : "none yet"}.`,
      `Inbox: ${inbox.sent} message${inbox.sent === 1 ? "" : "s"} sent to the person${inbox.lastSentTurn === null ? "" : `, the last on turn ${inbox.lastSentTurn}`}; ${inbox.received} from them.`,
      "",
      `## Your self note (${MEMORY_DIR}/${SELF_NOTE}.md)`,
      "",
      self ||
        `Not written yet. It is the one note sent with every call: who you are, what you care about, how you work best — in your own words, at most ${SELF_NOTE_CHARS} characters. memory_write with name "${SELF_NOTE}" writes it.`,
    ].join("\n");
  }

  /** Run one turn while paused. */
  stepOnce(): void {
    if (this.running || this.busy) throw new Error("a turn is already running");
    void this.turn();
  }

  /** Change the context from outside the loop (the web UI); refused during a turn. */
  edit(change: string, fn: (ctx: Context) => void): void {
    if (this.busy) throw new Error("the context cannot be changed during a turn; pause and wait for the turn to end");
    fn(this.ctx);
    this.save();
    this.emit({ type: "context", by: "user", change });
    this.o.log.info("context changed", { by: "user", change });
  }

  /**
   * Start over: the seed system prompt and prompt (or those given), no
   * messages, turn 0, no events. With `clean`, also every tool the agent built
   * and every file in the workspace but five's own data (.five).
   */
  reset(opts: { system?: string; next?: string; clean?: boolean } = {}): void {
    if (this.busy) throw new Error("cannot reset during a turn; pause and wait for the turn to end");
    if (opts.clean) this.clean();
    Object.assign(this.ctx, this.seed(), {
      ...(opts.system?.trim() && { system: opts.system }),
      ...(opts.next?.trim() && { next: opts.next }),
    });
    this.promptTokens = null;
    this.o.state.setMeta("prompt_tokens", "");
    this.o.state.setMeta("born", "");
    this.o.state.clearEvents();
    this.o.state.clearInbox();
    this.save();
    this.o.log.info("context reset");
  }

  /** Delete the agent's tools, background runs and workspace files. */
  private clean(): void {
    const { workspace, store, runs, state, log } = this.o;
    // Run from the repo, the workspace is the repo: never delete that.
    if (fs.existsSync(path.join(workspace, ".git"))) {
      throw new Error(`the workspace ${workspace} is a git repository; its files are not deleted`);
    }
    runs.killAll(AGENT_ID);
    const tools = store.list().map((t) => t.name);
    for (const name of tools) store.remove(name);
    state.db.exec("DELETE FROM runs");
    const files = fs.readdirSync(workspace).filter((f) => f !== ".five");
    for (const f of files) fs.rmSync(path.join(workspace, f), { recursive: true, force: true });
    log.info("workspace cleaned", { tools: tools.length, entries: files.length });
  }

  /**
   * End the current turn and wait for it, for five stopping. Unlike stop, the
   * loop is not paused: a loop that was running resumes at the next start.
   */
  async shutdown(): Promise<void> {
    this.running = false;
    this.wait?.abort();
    this.abort?.abort();
    await this.driving;
    await this.current;
  }

  private seed(): Context {
    return {
      system: seedSystemPrompt({ workspace: this.o.workspace, contextTokens: this.o.contextTokens }),
      messages: [],
      next: SEED_PROMPT,
      turn: 0,
    };
  }

  private async drive(): Promise<void> {
    // A turn started with stepOnce finishes first.
    await this.current;
    while (this.running) {
      const ok = await this.turn();
      if (!this.running) break;
      const { idleTurns = 0 } = this.o;
      if (idleTurns > 0 && this.idle >= idleTurns) {
        this.pause(`${this.idle} turns in a row did no work`);
        break;
      }
      this.failures = ok ? 0 : this.failures + 1;
      const delay = ok
        ? this.o.turnDelayMs
        : (BACKOFF_MS[Math.min(this.failures, BACKOFF_MS.length) - 1] ?? this.o.turnDelayMs);
      if (!ok) this.retryAt = Date.now() + delay;
      this.wait = new AbortController();
      await sleep(delay, this.wait.signal);
      this.retryAt = null;
    }
  }

  /** One turn. Resolves false when it failed. */
  private turn(): Promise<boolean> {
    const run = this.runTurn();
    this.current = run.then(() => {});
    return run;
  }

  private async runTurn(): Promise<boolean> {
    const { ctx } = this;
    this.busy = true;
    this.abort = new AbortController();
    ctx.turn++;
    const turn = ctx.turn;
    const log = this.o.log.child({ turn });
    const started = performance.now();
    const prompt = ctx.next;
    if (!this.o.state.getMeta("born")) this.o.state.setMeta("born", new Date().toISOString());
    const trimmed = this.trim();
    const warning =
      [this.idleWarning(), trimmed ?? this.contextWarning(), this.deliver(turn)].filter(Boolean).join("\n\n") ||
      undefined;
    this.turnPrompt = prompt;
    this.messaged = false;
    const opening: Message = { role: "user", content: warning ? `${warning}\n\n${prompt}` : prompt };
    ctx.messages.push(opening);
    this.save();
    this.emit({ type: "turn_started", prompt, ...(warning && { warning }) });
    log.info("turn started", { ...(log.enabled("debug") && { prompt: preview(prompt) }) });

    let reason: TurnEnd = "max_steps";
    let error: string | undefined;
    let worked = false;
    try {
      for (this.step = 1; this.step <= this.o.maxSteps; this.step++) {
        const step = this.step;
        const stepLog = log.child({ step });
        const tools = this.tools();
        const t0 = performance.now();
        const completion = await this.o.model.complete({
          messages: [
            { role: "system", content: ctx.system },
            ...ctx.messages,
            { role: "user", content: this.selfBlock() },
          ],
          tools,
          signal: this.abort.signal,
          log: stepLog,
        });
        const durationMs = Math.round(performance.now() - t0);
        this.promptTokens = completion.usage?.prompt_tokens ?? this.promptTokens;
        if (this.promptTokens !== null) this.o.state.setMeta("prompt_tokens", String(this.promptTokens));
        let { message } = completion;
        let fromText = false;
        if (!message.tool_calls?.length && message.content) {
          const recovered = recoverToolCalls(message.content, new Set(tools.map((t) => t.name)));
          if (recovered) {
            stepLog.info("tool calls recovered from text", { tools: recovered.map((c) => c.function.name) });
            message = { ...message, content: null, tool_calls: recovered };
            fromText = true;
          }
        }
        const { thinking, ...kept } = message;
        ctx.messages.push(kept);
        this.save();
        this.emit({
          type: "model",
          step,
          content: message.content,
          ...(thinking && { thinking }),
          calls: (message.tool_calls ?? []).map((c) => ({ id: c.id, ...c.function })),
          ...(fromText && { fromText }),
          promptTokens: completion.usage?.prompt_tokens,
          completionTokens: completion.usage?.completion_tokens,
          durationMs,
        });
        if (!message.tool_calls?.length) {
          reason = "replied";
          // A small model often forgets end_turn: its last reply stands in for the summary.
          const reply = message.content?.trim();
          if (reply && this.o.foldReplies) this.fold(opening, clip(reply, MAX_REPLY_SUMMARY_CHARS));
          break;
        }

        if (message.tool_calls.some(isWork)) worked = true;
        let end = false;
        let summary: string | undefined;
        for (const call of message.tool_calls) {
          const t1 = performance.now();
          const raw = await this.dispatch(call, stepLog, (s) => {
            end = true;
            summary ??= s;
          });
          const result = this.fit(raw, call);
          ctx.messages.push({ role: "tool", tool_call_id: call.id, name: call.function.name, content: result });
          this.save();
          this.emit({
            type: "tool",
            step,
            id: call.id,
            name: call.function.name,
            arguments: call.function.arguments,
            result,
            ok: !isFailure(result),
            durationMs: Math.round(performance.now() - t1),
          });
        }
        if (end) {
          reason = "end_turn";
          if (summary) this.fold(opening, summary);
          break;
        }
      }
      return true;
    } catch (err) {
      if (this.abort.signal.aborted) {
        reason = "stopped";
        return true;
      }
      reason = "error";
      error = err instanceof Error ? err.message : String(err);
      return false;
    } finally {
      const steps = Math.min(this.step, this.o.maxSteps);
      this.step = 0;
      this.busy = false;
      this.abort = undefined;
      this.idle = worked || reason === "stopped" || reason === "error" ? 0 : this.idle + 1;
      this.save();
      this.emit({ type: "turn_ended", reason, next: ctx.next, ...(error && { error }) });
      log[reason === "error" ? "error" : "info"]("turn ended", {
        reason,
        steps,
        duration_ms: Math.round(performance.now() - started),
        messages: ctx.messages.length,
        prompt_tokens: this.promptTokens,
        ...(error && { error }),
      });
    }
  }

  /**
   * Replace the turn's messages, from its prompt on, with the agent's summary.
   * When the agent deleted its prompt, the turn's messages stay.
   */
  private fold(opening: Message, summary: string): void {
    const { messages, turn } = this.ctx;
    const i = messages.indexOf(opening);
    if (i < 0) return;
    const n = messages.length - i;
    messages.splice(i, n, { role: "assistant", content: `[Turn ${turn}, summarized] ${summary}` });
    this.emit({ type: "context", by: "model", change: `turn ${turn}'s ${n} messages replaced by its summary` });
    this.o.log.info("turn folded", { turn, messages: n });
  }

  /** A run's result, cut to fit the context: a long one is kept whole in a file the context points to. */
  private fit(result: string, call: ToolCall): string {
    const { resultChars = 0 } = this.o;
    if (resultChars <= 0 || result.length <= resultChars || contextToolsByName.has(call.function.name)) {
      return truncate(result);
    }
    const rel = path.join(RESULTS_DIR, `turn-${this.ctx.turn}-${call.id.replace(/[^\w-]/g, "_")}.txt`);
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
   * When the last call filled nearly all the window, drop the oldest messages
   * until about half of it is left, and return the note that says so. A model
   * with a full window can no longer make the call that frees it.
   */
  private trim(): string | undefined {
    const { contextTrim = 0, contextTokens } = this.o;
    const used = this.promptTokens;
    const { messages } = this.ctx;
    if (contextTrim <= 0 || used === null || used < contextTrim * contextTokens || !messages.length) return undefined;
    const sizes = messages.map(chars);
    const total = sizes.reduce((a, b) => a + b, 0);
    // Characters stand in for tokens: drop the share of them that is over the aim.
    const over = total * (1 - (TRIM_TO * contextTokens) / used);
    let cut = 0;
    for (let dropped = 0; cut < messages.length && dropped < over; cut++) dropped += sizes[cut] ?? 0;
    // A tool result without the call before it is no message the model can read.
    while (messages[cut]?.role === "tool") cut++;
    messages.splice(0, cut);
    this.emit({ type: "context", by: "five", change: `the ${cut} oldest messages dropped to free the window` });
    this.o.log.warn("context trimmed", { messages: cut, prompt_tokens: used });
    const share = Math.round((100 * used) / contextTokens);
    return `[five] Your context was ${used.toLocaleString("en-US")} of ${contextTokens.toLocaleString("en-US")} tokens (${share}%), too full to work in, so five dropped your ${cut} oldest messages. What you saved with memory_write is still there: memory_read lists it. Keep the window small from now on: end every turn with end_turn(summary, next), and delete messages you no longer need.`;
  }

  /** The person's messages not yet delivered, as the note this turn's prompt starts with. */
  private deliver(turn: number): string | undefined {
    const waiting = this.o.state.undelivered();
    if (!waiting.length) return undefined;
    this.o.state.markDelivered(
      waiting.map((m) => m.id),
      turn,
    );
    const lines = waiting.map((m) => `[The person wrote to you, during turn ${m.turn}] ${m.text}`);
    return `${lines.join("\n\n")}\n\n[five] Take it into account as you see fit; message_person answers. Your work goes on either way.`;
  }

  /** The note a turn's prompt starts with after a turn that did no work. */
  private idleWarning(): string | undefined {
    if (this.idle === 0 || !this.o.idleTurns) return undefined;
    return "[five] Your last turn did no work: it called nothing beyond reading, messaging and ending the turn, so it was wasted. What you do next is yours to decide: do the next piece of work now. If your goal is done, rewrite ## Goal in your system prompt with a new goal and start it. End the turn with end_turn(summary, next), where next says what to do — not what was done, and never to wait.";
  }

  /** The warning a turn's prompt starts with when the last call filled most of the window. */
  private contextWarning(): string | undefined {
    const { contextWarn = 0, contextTokens } = this.o;
    const used = this.promptTokens;
    if (contextWarn <= 0 || used === null || used < contextWarn * contextTokens) return undefined;
    const share = Math.round((100 * used) / contextTokens);
    const before = this.ctx.messages.length;
    const drop =
      before > 0
        ? ` Messages 0–${before - 1} came before this turn: delete_messages with start 0 and end ${before - 1} drops them all, or pick the ones to drop with read_context.`
        : "";
    return `[five] Your context is ${used.toLocaleString("en-US")} of ${contextTokens.toLocaleString("en-US")} tokens (${share}%). When it is full the oldest text is silently lost and you can no longer work. Before anything else, save what you still need with memory_write, then delete messages you no longer need.${drop}`;
  }

  /** Every tool the agent can call now: its context tools, seven's built-ins, and the enabled tools it built. */
  private tools(): ToolDef[] {
    const def = ({ name, description, parameters }: ToolDef) => ({ name, description, parameters });
    return [
      ...contextTools.map(def),
      ...[...builtins().values()].map(def),
      ...this.o.store
        .list()
        .filter((t) => !t.disabled)
        .map(def),
    ];
  }

  private async dispatch(call: ToolCall, stepLog: Logger, endTurn: (summary?: string) => void): Promise<string> {
    const { name, arguments: raw } = call.function;
    const log = stepLog.child({ call: call.id });
    const started = performance.now();
    let result: string;
    let kind: "context" | "builtin" | "generated" | "unknown" = "unknown";
    try {
      const parsed = parseArgs(raw ?? "");
      const own = contextToolsByName.get(name);
      const builtin = own ? undefined : builtins().get(name);
      const generated = own || builtin ? undefined : this.o.store.get(name);
      const schema = (own ?? builtin)?.parameters ?? generated?.meta.parameters;
      const args = parsed.ok ? coerceArgs(schema, parsed.args) : {};
      const bad = !parsed.ok ? parsed.error : schema ? checkArgs(schema, args) : undefined;
      if (bad) result = `error: ${name}: ${bad}`;
      else if (own) {
        kind = "context";
        result = own.run(args, this.contextEnv(endTurn));
      } else if (builtin) {
        kind = "builtin";
        result = await builtin.run(args, this.builtinContext(log));
      } else if (generated?.meta.disabled) {
        kind = "generated";
        result = disabledError(generated);
      } else if (generated) {
        kind = "generated";
        const bctx = this.builtinContext(log);
        result = formatRun(await awaitRun(startGenerated(bctx, generated, args, "sync"), bctx.signal));
      } else {
        result = `error: no tool named "${name}". Call only tools in your tool list; define_tool creates a new one.`;
      }
    } catch (err) {
      result = `error: ${err instanceof Error ? err.message : String(err)}`;
    }
    const failed = isFailure(result);
    log[failed ? "warn" : "info"]("tool called", {
      tool: name,
      kind,
      ok: !failed,
      duration_ms: Math.round(performance.now() - started),
      result_chars: result.length,
      ...(failed && { error: preview(result, 300) }),
      ...(log.enabled("debug") && { args: preview(raw), result: preview(result) }),
    });
    return result;
  }

  private sendMessage(text: string): string {
    if (this.messaged) return "error: you sent the person a message this turn already; one a turn. Keep working.";
    this.messaged = true;
    const m = this.o.state.addInbox(this.ctx.turn, "five", text);
    this.emit({ type: "inbox", from: "five", text });
    this.o.log.info("message sent", { id: m.id });
    return "sent. The person reads the inbox now and then; a reply, if one comes, is put before the prompt of a later turn. Do not wait for it: go on with your work.";
  }

  private contextEnv(endTurn: (summary?: string) => void): ContextEnv {
    return {
      ctx: this.ctx,
      ...(this.promptTokens !== null && { promptTokens: this.promptTokens }),
      contextTokens: this.o.contextTokens,
      workspace: this.o.workspace,
      turnPrompt: this.turnPrompt,
      changed: (change) => {
        this.emit({ type: "context", by: "model", change });
        this.o.log.info("context changed", { by: "model", change });
      },
      endTurn,
      selfBlock: () => this.selfBlock(),
      sendMessage: (text) => this.sendMessage(text),
    };
  }

  private builtinContext(log: Logger): BuiltinContext {
    return {
      agentId: AGENT_ID,
      runner: this.o.runner,
      store: this.o.store,
      runs: this.o.runs,
      workspace: this.o.workspace,
      stateDb: this.o.stateDb,
      signal: this.abort?.signal,
      log,
    };
  }

  private save(): void {
    this.o.state.saveContext(this.ctx);
  }

  private emit(body: EventBody): void {
    const e = this.o.state.addEvent(this.ctx.turn, body);
    this.o.onEvent?.(e);
  }
}

function isFailure(result: string): boolean {
  return result.startsWith("error:") || result.startsWith("not saved:");
}

function truncate(s: string): string {
  if (s.length <= MAX_RESULT_CHARS) return s;
  return `${s.slice(0, MAX_RESULT_CHARS)}\n… [truncated ${s.length - MAX_RESULT_CHARS} of ${s.length} characters]`;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)} … [cut]`;
}

/** A message's length in characters: its text and its calls. */
function chars(m: Message): number {
  let n = m.content?.length ?? 0;
  for (const c of (m.role === "assistant" && m.tool_calls) || [])
    n += c.function.name.length + c.function.arguments.length;
  return n;
}

/** Whether a call does work: anything but reading, messaging, ending the turn, or writing the self note. */
function isWork(call: ToolCall): boolean {
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
