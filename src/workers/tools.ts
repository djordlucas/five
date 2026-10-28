// The tools agents get. Each agent gets only the ones it needs — every tool's
// definition is sent with every model call, and a small model reads them all.
//
// Workspace and web tools are five's own and small. seven's built-ins (run_js,
// define_tool, sql, …), the media tools and the tools the agent built are
// wrapped here so any agent can be given them by name.

import {
  awaitRun,
  type BuiltinContext,
  builtins,
  disabledError,
  formatRun,
  startGenerated,
} from "../agent/builtins/index.ts";
import { mediaToolsByName } from "../agent/media.ts";
import { Workspace, WorkspaceError } from "../api/workspace.ts";
import { type AgentTool, futureDate } from "./agent.ts";
import { MAX_INPUT, MAX_TITLE } from "./board.ts";
import type { Deps, Run } from "./run.ts";
import { FIXED } from "./store.ts";
import { fetchText, formatResults, searchWeb } from "./web.ts";

/** Who calls tools, in run histories. */
export const AGENT_ID = "five";

/** Lines read_file gives at once by default. */
const READ_LINES = 200;

const str = (v: unknown) => (typeof v === "string" ? v : v === undefined || v === null ? "" : String(v));

export function workspaceTools(d: Deps): AgentTool[] {
  const ws = () => new Workspace(d.workspace);
  const guard = async (fn: () => string | Promise<string>) => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof WorkspaceError) return `error: ${err.message}`;
      throw err;
    }
  };
  return [
    {
      name: "read_file",
      description: `Read a text file in the workspace: ${READ_LINES} lines from \`from\` (1 by default), with the file's line count.`,
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative to the workspace." },
          from: { type: "integer", description: "The first line to read, from 1." },
          lines: { type: "integer", description: `How many lines; ${READ_LINES} by default.` },
        },
        required: ["path"],
      },
      run: (a) =>
        guard(() => {
          const { entry, bytes } = ws().read(str(a.path));
          if (bytes.subarray(0, 8000).includes(0)) return `${entry.path} is a binary file (${entry.bytes} bytes).`;
          const all = bytes.toString("utf8").split("\n");
          const from = Math.max(1, Number(a.from) || 1);
          const n = Math.max(1, Number(a.lines) || READ_LINES);
          const part = all.slice(from - 1, from - 1 + n);
          const whole = from === 1 && part.length >= all.length;
          const head = whole
            ? `${entry.path}, ${all.length} lines:`
            : `${entry.path}, lines ${from}–${from - 1 + part.length} of ${all.length}:`;
          return `${head}\n${part.join("\n")}`;
        }),
    },
    {
      name: "write_file",
      description:
        "Write a new text file in the workspace; directories are made as needed. A file that exists is replaced only with replace: true — other workers' files may be there, so to add to a file use append_file.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
          replace: {
            type: "boolean",
            description: "Replace the file if it exists: only your own file, rewritten whole.",
          },
        },
        required: ["path", "content"],
      },
      run: (a) =>
        guard(() => {
          const later = futureDate(str(a.path));
          if (later) return `error: ${later}`;
          const w = ws();
          if (a.replace !== true) {
            try {
              const { entry } = w.read(str(a.path));
              return `error: ${entry.path} exists (${entry.bytes} bytes) and was not replaced. Add to it with append_file, write to another path, or — if it is yours to rewrite whole — call write_file again with replace: true.`;
            } catch (err) {
              if (!(err instanceof WorkspaceError && err.status === 404)) throw err;
            }
          }
          const e = w.write(str(a.path), Buffer.from(str(a.content)));
          return `wrote ${e.path} (${e.bytes} bytes)`;
        }),
    },
    {
      name: "append_file",
      description:
        "Add text to the end of a file in the workspace, on a new line; the file is made if it is not there.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
      },
      run: (a) =>
        guard(() => {
          const w = ws();
          let before = "";
          try {
            before = w.read(str(a.path)).bytes.toString("utf8");
          } catch (err) {
            if (!(err instanceof WorkspaceError && err.status === 404)) throw err;
          }
          const sep = before && !before.endsWith("\n") ? "\n" : "";
          const add = str(a.content);
          const e = w.write(str(a.path), Buffer.from(before + sep + (add.endsWith("\n") ? add : `${add}\n`)));
          return `appended to ${e.path} (${e.bytes} bytes now)`;
        }),
    },
    {
      name: "list_files",
      description: "List a directory of the workspace: its directories, then its files with their sizes.",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: 'Relative to the workspace; "" or "." for its top.' } },
      },
      run: (a) =>
        guard(() => {
          const p = str(a.path).replace(/^\.\/?$/, "");
          const dir = ws().list(p);
          if (!dir.entries.length) return `${dir.path || "the workspace"} is empty.`;
          const shown = dir.entries.slice(0, 200);
          const lines = shown.map((e) => (e.dir ? `${e.path}/` : `${e.path} (${e.bytes} bytes)`));
          if (dir.entries.length > shown.length) lines.push(`… and ${dir.entries.length - shown.length} more`);
          return lines.join("\n");
        }),
    },
  ];
}

export function webTools(): AgentTool[] {
  return [
    {
      name: "fetch_url",
      description:
        "Get a web page as plain text, or a feed (RSS, Atom) as its list of items. A long page is kept whole in a file, and you get its start.",
      parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
      run: async (a, run) => fetchText(str(a.url), run.signal),
    },
    {
      name: "search_web",
      description: "Search the web: the top results, each with its title, URL and a snippet.",
      parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      run: async (a, run) => formatResults(str(a.query), await searchWeb(str(a.query), run.signal)),
    },
  ];
}

/** Post, read and cancel tasks; `by` is who posts. */
export function boardTools(d: Deps, by: string): AgentTool[] {
  return [
    {
      name: "post_task",
      description:
        "Put a task on the board for a task worker: five runs that worker for it as soon as one is free. The title says what to do in a line; the input is everything the worker needs, as its description asks.",
      parameters: {
        type: "object",
        properties: {
          worker: { type: "string", description: "The task worker that does it." },
          title: { type: "string" },
          input: { type: "string", description: "What the worker gets." },
        },
        required: ["worker", "title"],
      },
      run: async (a, run) => {
        const worker = str(a.worker).trim();
        if (!d.workers.get(worker)) {
          const names = d.workers.list().map((w) => w.name);
          return `error: no task worker named "${worker}". Task workers: ${names.join(", ") || "none yet: define_worker makes one"}.`;
        }
        const title = str(a.title).trim();
        if (!title) return "error: give the task a title";
        if (title.length > MAX_TITLE)
          return `error: a title is at most ${MAX_TITLE} characters; put the rest in the input`;
        const input = str(a.input);
        const later = futureDate(`${title}\n${input}`);
        if (later) return `error: ${later}`;
        if (input.length > MAX_INPUT)
          return `error: an input is at most ${MAX_INPUT} characters; put long data in a file and name it`;
        const task = d.board.post({ worker, title, input, by });
        run.emit({ type: "task", action: "posted", id: task.id, worker, title, by });
        return `posted task #${task.id} for ${worker}.`;
      },
    },
    {
      name: "read_task",
      description: "A task with its whole input and result.",
      parameters: { type: "object", properties: { id: { type: "integer" } }, required: ["id"] },
      run: async (a) => {
        const t = d.board.get(Number(a.id));
        if (!t) return `error: no task #${String(a.id)}`;
        return [
          `#${t.id} [${t.status}] ${t.worker}: ${t.title}`,
          `posted by ${t.postedBy} at ${t.createdAt}${t.endedAt ? `, ended ${t.endedAt}` : ""}`,
          t.input && `input:\n${t.input}`,
          t.result && `result:\n${t.result}`,
          t.error && `error:\n${t.error}`,
        ]
          .filter(Boolean)
          .join("\n");
      },
    },
    {
      name: "cancel_task",
      description: "Take an open task off the board.",
      parameters: { type: "object", properties: { id: { type: "integer" } }, required: ["id"] },
      run: async (a, run) => {
        const t = d.board.get(Number(a.id));
        if (!t || !d.board.cancel(t.id)) return `error: #${String(a.id)} is not an open task`;
        run.emit({ type: "task", action: "cancelled", id: t.id, worker: t.worker, title: t.title, by });
        return `cancelled #${t.id}`;
      },
    },
  ];
}

export function goalTool(d: Deps, by: string): AgentTool {
  return {
    name: "set_goal",
    description: "Replace five's goal: what all its work is for. The lead plans from it at its next run.",
    parameters: { type: "object", properties: { goal: { type: "string" } }, required: ["goal"] },
    run: async (a) => {
      const goal = str(a.goal).trim();
      if (goal.length < 10) return "error: say the goal in a sentence or more";
      d.setGoal(goal, by);
      return "goal set.";
    },
  };
}

/** Seven's built-ins, the media tools and the agent's own tools, by name; undefined for none of these. */
export function codeTool(d: Deps, name: string): AgentTool | undefined {
  const ctx = (run: Run): BuiltinContext => ({
    agentId: AGENT_ID,
    runner: d.runner,
    store: d.store,
    libs: d.libs,
    runs: d.runs,
    workspace: d.workspace,
    stateDb: d.state.path,
    signal: run.signal,
    log: run.log,
  });
  const builtin = builtins().get(name);
  if (builtin) return { ...pick(builtin), run: (a, run) => builtin.run(a, ctx(run)) };
  const media = mediaToolsByName.get(name);
  if (media) {
    return {
      ...pick(media),
      run: (a, run) =>
        media.run(a, {
          workspace: d.workspace,
          imageSide: d.settings.current.imageSide,
          attachImage: (p) => run.attached.push(p),
        }),
    };
  }
  const tool = d.store.get(name);
  if (!tool || tool.meta.disabled) return undefined;
  return {
    name,
    description: tool.meta.description,
    parameters: tool.meta.parameters,
    run: async (a, run) => {
      const fresh = d.store.get(name);
      if (!fresh) return `error: the tool ${name} was deleted`;
      if (fresh.meta.disabled) return disabledError(fresh);
      const c = ctx(run);
      return formatRun(await awaitRun(startGenerated(c, fresh, a, "sync"), c.signal));
    },
  };
}

/** Tools by name, from every kind; the names no tool has are returned apart. */
export function toolsByName(d: Deps, names: string[]): { tools: AgentTool[]; missing: string[] } {
  const own = new Map([...workspaceTools(d), ...webTools()].map((t) => [t.name, t]));
  const tools: AgentTool[] = [];
  const missing: string[] = [];
  for (const name of new Set(names)) {
    const t = own.get(name) ?? codeTool(d, name);
    if (t) tools.push(t);
    else missing.push(name);
  }
  return { tools, missing };
}

/** Whether a name is free for a task worker: not a fixed worker's. */
export function isFixedWorker(name: string): boolean {
  return FIXED.has(name);
}

function pick<T extends { name: string; description: string; parameters: Record<string, unknown> }>(t: T) {
  return { name: t.name, description: t.description, parameters: t.parameters };
}
