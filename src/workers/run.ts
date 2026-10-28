// A run: one worker at work — the lead planning, the chat answering, a task
// worker doing one task. Everything five shares with its runs is in Deps; what
// belongs to one run is in Run. A run's events carry its number.

import { AsyncLocalStorage } from "node:async_hooks";
import type { RunTable } from "../agent/runs.ts";
import type { EventBody, LiveWork, Task, WorkerKind } from "../api/types.ts";
import type { Logger } from "../log.ts";
import type { Runner } from "../runner/index.ts";
import type { State } from "../state.ts";
import type { LibraryStore } from "../tools/libs.ts";
import type { ToolStore } from "../tools/store.ts";
import type { Board } from "./board.ts";
import type { ModelPool } from "./pool.ts";
import type { SettingsStore } from "./settings.ts";
import type { WorkerStore } from "./store.ts";

export interface Deps {
  state: State;
  board: Board;
  workers: WorkerStore;
  store: ToolStore;
  libs: LibraryStore;
  runner: Runner;
  runs: RunTable;
  pool: ModelPool;
  settings: SettingsStore;
  workspace: string;
  log: Logger;
  /** Record an event of a run (0: of none). */
  emit(run: number, body: EventBody): void;
  /** The goal, as the lead keeps it. */
  goal(): string;
  setGoal(text: string, by: string): void;
  /** Ask for a lead run soon: something it should read happened. */
  wakeLead(): void;
}

export class Run {
  readonly n: number;
  readonly worker: string;
  readonly kind: WorkerKind;
  readonly task?: Task;
  readonly startedAt = Date.now();
  readonly abort = new AbortController();
  readonly log: Logger;
  /** Model calls so far. */
  step = 0;
  /** The size of its context at its last model call. */
  promptTokens?: number;
  /** What it does now, for the status. */
  live?: { phase: LiveWork["phase"]; startedAt: number; tool?: string; thinking?: string; content?: string };
  /** Images view_image attached in this step, shown after its results. */
  attached: string[] = [];
  private readonly emitter: (body: EventBody) => void;

  constructor(o: {
    n: number;
    worker: string;
    kind: WorkerKind;
    task?: Task;
    log: Logger;
    emit: (n: number, body: EventBody) => void;
  }) {
    this.n = o.n;
    this.worker = o.worker;
    this.kind = o.kind;
    if (o.task) this.task = o.task;
    this.log = o.log.child({ run: o.n, worker: o.worker });
    this.emitter = (body) => o.emit(o.n, body);
  }

  emit(body: EventBody): void {
    this.emitter(body);
  }

  get signal(): AbortSignal {
    return this.abort.signal;
  }

  setLive(phase: LiveWork["phase"], more: { tool?: string } = {}): void {
    this.live = { phase, startedAt: Date.now(), ...more };
  }
}

/** The run whose code is running, for what starts a process to know whose it is. */
export const runScope = new AsyncLocalStorage<Run>();
