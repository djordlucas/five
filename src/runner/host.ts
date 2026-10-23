// Host functions: what a run can ask the five process to do over the IPC
// channel, as `five.<module>.<fn>(...args)` in the child. A run already has
// all of Node, so this is only for what lives in the parent — the model client,
// the tool store, and whatever an embedding program adds through the `host` option.

import type { ChatModel } from "../llm/model.ts";
import type { Logger } from "../log.ts";
import type { ToolStore } from "../tools/store.ts";
import type { Runner } from "./index.ts";

/** A host function. Arguments and result cross the IPC channel as JSON. */
export type HostFn = (...args: never[]) => unknown;

/** Host functions grouped by module: `{ llm: { chat } }` is `five.llm.chat`. */
export type HostModules = Record<string, Record<string, HostFn>>;

/** `five.llm`: one tool-less call to the model the agent runs on. */
export function llmModule(model: ChatModel): HostModules[string] {
  return {
    chat: async (prompt: string, system?: string) => {
      const { message } = await model.complete({
        messages: [
          ...(system ? [{ role: "system" as const, content: system }] : []),
          { role: "user", content: prompt },
        ],
      });
      return message.content ?? "";
    },
  };
}

/**
 * `five.tools.<name>(args)`: call a generated tool from code, in a run of its
 * own, and get its result; a failed run throws its error. The run is recorded
 * in the tool's history like any call, with "code" as its caller.
 */
export function toolsModule(store: ToolStore, runner: () => Runner, log: Logger): HostModules[string] {
  return new Proxy({} as HostModules[string], {
    get: (_, name) => {
      if (typeof name !== "string" || name === "then") return undefined;
      return async (args: unknown = {}) => {
        const tool = store.get(name);
        if (!tool) throw new Error(`no tool named "${name}"`);
        if (tool.meta.disabled) throw new Error(`tool "${name}" is disabled (${tool.meta.disabled.reason})`);
        const at = new Date().toISOString();
        const r = await runner().startFile(
          tool.file,
          args,
          tool.meta.timeoutMs,
          log.child({ tool: name, revision: tool.meta.revision, mode: "code" }),
        ).done;
        if (store.isOpen) {
          store.recordRun(name, {
            at,
            revision: tool.meta.revision,
            agent: "code",
            mode: "sync",
            ok: r.ok,
            durationMs: r.durationMs,
            ...(!r.ok && { error: (r.error ?? "").split("\n")[0] }),
          });
        }
        if (!r.ok) throw new Error(r.error ?? "failed");
        return r.value ?? null;
      };
    },
  });
}
