// The model's slots. Ollama serves a few requests at once from one loaded
// model (OLLAMA_NUM_PARALLEL); every run's model calls go through here, so no
// more than that many are sent at once and the rest wait their turn. The chat
// goes first: the person is waiting.

import type { ChatModel, Completion, CompletionRequest } from "../llm/model.ts";

interface Waiter {
  priority: number;
  go: () => void;
}

export class ModelPool {
  private readonly model: ChatModel;
  private readonly slots: () => number;
  private busy = 0;
  private readonly queue: Waiter[] = [];

  /** slots: how many calls may run at once, read at every call so a change applies at once. */
  constructor(model: ChatModel, slots: () => number) {
    this.model = model;
    this.slots = slots;
  }

  /** Calls waiting for a slot. */
  get waiting(): number {
    return this.queue.length;
  }

  /**
   * One model call, once a slot is free; a higher priority goes first. onStart
   * runs when it gets its slot. A call aborted while it waits never runs.
   */
  async complete(
    req: CompletionRequest,
    opts: { priority?: number; onStart?: () => void } = {},
  ): Promise<{ completion: Completion; waitedMs: number }> {
    const t0 = performance.now();
    await this.acquire(opts.priority ?? 0, req.signal);
    const waitedMs = Math.round(performance.now() - t0);
    try {
      opts.onStart?.();
      return { completion: await this.model.complete(req), waitedMs };
    } finally {
      this.release();
    }
  }

  private acquire(priority: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(new Error("stopped"));
    if (this.busy < Math.max(1, this.slots()) && this.queue.length === 0) {
      this.busy++;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        priority,
        go: () => {
          signal?.removeEventListener("abort", abort);
          this.busy++;
          resolve();
        },
      };
      const abort = () => {
        const i = this.queue.indexOf(waiter);
        if (i >= 0) this.queue.splice(i, 1);
        reject(new Error("stopped"));
      };
      signal?.addEventListener("abort", abort, { once: true });
      // After every waiter of the same or a higher priority: first come, first served within one.
      const at = this.queue.findIndex((w) => w.priority < priority);
      if (at < 0) this.queue.push(waiter);
      else this.queue.splice(at, 0, waiter);
    });
  }

  private release(): void {
    this.busy--;
    while (this.busy < Math.max(1, this.slots()) && this.queue.length > 0) this.queue.shift()?.go();
  }
}
