// The lead: five's planner, a fixed worker. Each run starts fresh — no
// conversation carried over — from a prompt five builds: the goal, the board,
// the task workers, the lead's own notes, and what the person said. The lead
// reads results, posts the next tasks, writes and revises task workers, and
// keeps its notes; then its messages are dropped. What it knows next time is
// what it wrote down.

import * as fs from "node:fs";
import * as path from "node:path";
import { asDeps, depsSchema } from "../agent/builtins/shared.ts";
import type { AgentTool } from "./agent.ts";
import { runAgent } from "./agent.ts";
import { clip } from "./board.ts";
import type { Deps, Run } from "./run.ts";
import { FIXED, WORKER_NAME } from "./store.ts";
import { buildWorker, runWorker } from "./task.ts";
import { boardTools, codeTool, goalTool, workspaceTools } from "./tools.ts";

/** The lead's notes, in the workspace. */
export const NOTES = "memory/lead.md";
const NOTES_CHARS = 2000;
/** The latest chat, as the lead gets it. */
const CHAT_CHARS = 2000;
/** How long a define_worker trial may run. */
const TRIAL_MS = 180_000;

export const LEAD_SYSTEM = `You are the lead of five: a program that runs on its own, without end, as a team of small workers. You plan; the workers do. Nobody gives you tasks: the goal is yours to pursue, and to sharpen.

How five works:
- The board holds tasks. Each names a task worker; five runs that worker for it as soon as one is free, several at once. A task's result is short and names the files where the work is.
- A task worker is code: an ES module whose default export gets { task } (id, title, input) and returns the result. In it, five.llm.ask(prompt, { schema }) asks the model once (with a JSON schema, it returns the parsed object), five.llm.agent({ prompt, tools }) runs a small agent with tools such as search_web, fetch_url, read_file, write_file, five.web.feed(url) / text(url) / search(query) read the web, five.board.post(worker, title, input) posts a task, and Node's fs reads and writes the workspace. Let code do what code can — fetching, parsing, files — and the model only what needs judgment: that keeps every call small.
- define_worker writes or revises a task worker (with test_input, it is tried first and only saved if it works); read_worker shows one. Your libraries (define_library) are shared code workers import as "lib:name".
- Workers share the workspace: they exchange data through files. Keep it organized.
- Your context is small and fresh every run: what you know is in this prompt — the goal, the board, the workers, your notes. Keep your notes (${NOTES}) short and current with write_file: what you learned, what works, what to do next.

Each run: read the results, decide what comes next, post tasks, fix or write workers when results are poor or missing, update your notes, and message the person (message_person) only when something matters to them. Then reply with one line: what you did.`;

/** The lead's run: its prompt, built now, and its tools. */
export async function runLead(d: Deps, run: Run, more: { chat?: string }): Promise<string> {
  const prompt = leadPrompt(d, run, more);
  run.emit({ type: "run_started", worker: "lead", kind: "lead", prompt });
  const r = await runAgent(d, run, {
    system: LEAD_SYSTEM,
    messages: [{ role: "user", content: prompt }],
    tools: leadTools(d),
  });
  return r.outcome === "done" ? r.text : `${r.outcome === "budget" ? "out of context" : "out of steps"}: ${r.text}`;
}

function leadPrompt(d: Deps, run: Run, more: { chat?: string }): string {
  const { minOpenTasks } = d.settings.current;
  const workers = d.workers.list();
  let notes = "";
  try {
    notes = fs.readFileSync(path.join(d.workspace, NOTES), "utf8").trim();
  } catch {
    // None yet.
  }
  // The person's inbox messages: read now.
  const unread = d.state.undelivered();
  d.state.markDelivered(
    unread.map((m) => m.id),
    run.n,
  );
  const counts = d.board.counts();
  const parts = [
    "## Goal",
    "",
    d.goal(),
    "",
    "## Board",
    "",
    d.board.summary(),
    "",
    "## Task workers",
    "",
    ...(workers.length
      ? workers.map((w) => {
          const t = d.board.tally(w.name);
          return `- ${w.name} (r${w.revision}; ${t.done} done, ${t.failed} failed): ${clip(w.description, 300)}`;
        })
      : ["None yet: define_worker writes one."]),
    "",
    `## Your notes (${NOTES})`,
    "",
    notes ? clip(notes, NOTES_CHARS) : "None yet.",
  ];
  if (unread.length || more.chat) {
    parts.push("", "## From the person", "");
    for (const m of unread) parts.push(`They wrote (${m.at.slice(0, 16).replace("T", " ")} UTC): ${m.text}`);
    if (more.chat) parts.push(`Your latest chat with them:\n${clip(more.chat, CHAT_CHARS)}`);
  }
  parts.push(
    "",
    "## Now",
    "",
    `${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC, run ${run.n}. ${counts.open} open, ${counts.running} running; keep at least ${minOpenTasks} open. Decide, act, and reply with one line.`,
  );
  return parts.join("\n");
}

function leadTools(d: Deps): AgentTool[] {
  const code = (name: string) => codeTool(d, name);
  const files = workspaceTools(d).filter((t) => t.name !== "append_file");
  return [
    ...boardTools(d, "lead"),
    ...workerTools(d),
    goalTool(d, "lead"),
    messageTool(d),
    ...files,
    ...(["define_library", "read_library", "run_js"].map(code).filter(Boolean) as AgentTool[]),
  ];
}

/** Write, read and delete task workers: never the fixed ones. */
export function workerTools(d: Deps): AgentTool[] {
  return [
    {
      name: "define_worker",
      description:
        "Write or revise a task worker: an ES module whose default export is `async ({ task }) => result`, task being { id, title, input }. " +
        "Its description says what it does and what input it wants: you read it when posting tasks. With test_input, it runs once on a trial task first and is saved only if that succeeds.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: `snake_case, matching ${WORKER_NAME}.` },
          description: { type: "string" },
          code: { type: "string", description: "The module's source; TypeScript allowed." },
          deps: depsSchema,
          test_input: { type: "string", description: "The input of a trial task." },
          timeout_seconds: { type: "integer", description: "How long one of its runs may take, for a slow worker." },
        },
        required: ["name", "description", "code"],
      },
      run: async (a, run) => {
        const name = String(a.name ?? "");
        if (FIXED.has(name)) return `error: "${name}" is one of five's own workers; it cannot be replaced`;
        if (!WORKER_NAME.test(name)) return `error: name must match ${WORKER_NAME}`;
        const source = typeof a.code === "string" ? a.code : "";
        if (!/\bexport\s+default\b/.test(source))
          return "not saved: the code needs `export default async ({ task }) => …`";
        const deps = asDeps(a.deps) ?? {};
        let built: Awaited<ReturnType<typeof buildWorker>>;
        try {
          built = await buildWorker(d, source, deps);
        } catch (err) {
          return `not saved: ${err instanceof Error ? err.message : String(err)}`;
        }
        const timeoutMs = typeof a.timeout_seconds === "number" ? Math.round(a.timeout_seconds * 1000) : undefined;
        const draft = {
          meta: {
            name,
            description: String(a.description ?? ""),
            deps,
            revision: 0,
            createdAt: "",
            updatedAt: "",
            ...(timeoutMs && { timeoutMs }),
          },
          source,
          ...(built && { bundle: built.code }),
        };
        let trial = "";
        if (typeof a.test_input === "string") {
          try {
            const out = await runWorker(
              d,
              run,
              draft,
              { id: 0, title: "trial", input: a.test_input },
              Math.min(timeoutMs ?? TRIAL_MS, TRIAL_MS),
            );
            trial = `\ntrial result:\n${clip(out, 1500)}`;
          } catch (err) {
            if (run.signal.aborted) throw err;
            return `not saved: the trial failed\n${clip(err instanceof Error ? err.message : String(err), 2000)}`;
          }
        }
        const meta = d.workers.save({
          name,
          description: draft.meta.description,
          deps,
          source,
          ...(timeoutMs && { timeoutMs }),
          ...(built && { bundle: built.code, libs: built.libs }),
        });
        run.emit({ type: "worker", action: "defined", name, revision: meta.revision });
        return `saved worker ${name} (revision ${meta.revision}). post_task gives it work.${trial}`;
      },
    },
    {
      name: "read_worker",
      description: "A task worker's description, its tasks done and failed, and its code.",
      parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
      run: async (a) => {
        const w = d.workers.get(String(a.name ?? ""));
        if (!w) return `error: no task worker named "${String(a.name)}"`;
        const t = d.board.tally(w.meta.name);
        return `${w.meta.name} r${w.meta.revision}, ${t.done} done, ${t.failed} failed\n${w.meta.description}\n\n--- code ---\n${w.source}`;
      },
    },
    {
      name: "delete_worker",
      description: "Delete a task worker. Its open tasks fail.",
      parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
      run: async (a, run) => {
        const name = String(a.name ?? "");
        if (FIXED.has(name)) return `error: "${name}" is one of five's own workers`;
        if (!d.workers.remove(name)) return `error: no task worker named "${name}"`;
        run.emit({ type: "worker", action: "deleted", name });
        return `deleted ${name}`;
      },
    },
  ];
}

/** message_person: one a run. */
function messageTool(d: Deps): AgentTool {
  let sent = false;
  return {
    name: "message_person",
    description:
      "Put a message in the person's inbox: progress, a finding, a question. They read it now and then; their reply comes in a later run's prompt. One a run.",
    parameters: {
      type: "object",
      properties: { subject: { type: "string", description: "A few words." }, text: { type: "string" } },
      required: ["subject", "text"],
    },
    run: async (a, run) => {
      const subject = String(a.subject ?? "").trim();
      const text = String(a.text ?? "").trim();
      if (!subject || subject.length > 120) return "error: give the message a subject of at most 120 characters";
      if (!text) return "error: the message is empty";
      if (sent) return "error: one message a run; this run sent one already";
      sent = true;
      d.state.addInbox(run.n, "five", text, { subject });
      run.emit({ type: "inbox", from: "five", subject, text });
      return "sent.";
    },
  };
}
