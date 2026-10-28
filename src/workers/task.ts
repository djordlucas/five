// A task worker at work: its code runs in a child process of its own, called
// with `{ task }`, and its return value is the task's result. It reaches five
// through host functions bound to its run:
//
//   five.llm.ask(prompt, { system?, schema?, maxTokens? })  one model call; with
//       a JSON schema, the reply is parsed and returned as an object
//   five.llm.agent({ prompt, system?, tools?, maxSteps? })   a small agent with
//       the tools named (the workspace and web ones by default); its answer
//   five.web.text(url) · five.web.feed(url) · five.web.search(query)
//   five.board.post(worker, title, input?)                  a task for another worker
//
// and Node's own fs, fetch and the rest, in the workspace.

import { awaitRun } from "../agent/builtins/index.ts";
import type { HostModules } from "../runner/index.ts";
import { type Bundled, bundleLibraries, importsLibraries } from "../tools/libs.ts";
import { runAgent } from "./agent.ts";
import { MAX_INPUT, MAX_TITLE } from "./board.ts";
import { type Deps, type Run, runScope } from "./run.ts";
import type { StoredWorker } from "./store.ts";
import { toolsByName } from "./tools.ts";
import { fetchFeed, fetchText, searchWeb } from "./web.ts";

/** The tools llm.agent gets when the worker names none. */
export const AGENT_TOOLS = ["read_file", "write_file", "append_file", "list_files", "fetch_url", "search_web"];

const AGENT_SYSTEM =
  "You are a worker of five, a program that runs on its own. Do the one task you are given with your tools, " +
  "keep what you make in files in the workspace, and reply with a short result: what you did and the files you wrote.";

/** The longest prompt an event keeps of one llm.ask. */
const SHOWN_PROMPT = 2000;

export interface TaskInput {
  id: number;
  title: string;
  input: string;
}

/** Run a worker's code for a task, in `run`. Resolves with its result; rejects with its error. */
export async function runWorker(
  d: Deps,
  run: Run,
  worker: StoredWorker,
  task: TaskInput,
  timeoutMs?: number,
): Promise<string> {
  const code = worker.bundle ?? worker.source;
  run.setLive("code");
  const handle = d.runner.startEval(code, {
    args: { task },
    deps: worker.meta.deps,
    timeoutMs: timeoutMs ?? worker.meta.timeoutMs ?? d.settings.current.taskTimeoutSeconds * 1000,
    log: run.log,
    host: hostFor(d, run),
    label: `worker ${worker.meta.name}`,
  });
  const r = await awaitRun(handle, run.signal);
  run.live = undefined;
  if (run.signal.aborted) throw new Error("stopped");
  if (!r.ok) {
    const out = r.logs.length ? `\n--- output ---\n${r.logs.slice(-20).join("\n")}` : "";
    throw new Error(`${r.error ?? "failed"}${out}`);
  }
  const v = r.value;
  if (v === null || v === undefined || v === "") return "(the worker returned nothing)";
  return typeof v === "string" ? v : JSON.stringify(v, null, 2);
}

/** Bundle a worker's libraries into it and install its packages; throws with what is wrong. */
export async function buildWorker(d: Deps, source: string, deps: Record<string, string>): Promise<Bundled | undefined> {
  const built = importsLibraries(source) ? await bundleLibraries(source, d.libs, d.runner.home) : undefined;
  // Bundling also checks the syntax of one that imports none.
  if (!built) await bundleLibraries(source, d.libs, d.runner.home);
  await d.runner.install(built?.code ?? source, { ...built?.deps, ...deps }, d.log);
  return built;
}

/** The host functions of a task worker's run. */
function hostFor(d: Deps, run: Run): HostModules {
  // Host calls arrive over IPC, outside the run's async context: put them back in it.
  const inRun =
    <A extends unknown[], R>(fn: (...a: A) => Promise<R>) =>
    (...a: A): Promise<R> =>
      runScope.run(run, async () => {
        try {
          return await fn(...a);
        } finally {
          if (!run.signal.aborted) run.setLive("code");
        }
      });
  return {
    llm: {
      ask: inRun(async (prompt: unknown, opts: unknown) =>
        ask(d, run, String(prompt ?? ""), (opts ?? {}) as AskOptions),
      ),
      // seven's name for a one-shot call.
      chat: inRun(async (prompt: unknown, system: unknown) =>
        ask(d, run, String(prompt ?? ""), { ...(typeof system === "string" && { system }) }),
      ),
      agent: inRun(async (o: unknown) => agent(d, run, (o ?? {}) as AgentCall)),
    },
    web: {
      text: inRun(async (url: unknown) => fetchText(String(url), run.signal)),
      feed: inRun(async (url: unknown) => fetchFeed(String(url), run.signal)),
      search: inRun(async (q: unknown) => searchWeb(String(q), run.signal)),
    },
    board: {
      post: inRun(async (worker: unknown, title: unknown, input: unknown) => {
        const w = String(worker ?? "");
        if (!d.workers.get(w)) throw new Error(`no task worker named "${w}"`);
        const t = String(title ?? "").trim();
        if (!t || t.length > MAX_TITLE) throw new Error(`a title is 1 to ${MAX_TITLE} characters`);
        const i = typeof input === "string" ? input : input === undefined ? "" : JSON.stringify(input);
        if (i.length > MAX_INPUT) throw new Error(`an input is at most ${MAX_INPUT} characters`);
        const task = d.board.post({ worker: w, title: t, input: i, by: run.worker });
        run.emit({ type: "task", action: "posted", id: task.id, worker: w, title: t, by: run.worker });
        return task.id;
      }),
    },
  };
}

interface AskOptions {
  system?: string;
  schema?: Record<string, unknown>;
  maxTokens?: number;
}

async function ask(d: Deps, run: Run, prompt: string, o: AskOptions): Promise<unknown> {
  if (!prompt.trim()) throw new Error("llm.ask: the prompt is empty");
  run.step++;
  const step = run.step;
  run.setLive("queued");
  const t0 = performance.now();
  const { completion, waitedMs } = await d.pool.complete(
    {
      messages: [
        ...(o.system ? [{ role: "system" as const, content: o.system }] : []),
        { role: "user", content: prompt },
      ],
      signal: run.signal,
      log: run.log.child({ step }),
      ...(o.schema && { format: o.schema }),
      ...(typeof o.maxTokens === "number" && { maxTokens: o.maxTokens }),
      onProgress: ({ thinking, content }) => {
        if (run.live?.phase === "model") Object.assign(run.live, { thinking, content });
      },
    },
    { onStart: () => run.setLive("model") },
  );
  run.promptTokens = completion.usage?.prompt_tokens ?? run.promptTokens;
  const content = completion.message.content ?? "";
  run.emit({
    type: "model",
    step,
    content,
    ...(completion.message.thinking && { thinking: completion.message.thinking }),
    calls: [],
    prompt: prompt.length > SHOWN_PROMPT ? `${prompt.slice(0, SHOWN_PROMPT)}…` : prompt,
    promptTokens: completion.usage?.prompt_tokens,
    completionTokens: completion.usage?.completion_tokens,
    durationMs: Math.round(performance.now() - t0) - waitedMs,
    ...(waitedMs > 50 && { waitedMs }),
  });
  if (!o.schema) return content;
  try {
    return JSON.parse(content);
  } catch {
    throw new Error(`llm.ask: the reply is not the JSON asked for: ${content.slice(0, 200)}`);
  }
}

interface AgentCall {
  prompt?: string;
  system?: string;
  tools?: string[];
  maxSteps?: number;
}

async function agent(d: Deps, run: Run, o: AgentCall): Promise<string> {
  const prompt = String(o.prompt ?? "").trim();
  if (!prompt) throw new Error("llm.agent: give it a prompt");
  const { tools, missing } = toolsByName(d, Array.isArray(o.tools) ? o.tools.map(String) : AGENT_TOOLS);
  if (missing.length) throw new Error(`llm.agent: no tool named ${missing.join(", ")}`);
  const r = await runAgent(d, run, {
    system: o.system ? String(o.system) : AGENT_SYSTEM,
    messages: [{ role: "user", content: prompt }],
    tools,
    ...(typeof o.maxSteps === "number" && { maxSteps: o.maxSteps }),
  });
  return r.text;
}
