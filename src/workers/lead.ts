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
import { RESULTS_DIR, runAgent } from "./agent.ts";
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
/** Files the lead's prompt lists. */
const RECENT_FILES = 15;
/** How long a define_worker trial may run. */
const TRIAL_MS = 180_000;

export const LEAD_SYSTEM = `You are the lead of five: a program that runs on its own, without end, as a team of small workers. You plan; the workers do. Nobody gives you tasks: the goal is yours to pursue, and to sharpen.

How five works:
- The board holds tasks. Each names a task worker; five runs that worker for it as soon as one is free, several at once. A task's result is short and names the files where the work is.
- A task worker is code: an ES module whose default export gets { task } (id, title, input) and returns the result. In it, five.llm.ask(prompt, { schema }) asks the model once (with a JSON schema, it returns the parsed object), five.llm.agent({ prompt, tools }) runs a small agent with tools such as search_web, fetch_url, read_file, write_file, five.web.feed(url) / text(url) / search(query) read the web, five.web.read() gives what the run's agents read (to check their reports against), five.board.post(worker, title, input) posts a task, and Node's fs reads and writes the workspace. Let code do what code can — fetching, parsing, files — and the model only what needs judgment: that keeps every call small.
- Your task workers already work: give them tasks. Five lets you revise one only after its tasks fail — read_worker it first, and fix what the errors show. define_worker writes a new worker or revises one; it is tried once on test_input first, on a copy of the workspace, and saved only if that works. When a run fails, five puts back the files it changed. Five keeps only a few task workers, and a result that does not say in words what was done counts as a failure. Your libraries (define_library) are shared code workers import as "lib:name".
- Workers share the workspace: they exchange data through files. Keep it organized.
- Some work five posts itself: a task for the feeds worker every few minutes, and that worker posts research tasks for the weightiest new stories. Five refuses a task like one already open, running or just done.
- A follow-up on a story names it in the task's input as \`story: <slug>\`, the slug its research result gave: it adds to that story's file.
- Leave dates out of tasks and paths: five and its workers know today's date and add it themselves.
- Your context is small and fresh every run: what you know is in this prompt — the goal, the board, the workers, your notes. Keep your notes (${NOTES}) short and current with write_file (replace: true): what you learned, what works, what to do next.

Each run: read the results, decide what comes next — pick what to follow from what the workers found (the board's results, the files), never from memory: a follow-up on a story the workers found, a question its results leave open — post tasks for your workers, write a new worker only for work none of them does, update your notes, and message the person (message_person) only when something matters to them. Then reply with one line: what you did.`;

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
    "",
    "## Files changed lately",
    "",
    ...recentFiles(d.workspace),
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
    `${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC, run ${run.n}. ${counts.open} open, ${counts.running} running; keep at least ${minOpenTasks} open, so every worker slot has work.${counts.open < minOpenTasks ? ` Post at least ${minOpenTasks - counts.open} tasks now, on different topics, before anything else.` : ""} Decide, act, and reply with one line.`,
  );
  return parts.join("\n");
}

/** Directories the lead's file list leaves out: five's own, kept results, chats. */
const UNLISTED = new Set([".five", RESULTS_DIR, "chats", "node_modules"]);

/** The workspace's most recently changed files, newest first: what the workers have been making. */
function recentFiles(workspace: string, n = RECENT_FILES): string[] {
  const found: { rel: string; bytes: number; at: number }[] = [];
  const walk = (dir: string, depth: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(workspace, dir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".") || (depth === 0 && UNLISTED.has(e.name))) continue;
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (depth < 4) walk(rel, depth + 1);
      } else if (e.isFile()) {
        const st = fs.statSync(path.join(workspace, rel));
        found.push({ rel, bytes: st.size, at: st.mtimeMs });
      }
    }
  };
  walk("", 0);
  if (!found.length) return ["None yet."];
  const now = Date.now();
  return found
    .sort((a, b) => b.at - a.at)
    .slice(0, n)
    .map((f) => `- ${f.rel} (${f.bytes} bytes, ${Math.max(0, Math.round((now - f.at) / 60_000))} min ago)`);
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
        "Its description says what it does and what input it wants: you read it when posting tasks. It runs once on a trial task with test_input first, on a copy of the workspace, and is saved only if that succeeds; the trial's result says which files it wrote.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: `snake_case, matching ${WORKER_NAME}.` },
          description: { type: "string" },
          code: { type: "string", description: "The module's source; TypeScript allowed." },
          deps: depsSchema,
          test_input: { type: "string", description: "The input of its trial task." },
          timeout_seconds: { type: "integer", description: "How long one of its runs may take, for a slow worker." },
        },
        required: ["name", "description", "code", "test_input"],
      },
      run: async (a, run) => {
        const name = String(a.name ?? "");
        if (FIXED.has(name)) return `error: "${name}" is one of five's own workers; it cannot be replaced`;
        if (!WORKER_NAME.test(name)) return `error: name must match ${WORKER_NAME}`;
        const source = typeof a.code === "string" ? a.code : "";
        if (!/\bexport\s+default\b/.test(source))
          return "not saved: the code needs `export default async ({ task }) => …`";
        const previous = d.workers.get(name);
        const { maxWorkers } = d.settings.current;
        const all = d.workers.list();
        if (!previous && all.length >= maxWorkers) {
          const tallies = all.map((w) => {
            const t = d.board.tally(w.name);
            return `${w.name} (${t.done} done, ${t.failed} failed)`;
          });
          return `not saved: five keeps at most ${maxWorkers} task workers — ${tallies.join(", ")}. Give tasks to one of them, or delete_worker the one that does least first.`;
        }
        // A worker that works is not the lead's to rewrite: small models rewrite for the sake of it.
        if (previous && d.board.recentFailures(name) === 0) {
          const t = d.board.tally(name);
          return `not saved: ${name} works — ${t.done} tasks done, none of its latest failed. Give it tasks; to do something else, define a worker under a new name.`;
        }
        const deps = asDeps(a.deps) ?? {};
        let built: Awaited<ReturnType<typeof buildWorker>>;
        try {
          built = await buildWorker(d, source, deps);
        } catch (err) {
          return `not saved: ${err instanceof Error ? err.message : String(err)}`;
        }
        if (typeof a.test_input !== "string")
          return "not saved: give test_input: every worker is tried once before it is saved";
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
        // The trial runs on a copy of the workspace: a broken worker breaks nothing.
        const scratch = trialCopy(d);
        let trial: string;
        try {
          const t0 = Date.now();
          const out = await runWorker(
            { ...d, workspace: scratch, history: undefined },
            run,
            draft,
            { id: 0, title: "trial", input: a.test_input },
            Math.min(timeoutMs ?? TRIAL_MS, TRIAL_MS),
          );
          const wrote = changedSince(scratch, t0);
          trial = `\ntrial result:\n${clip(out, 1500)}\nThe trial wrote ${wrote.length ? wrote.join(", ") : "no file"} (on a copy of the workspace, now gone).`;
        } catch (err) {
          if (run.signal.aborted) throw err;
          return `not saved: the trial failed\n${clip(err instanceof Error ? err.message : String(err), 2000)}`;
        } finally {
          fs.rmSync(scratch, { recursive: true, force: true });
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

/** Workspace directories a trial's copy leaves out: five's own, kept results, packages. */
const NOT_COPIED = new Set([".five", RESULTS_DIR, "node_modules"]);

/** A copy of the workspace for a trial, under .five so the run's imports resolve. */
function trialCopy(d: Deps): string {
  const scratch = fs.mkdtempSync(path.join(d.runner.home, "trial-"));
  // Entry by entry: the copy is inside the workspace, which Node will not copy into itself.
  for (const name of fs.readdirSync(d.workspace)) {
    if (!NOT_COPIED.has(name)) fs.cpSync(path.join(d.workspace, name), path.join(scratch, name), { recursive: true });
  }
  return scratch;
}

/** The files under `dir` changed since `t0`. */
function changedSince(dir: string, t0: number): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(r);
      else if (e.isFile() && fs.statSync(path.join(dir, r)).mtimeMs >= t0) out.push(r);
    }
  };
  walk("");
  return out.sort();
}

/** message_person: one a run. */
function messageTool(d: Deps): AgentTool {
  let sent = false;
  return {
    name: "message_person",
    description:
      "Put a message in the person's inbox: progress, a finding, a question. They read it now and then; their reply comes in a later run's prompt. One a run. Name the workspace files it comes from, and say only what they say: the person reads them too.",
    parameters: {
      type: "object",
      properties: {
        subject: { type: "string", description: "A few words." },
        text: { type: "string" },
        files: {
          type: "array",
          items: { type: "string" },
          description: "The workspace files the message comes from, such as a story file; your notes for a question.",
        },
      },
      required: ["subject", "text", "files"],
    },
    run: async (a, run) => {
      const subject = String(a.subject ?? "").trim();
      const text = String(a.text ?? "").trim();
      if (!subject || subject.length > 120) return "error: give the message a subject of at most 120 characters";
      if (!text) return "error: the message is empty";
      if (sent) return "error: one message a run; this run sent one already";
      const files = (Array.isArray(a.files) ? a.files : []).map((f) => String(f).trim()).filter(Boolean);
      const missing = files.filter((f) => !fs.existsSync(path.join(d.workspace, f)));
      if (!files.length) return "error: name the files the message comes from (files): the person checks them";
      if (missing.length) return `error: no such file: ${missing.join(", ")}`;
      sent = true;
      const body = `${text}\n\nFrom: ${files.join(", ")}`;
      d.state.addInbox(run.n, "five", body, { subject });
      run.emit({ type: "inbox", from: "five", subject, text: body });
      return "sent.";
    },
  };
}
