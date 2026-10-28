// The chat: the person talks with five, live. A fixed worker, and the one
// whose context lasts beyond one answer: the chat is one run, its messages kept
// while it is open so each answer reads only what is new. It starts from a
// snapshot of five now — the goal, the board, what runs — and answers with its
// tools: the files, the board, the web. It can change course for the person:
// set the goal, post tasks. The other workers keep working all along.
//
// When the person leaves, or does not answer in time, the chat ends: its
// transcript is saved to chats/, and the lead reads it at its next run.

import * as fs from "node:fs";
import * as path from "node:path";
import type { ChatEnd, ChatStatus } from "../api/types.ts";
import type { Message } from "../llm/model.ts";
import { runAgent } from "./agent.ts";
import { clip } from "./board.ts";
import { type Deps, type Run, runScope } from "./run.ts";
import { boardTools, goalTool, webTools, workspaceTools } from "./tools.ts";

export const CHATS_DIR = "chats";

export const CHAT_SYSTEM = `You are five, talking live with the person who follows your work. Five is a program that runs on its own as a team of small workers: a lead plans and posts tasks on a board, task workers do them, and you are the one who talks.

Answer briefly and plainly, from what you know and what your tools show: the files in the workspace, the board, the web. Say so when you do not know. When the person asks you to change course, do it now: set_goal changes the goal, post_task puts work on the board, and the lead reads this chat afterwards. Reply without a tool call to answer them.`;

/** One open chat. */
export class ChatSession {
  readonly run: Run;
  private readonly d: Deps;
  private readonly messages: Message[] = [];
  private readonly transcript: string[] = [];
  private queue: string[] = [];
  private busy = false;
  private waitUntil?: number;
  private timer?: NodeJS.Timeout;
  private ended = false;
  private leaving = false;
  /** Resolves when the chat ends, with what the lead should read. */
  readonly done: Promise<{ reason: ChatEnd | "stopped"; saved?: string; transcript: string }>;
  private finish!: (r: { reason: ChatEnd | "stopped"; saved?: string; transcript: string }) => void;
  private readonly snapshot: () => string;

  constructor(d: Deps, run: Run, snapshot: () => string) {
    this.d = d;
    this.run = run;
    this.snapshot = snapshot;
    this.done = new Promise((resolve) => {
      this.finish = resolve;
    });
    run.emit({ type: "run_started", worker: "chat", kind: "chat" });
    run.signal.addEventListener("abort", () => this.end("stopped"), { once: true });
  }

  status(): ChatStatus {
    return {
      run: this.run.n,
      busy: this.busy,
      ...(this.waitUntil && !this.busy && { waitingUntil: new Date(this.waitUntil).toISOString() }),
      queued: [...this.queue],
    };
  }

  /** The person says something: answered now, or after the answer in progress. */
  say(text: string): void {
    if (this.ended) return;
    this.queue.push(text);
    this.leaving = false;
    // The person's call comes from the API, outside the chat's run: put it back in it.
    if (!this.busy) void runScope.run(this.run, () => this.answer());
  }

  /** The person leaves: the chat ends, once an answer in progress is done. */
  leave(): void {
    this.queue = [];
    if (this.busy) this.leaving = true;
    else this.end("left");
  }

  private async answer(): Promise<void> {
    this.busy = true;
    clearTimeout(this.timer);
    try {
      while (this.queue.length && !this.ended) {
        const said = this.queue;
        this.queue = [];
        for (const text of said) {
          this.transcript.push(`The person: ${text}`);
          this.run.emit({ type: "chat", text });
        }
        const text = said.join("\n\n");
        this.messages.push({
          role: "user",
          content: this.messages.length ? text : `## Five now\n\n${this.snapshot()}\n\n## The person says\n\n${text}`,
        });
        const r = await runAgent(this.d, this.run, {
          system: CHAT_SYSTEM,
          messages: this.messages,
          tools: chatTools(this.d),
          chat: true,
          priority: 1,
        });
        this.transcript.push(`Five: ${r.text}`);
        if (r.outcome === "budget") {
          this.end("left");
          return;
        }
      }
    } catch (err) {
      if (this.run.signal.aborted) return;
      this.run.log.warn("chat answer failed", { error: err instanceof Error ? err.message : String(err) });
      this.transcript.push(`(five could not answer: ${err instanceof Error ? err.message : String(err)})`);
    } finally {
      this.busy = false;
    }
    if (this.ended) return;
    if (this.leaving) {
      this.end("left");
      return;
    }
    const ms = this.d.settings.current.chatWaitSeconds * 1000;
    this.waitUntil = Date.now() + ms;
    this.timer = setTimeout(() => this.end("timeout"), ms);
  }

  private end(reason: ChatEnd | "stopped"): void {
    if (this.ended) return;
    this.ended = true;
    clearTimeout(this.timer);
    const transcript = this.transcript.join("\n\n");
    let saved: string | undefined;
    if (this.transcript.length) {
      const name = `${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}.md`;
      saved = `${CHATS_DIR}/${name}`;
      try {
        fs.mkdirSync(path.join(this.d.workspace, CHATS_DIR), { recursive: true });
        fs.writeFileSync(path.join(this.d.workspace, saved), `# Chat, run ${this.run.n}\n\n${transcript}\n`);
      } catch (err) {
        this.run.log.warn("chat not saved", { error: err instanceof Error ? err.message : String(err) });
        saved = undefined;
      }
    }
    if (reason !== "stopped") this.run.emit({ type: "chat_ended", reason, ...(saved && { saved }) });
    this.finish({ reason, ...(saved && { saved }), transcript });
  }
}

function chatTools(d: Deps) {
  const files = workspaceTools(d).filter((t) => t.name === "read_file" || t.name === "list_files");
  return [...files, ...boardTools(d, "chat"), goalTool(d, "chat"), ...webTools()];
}

/** The latest chat as the lead reads it: its end, when long. */
export function chatForLead(saved: string | undefined, transcript: string, max = 2000): string {
  const t = transcript.length > max ? `…${transcript.slice(-max)}` : transcript;
  return `${saved ? `(${saved}) ` : ""}${clip(t, max + 1)}`;
}
