// The supervisor: one agent, one context, turns without end.
//
// A turn appends the next prompt to the context as a user message, then asks
// the model, runs the tools it calls and asks again, until it replies without
// a call, calls end_turn, or runs out of steps. The next turn starts with the
// prompt the agent set with set_next_prompt, or the same one. The context is
// saved after every change, so a restart resumes it.
//
// Everything else five does around a turn — its notes before the prompt,
// folding and dropping turns, the idle pause, the self block, the limits on the
// agent's tools — is the supervisor's (supervisor.ts), tunable while the loop
// runs. The person's inbox replies are put before the next turn's prompt.

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
import { type ContextEnv, contextTools, contextToolsByName } from "./context.ts";
import { imageData, mediaTools, mediaToolsByName } from "./media.ts";
import { SEED_PROMPT, seedSystemPrompt } from "./prompt.ts";
import type { RunTable } from "./runs.ts";
import { Supervisor, type SupervisorSettings } from "./supervisor.ts";

/** Who calls tools, in run histories. */
export const AGENT_ID = "five";

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
  /** The supervisor's settings, before any change made through the API. */
  supervisor: SupervisorSettings;
  log?: Logger;
  onEvent?: (e: Event) => void;
}

export class Loop {
  readonly ctx: Context;
  readonly supervisor: Supervisor;
  private readonly o: LoopOptions & { log: Logger };
  private running = false;
  private busy = false;
  private step = 0;
  private promptTokens: number | null = null;
  private failures = 0;
  /** The prompt the current turn started with. */
  private turnPrompt = "";
  /** Why the supervisor wants the loop paused after the turn that ended, if it does. */
  private pauseFor?: string;
  private retryAt: number | null = null;
  /** Images view_image attached in this step, shown after its results. */
  private attached: string[] = [];
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
    this.supervisor = new Supervisor({
      state: opts.state,
      store: opts.store,
      workspace: opts.workspace,
      contextTokens: opts.contextTokens,
      defaults: opts.supervisor,
      log: this.o.log.child({ component: "supervisor" }),
      emit: (body) => this.emit(body),
    });
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
    this.supervisor.started();
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

  /** Five's self block as the next model call sends it; empty when it is off. */
  selfBlock(): string {
    return this.supervisor.selfBlock(this.ctx, this.step, this.promptTokens) ?? "";
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
    this.supervisor.reset();
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
      if (this.pauseFor) {
        this.pause(this.pauseFor);
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
    const notes = this.supervisor.opening(ctx, this.promptTokens);
    const delivered = this.deliver(turn);
    if (delivered) notes.push(delivered);
    const warning = notes.join("\n\n") || undefined;
    this.turnPrompt = prompt;
    this.pauseFor = undefined;
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
        const self = this.supervisor.selfBlock(ctx, step, this.promptTokens);
        const completion = await this.o.model.complete({
          messages: [
            { role: "system", content: ctx.system },
            ...ctx.messages,
            ...(self ? [{ role: "user" as const, content: self }] : []),
          ],
          tools,
          signal: this.abort.signal,
          log: stepLog,
          image: (p) => imageData(this.o.workspace, p),
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
          this.supervisor.endedWithReply(ctx, opening, message.content?.trim(), worked);
          break;
        }

        if (message.tool_calls.some((c) => this.supervisor.isWork(c))) worked = true;
        let end = false;
        let summary: string | undefined;
        this.attached = [];
        for (const call of message.tool_calls) {
          const t1 = performance.now();
          const raw = await this.dispatch(call, stepLog, (s) => {
            end = true;
            summary ??= s;
          });
          const result = this.supervisor.fit(raw, call, turn, contextToolsByName.has(call.function.name));
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
        // Images view_image asked for come after the results: a tool message carries no image.
        if (this.attached.length) {
          const paths = this.attached;
          ctx.messages.push({
            role: "user",
            content: `[five] ${paths.length === 1 ? "The image" : "The images"} view_image attached: ${paths.join(", ")}`,
            images: paths,
          });
          this.save();
        }
        if (end) {
          reason = "end_turn";
          this.supervisor.endedWithSummary(ctx, opening, summary);
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
      this.pauseFor = this.supervisor.ended({ worked, reason, prompt, next: ctx.next });
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

  /** Every tool the agent can call now: its context tools, seven's built-ins, and the enabled tools it built. */
  private tools(): ToolDef[] {
    const def = ({ name, description, parameters }: ToolDef) => ({ name, description, parameters });
    return [
      ...contextTools.map(def),
      ...mediaTools.map(def),
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
      const media = own ? undefined : mediaToolsByName.get(name);
      const builtin = own || media ? undefined : builtins().get(name);
      const generated = own || media || builtin ? undefined : this.o.store.get(name);
      const schema = (own ?? media ?? builtin)?.parameters ?? generated?.meta.parameters;
      const args = parsed.ok ? coerceArgs(schema, parsed.args) : {};
      const bad = !parsed.ok ? parsed.error : schema ? checkArgs(schema, args) : undefined;
      if (bad) result = `error: ${name}: ${bad}`;
      else if (own) {
        kind = "context";
        result = own.run(args, this.contextEnv(endTurn));
      } else if (media) {
        kind = "builtin";
        result = await media.run(args, {
          workspace: this.o.workspace,
          imageSide: this.supervisor.settings.imageSide,
          attachImage: (p) => this.attached.push(p),
        });
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
      sendMessage: (subject, text) => this.supervisor.sendMessage(this.ctx.turn, subject, text),
      checkNext: (text) => this.supervisor.checkNext(text, this.turnPrompt),
      checkSelfNote: (length) => this.supervisor.checkSelfNote(length),
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
