// Five's main loop: code, not a model. It runs the workers — the lead when the
// board runs low or its time comes, a task worker for each open task while
// there is room, the chat whenever the person writes — and shares the model's
// slots between them. Paused, it starts no lead or task run; the chat still
// answers.

import type { RunTable } from "../agent/runs.ts";
import type { ActiveRun, ChatStatus, EventBody, Task } from "../api/types.ts";
import type { ChatModel } from "../llm/model.ts";
import type { Logger } from "../log.ts";
import type { Runner } from "../runner/index.ts";
import type { State } from "../state.ts";
import type { LibraryStore } from "../tools/libs.ts";
import type { ToolStore } from "../tools/store.ts";
import { Board, clip } from "./board.ts";
import { ChatSession, chatForLead } from "./chat.ts";
import { History } from "./history.ts";
import { runLead } from "./lead.ts";
import { ModelPool } from "./pool.ts";
import { type Deps, Run, runScope } from "./run.ts";
import { SEED_GOAL, SEEDS } from "./seeds.ts";
import { type Settings, SettingsStore } from "./settings.ts";
import { WorkerStore } from "./store.ts";
import { runWorker } from "./task.ts";

/** The worker five posts a task for every feedsEverySeconds. */
const FEEDS = "feeds";
/** The lead runs at most this often for a board running low. */
const LEAD_COOLDOWN_MS = 30_000;
/** The longest a status shows of a reply in progress. */
const LIVE_CHARS = 4000;
/** The longest result a task keeps; the start of a longer one. */
const MAX_TASK_RESULT = 8000;

export interface SchedulerOptions {
  state: State;
  store: ToolStore;
  libs: LibraryStore;
  runner: Runner;
  runs: RunTable;
  model: ChatModel;
  /** The lead's own model: its calls go to it, one at a time, besides the others' slots. */
  leadModel?: ChatModel;
  workspace: string;
  settings: Settings;
  /** How often the loop looks for work. */
  tickMs: number;
  log: Logger;
  onEvent?: (e: ReturnType<State["addEvent"]>) => void;
}

export class Scheduler {
  readonly d: Deps;
  readonly board: Board;
  readonly workers: WorkerStore;
  readonly settings: SettingsStore;
  readonly pool: ModelPool;
  private readonly o: SchedulerOptions;
  private running = false;
  private readonly active = new Map<number, { run: Run; done: Promise<void> }>();
  private chat?: ChatSession;
  private timer?: NodeJS.Timeout;
  private lastLead = 0;
  private leadWanted = false;
  /** The latest chat, for the lead's next run. */
  private chatNote?: string;
  private closing = false;

  constructor(o: SchedulerOptions) {
    this.o = o;
    const log = o.log.child({ component: "five" });
    const emit = (run: number, body: EventBody) => {
      const e = o.state.addEvent(run, body);
      o.onEvent?.(e);
    };
    this.board = new Board(o.state);
    this.workers = new WorkerStore(o.state);
    this.settings = new SettingsStore({
      state: o.state,
      defaults: o.settings,
      log,
      emit: (body) => emit(0, body),
    });
    this.pool = new ModelPool(o.model, () => this.settings.current.slots);
    this.d = {
      state: o.state,
      board: this.board,
      workers: this.workers,
      store: o.store,
      libs: o.libs,
      runner: o.runner,
      runs: o.runs,
      pool: this.pool,
      ...(o.leadModel && { leadPool: new ModelPool(o.leadModel, () => 1) }),
      settings: this.settings,
      workspace: o.workspace,
      history: new History(o.workspace, log),
      log,
      emit,
      goal: () => o.state.getMeta("goal") || SEED_GOAL,
      setGoal: (text, by) => {
        o.state.setMeta("goal", text);
        emit(runScope.getStore()?.n ?? 0, { type: "goal", text, by });
        log.info("goal set", { by });
        this.wakeLead();
      },
      wakeLead: () => this.wakeLead(),
    };
    this.seed();
  }

  /** Whether five was running when it last stopped: it resumes at the next start. */
  get wasRunning(): boolean {
    return this.o.state.getMeta("running") === "1";
  }

  start(): void {
    this.o.state.setMeta("running", "1");
    if (this.running) return;
    this.running = true;
    this.emit({ type: "loop", state: "started" });
    this.d.log.info("five started its workers");
    this.timer ??= setInterval(() => this.tick(), this.o.tickMs);
    this.tick();
  }

  /** Start no more lead or task runs; those running finish. */
  pause(reason?: string): void {
    this.o.state.setMeta("running", "0");
    if (!this.running) return;
    this.running = false;
    this.emit({ type: "loop", state: "paused", ...(reason && { reason }) });
  }

  /** Pause, and stop every lead and task run now. The chat goes on. */
  stop(): void {
    this.pause();
    for (const { run } of this.active.values()) if (run.kind !== "chat") run.abort.abort();
    this.emit({ type: "loop", state: "stopped" });
  }

  /** The person writes in the chat: it opens when it is not, even while paused. */
  say(text: string): void {
    if (!this.chat) {
      const run = this.newRun("chat", "chat");
      const chat = new ChatSession(this.d, run, () => this.snapshot());
      this.chat = chat;
      this.track(run, () =>
        chat.done.then((r) => {
          if (this.chat === chat) this.chat = undefined;
          if (r.reason !== "stopped" && r.transcript) {
            this.chatNote = chatForLead(r.saved, r.transcript);
            this.wakeLead();
          }
          return {
            outcome: r.reason === "stopped" ? ("stopped" as const) : ("done" as const),
            result: r.saved ? `saved to ${r.saved}` : "",
          };
        }),
      );
    }
    this.chat.say(text);
  }

  leaveChat(): void {
    if (!this.chat) throw new Error("no chat is open");
    this.chat.leave();
  }

  /** The person posts a task. */
  post(t: { worker: string; title: string; input: string }): Task {
    if (!this.workers.get(t.worker)) throw new Error(`no task worker named "${t.worker}"`);
    const task = this.board.post({ ...t, by: "person" });
    this.emit({ type: "task", action: "posted", id: task.id, worker: t.worker, title: t.title, by: "person" });
    this.tick();
    return task;
  }

  cancel(id: number): void {
    const t = this.board.get(id);
    if (!t || !this.board.cancel(id)) throw new Error(`#${id} is not an open task`);
    this.emit({ type: "task", action: "cancelled", id, worker: t.worker, title: t.title, by: "person" });
  }

  /** The person writes to the inbox: the lead reads it at its next run, which comes soon. */
  receive(text: string) {
    const m = this.o.state.addInbox(0, "person", text);
    this.emit({ type: "inbox", from: "person", text });
    this.wakeLead();
    return m;
  }

  status(): { running: boolean; active: ActiveRun[]; queued: number; chat?: ChatStatus } {
    return {
      running: this.running,
      active: [...this.active.values()].map(({ run }) => ({
        run: run.n,
        worker: run.worker,
        kind: run.kind,
        ...(run.task && { task: { id: run.task.id, title: run.task.title } }),
        startedAt: new Date(run.startedAt).toISOString(),
        step: run.step,
        ...(run.promptTokens !== undefined && { promptTokens: run.promptTokens }),
        ...(run.live && {
          live: {
            step: run.step,
            phase: run.live.phase,
            startedAt: new Date(run.live.startedAt).toISOString(),
            ...(run.live.tool && { tool: run.live.tool }),
            ...(run.live.thinking && { thinking: tail(run.live.thinking) }),
            ...(run.live.content && { content: tail(run.live.content) }),
          },
        }),
      })),
      queued: this.pool.waiting,
      ...(this.chat && { chat: this.chat.status() }),
    };
  }

  /**
   * Start over: no events, tasks, inbox or task workers but the seeds, and the
   * first goal. With `clean`, also no tools, libraries or workspace files.
   * Refused while anything runs.
   */
  reset(opts: { clean?: boolean; clear: () => void }): void {
    if (this.active.size) throw new Error("runs are in progress: stop five and wait for them to end");
    opts.clear();
    this.board.clear();
    this.workers.clear();
    for (const key of ["goal", "runs", "seeded"]) this.o.state.setMeta(key, "");
    this.o.state.clearEvents();
    this.o.state.clearInbox();
    this.chatNote = undefined;
    this.lastLead = 0;
    this.seed();
  }

  /** Stop every run and wait for them, for five stopping; a task in progress goes back on the board. */
  async shutdown(): Promise<void> {
    this.closing = true;
    this.running = false;
    clearInterval(this.timer);
    this.timer = undefined;
    for (const { run } of this.active.values()) run.abort.abort();
    await Promise.all([...this.active.values()].map((a) => a.done));
  }

  private wakeLead(): void {
    this.leadWanted = true;
    if (this.running) setImmediate(() => this.tick());
  }

  /** Look for work: the lead first, then open tasks while there is room. */
  private tick(): void {
    if (!this.running || this.closing) return;
    const s = this.settings.current;
    const runs = [...this.active.values()].map((a) => a.run);
    const leading = runs.some((r) => r.kind === "lead");
    const now = Date.now();
    this.readFeeds(s, now);
    const counts = this.board.counts();
    // A new five's lead waits for its workers' first results, to plan from them rather than from memory.
    const ready = counts.done + counts.failed > 0 || counts.running + counts.open === 0;
    const low = ready && counts.open < s.minOpenTasks && now - this.lastLead >= LEAD_COOLDOWN_MS;
    const due = this.lastLead ? now - this.lastLead >= s.leadEverySeconds * 1000 : ready;
    if (!leading && (low || due || (this.leadWanted && now - this.lastLead >= 5_000))) this.startLead();

    let tasks = runs.filter((r) => r.kind === "task").length;
    while (tasks < s.taskRuns) {
      const task = this.board.claim(() => this.o.state.nextRun());
      if (!task?.run) break;
      tasks++;
      this.startTask(task.run, task);
    }
  }

  /** The feeds, read on time: a task for the feeds worker when it has none and its last is old enough. */
  private readFeeds(s: Settings, now: number): void {
    if (!s.feedsEverySeconds || !this.workers.get(FEEDS)) return;
    const last = this.board.latest(FEEDS);
    if (last && (last.status === "open" || last.status === "running")) return;
    if (last && now - Date.parse(last.createdAt) < s.feedsEverySeconds * 1000) return;
    const t = { worker: FEEDS, title: "Read the news feeds", input: "" };
    const task = this.board.post({ ...t, by: "five" });
    this.emit({ type: "task", action: "posted", id: task.id, worker: FEEDS, title: t.title, by: "five" });
  }

  private startLead(): void {
    this.leadWanted = false;
    this.lastLead = Date.now();
    const run = this.newRun("lead", "lead");
    const chat = this.chatNote;
    this.chatNote = undefined;
    this.track(
      run,
      () =>
        runLead(this.d, run, { ...(chat && { chat }) }).then((text) => ({ outcome: "done" as const, result: text })),
      () => {
        this.lastLead = Date.now();
      },
    );
  }

  private startTask(n: number, task: Task): void {
    const run = new Run({ n, worker: task.worker, kind: "task", task, log: this.d.log, emit: this.d.emit });
    run.emit({
      type: "run_started",
      worker: task.worker,
      kind: "task",
      task: { id: task.id, title: task.title },
      prompt: task.input ? `${task.title}\n\n${task.input}` : task.title,
    });
    this.track(run, async () => {
      const worker = this.workers.get(task.worker);
      if (!worker) throw new Error(`no task worker named "${task.worker}"`);
      const result = await runWorker(this.d, run, worker, { id: task.id, title: task.title, input: task.input });
      return { outcome: "done" as const, result };
    });
  }

  private newRun(worker: string, kind: Run["kind"]): Run {
    return new Run({ n: this.o.state.nextRun(), worker, kind, log: this.d.log, emit: this.d.emit });
  }

  /** Do a run's work in its scope, and follow it to its end: record it, and its task's result. */
  private track(
    run: Run,
    work: () => Promise<{ outcome: "done" | "stopped"; result: string }>,
    after?: () => void,
  ): void {
    const t0 = Date.now();
    const done = runScope.run(run, async () => {
      let outcome: "done" | "failed" | "stopped" = "done";
      let result: string | undefined;
      let error: string | undefined;
      try {
        const r = await work();
        outcome = r.outcome;
        result = r.result;
      } catch (err) {
        outcome = run.signal.aborted ? "stopped" : "failed";
        error = err instanceof Error ? err.message : String(err);
      }
      this.active.delete(run.n);
      run.live = undefined;
      // A failed run's changes to the workspace are put back.
      const back = this.d.history?.end(run, outcome) ?? [];
      if (back.length) error = `${error ?? outcome}\n[five put back the files it changed: ${back.join(", ")}]`;
      if (run.task) {
        // Five stopping: the task waits on the board for the next start.
        if (this.closing && outcome === "stopped") this.board.reopen(run.task.id);
        else {
          const ok = outcome === "done";
          const t = this.board.finish(run.task.id, {
            ok,
            ...(ok ? { result: clip(result ?? "", MAX_TASK_RESULT) } : { error: error ?? outcome }),
          });
          if (t) run.emit({ type: "task", action: ok ? "done" : "failed", id: t.id, worker: t.worker, title: t.title });
        }
      }
      run.emit({
        type: "run_ended",
        outcome,
        ...(result && { result: clip(result, MAX_TASK_RESULT) }),
        ...(error && { error: clip(error, 4000) }),
        durationMs: Date.now() - t0,
      });
      run.log[outcome === "failed" ? "warn" : "info"]("run ended", {
        outcome,
        steps: run.step,
        duration_ms: Date.now() - t0,
        ...(error && { error: clip(error, 300) }),
      });
      after?.();
      // A slot is free: look for more work now.
      if (!this.closing) setImmediate(() => this.tick());
    });
    this.active.set(run.n, { run, done });
  }

  /** Five now, for the chat's first message. */
  private snapshot(): string {
    const runs = [...this.active.values()]
      .map(({ run }) => run)
      .filter((r) => r.kind !== "chat")
      .map((r) => `- run ${r.n}: ${r.worker}${r.task ? ` on #${r.task.id} ${r.task.title}` : ""}`);
    return [
      `Goal: ${this.d.goal()}`,
      "",
      `Five is ${this.running ? "running" : "paused"}. Running now:`,
      ...(runs.length ? runs : ["- nothing"]),
      "",
      "Board:",
      this.board.summary(6, 240),
      "",
      `Task workers: ${
        this.workers
          .list()
          .map((w) => w.name)
          .join(", ") || "none"
      }.`,
      `Now: ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC.`,
    ].join("\n");
  }

  /** A new five's task workers, once. */
  private seed(): void {
    if (this.o.state.getMeta("seeded") === "1") return;
    for (const w of SEEDS) if (!this.workers.get(w.name)) this.workers.save({ ...w, deps: {} });
    this.o.state.setMeta("seeded", "1");
  }

  private emit(body: EventBody): void {
    this.d.emit(0, body);
  }
}

function tail(text: string, max = LIVE_CHARS): string {
  return text.length > max ? `…${text.slice(-max)}` : text;
}
