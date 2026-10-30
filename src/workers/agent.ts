// An agent: a model with tools, called until it answers without a tool call.
// The lead, the chat and a task worker's llm.agent are each one. Its context
// only grows — the system prompt, the prompt, then each reply and result
// appended — so every call after the first finds the earlier part already in
// its model slot and only reads what is new. When the agent is done, its
// messages are dropped: what lasts is what it wrote to the workspace and the
// board, and the events the UI shows.
//
// Each agent has a context budget (runTokens): near it, five tells the agent to
// finish; past it, the agent ends. Small contexts keep a busy model fast.

import * as fs from "node:fs";
import * as path from "node:path";
import { checkArgs, coerceArgs, parseArgs } from "../agent/args.ts";
import { imageData } from "../agent/media.ts";
import type { RunEnd } from "../api/types.ts";
import type { Message, ToolCall, ToolDef } from "../llm/model.ts";
import { recoverToolCalls } from "../llm/textcalls.ts";
import { preview } from "../log.ts";
import type { Deps, Run } from "./run.ts";

/** Where a long tool result is kept whole. */
export const RESULTS_DIR = "results";
/** A result is cut here even when it cannot be kept in a file. */
const MAX_RESULT_CHARS = 16_000;
/** The share of the budget at which the agent is told to finish. */
const FINISH_AT = 0.8;

/** The line every system prompt starts with: small models otherwise guess the date. By the day, so it changes a slot's cached start once a day. */
export function today(): string {
  const now = new Date();
  const day = now.toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
  return `Today is ${day}, ${now.toISOString().slice(0, 10)} (UTC). Use this date; never guess another.`;
}

/** A date in the text later than today, which a small model has guessed: say so, or nothing. */
export function futureDate(text: string): string | undefined {
  const now = new Date().toISOString().slice(0, 10);
  const later = text.match(/\b20\d\d-[01]\d-[0-3]\d\b/g)?.find((day) => day > now);
  return later && `${later} has not come yet: today is ${now}. Leave dates out — five and its workers add today's.`;
}

export interface AgentTool extends ToolDef {
  run(args: Record<string, unknown>, run: Run): Promise<string>;
}

export interface AgentOptions {
  system: string;
  /** The agent's messages so far: its prompt, and for the chat what came before. Appended to as it goes. */
  messages: Message[];
  tools: AgentTool[];
  /** Its replies go to the person. */
  chat?: boolean;
  /** Model slot priority: the chat goes first. */
  priority?: number;
  /** Model calls at most; the maxSteps setting otherwise. */
  maxSteps?: number;
}

export interface AgentResult {
  outcome: Extract<RunEnd, "done" | "budget" | "max_steps">;
  /** Its last reply. */
  text: string;
}

/** Run an agent until it answers, runs out of steps, or fills its budget. Throws when the run is stopped. */
export async function runAgent(d: Deps, run: Run, o: AgentOptions): Promise<AgentResult> {
  const { maxSteps, runTokens } = d.settings.current;
  const steps = o.maxSteps ?? maxSteps;
  const byName = new Map(o.tools.map((t) => [t.name, t]));
  const defs: ToolDef[] = o.tools.map(({ name, description, parameters }) => ({ name, description, parameters }));
  let last = "";
  let warned = false;
  for (let i = 0; i < steps; i++) {
    const used = run.promptTokens ?? 0;
    if (used > runTokens && i > 0) {
      return {
        outcome: "budget",
        text: last || `ran out of context (${used} of ${runTokens} tokens) before an answer`,
      };
    }
    if (used > runTokens * FINISH_AT && i > 0 && !warned) {
      warned = true;
      o.messages.push({
        role: "user",
        content: `[five] Your context is nearly full (${used} of ${runTokens} tokens). Finish now: save what matters to files, then reply with your result, without a tool call.`,
      });
    }
    // Small models keep fetching until their steps run out, with nothing written: two before, say so.
    if (steps >= 4 && i === steps - 2) {
      o.messages.push({
        role: "user",
        content: "[five] Two model calls left. Reply now with your result, from what you have, without a tool call.",
      });
    }
    run.step++;
    const step = run.step;
    const stepLog = run.log.child({ step });
    run.setLive("queued");
    const t0 = performance.now();
    // The lead plans on its own model, when it has one; what its trials run uses the workers'.
    const pool = run.kind === "lead" && d.leadPool ? d.leadPool : d.pool;
    const { completion, waitedMs } = await pool.complete(
      {
        messages: [{ role: "system", content: `${today()}\n\n${o.system}` }, ...o.messages],
        ...(defs.length > 0 && { tools: defs }),
        signal: run.signal,
        log: stepLog,
        image: (p) => imageData(d.workspace, p),
        onProgress: ({ thinking, content }) => {
          if (run.live?.phase === "model") Object.assign(run.live, { thinking, content });
        },
      },
      { priority: o.priority ?? 0, onStart: () => run.setLive("model") },
    );
    const durationMs = Math.round(performance.now() - t0) - waitedMs;
    run.promptTokens = completion.usage?.prompt_tokens ?? run.promptTokens;
    let { message } = completion;
    let fromText = false;
    if (!message.tool_calls?.length && message.content) {
      const recovered = recoverToolCalls(message.content, new Set(byName.keys()));
      if (recovered) {
        stepLog.info("tool calls recovered from text", { tools: recovered.map((c) => c.function.name) });
        message = { ...message, content: null, tool_calls: recovered };
        fromText = true;
      }
    }
    const { thinking, ...kept } = message;
    o.messages.push(kept);
    const answer = !message.tool_calls?.length;
    run.emit({
      type: "model",
      step,
      content: message.content,
      ...(thinking && { thinking }),
      calls: (message.tool_calls ?? []).map((c) => ({ id: c.id, ...c.function })),
      ...(fromText && { fromText }),
      ...(answer && o.chat && { chat: true }),
      promptTokens: completion.usage?.prompt_tokens,
      completionTokens: completion.usage?.completion_tokens,
      durationMs,
      ...(waitedMs > 50 && { waitedMs }),
    });
    if (message.content?.trim()) last = message.content.trim();
    if (answer) {
      run.live = undefined;
      return { outcome: "done", text: last };
    }

    run.attached = [];
    for (const call of message.tool_calls ?? []) {
      if (run.signal.aborted) throw new Error("stopped");
      run.setLive("tool", { tool: call.function.name });
      const t1 = performance.now();
      const result = fit(d, run, call, await dispatch(byName, call, run, stepLog));
      o.messages.push({ role: "tool", tool_call_id: call.id, name: call.function.name, content: result });
      run.emit({
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
    if (run.attached.length) {
      const paths = run.attached;
      o.messages.push({
        role: "user",
        content: `[five] ${paths.length === 1 ? "The image" : "The images"} view_image attached: ${paths.join(", ")}`,
        images: paths,
      });
    }
  }
  run.live = undefined;
  return { outcome: "max_steps", text: last || `stopped after ${steps} model calls without an answer` };
}

async function dispatch(tools: Map<string, AgentTool>, call: ToolCall, run: Run, stepLog: Run["log"]): Promise<string> {
  const { name, arguments: raw } = call.function;
  const log = stepLog.child({ call: call.id });
  const started = performance.now();
  let result: string;
  const tool = tools.get(name);
  try {
    if (!tool) {
      result = `error: no tool named "${name}". Your tools: ${[...tools.keys()].join(", ")}.`;
    } else {
      const parsed = parseArgs(raw ?? "");
      const args = parsed.ok ? coerceArgs(tool.parameters, parsed.args) : {};
      const bad = parsed.ok ? checkArgs(tool.parameters, args) : parsed.error;
      result = bad ? `error: ${name}: ${bad}` : await tool.run(args, run);
    }
  } catch (err) {
    if (run.signal.aborted) throw err;
    result = `error: ${err instanceof Error ? err.message : String(err)}`;
  }
  const failed = isFailure(result);
  log[failed ? "warn" : "info"]("tool called", {
    tool: name,
    ok: !failed,
    duration_ms: Math.round(performance.now() - started),
    result_chars: result.length,
    ...(failed && { error: preview(result, 300) }),
  });
  return result;
}

/** A tool result, cut to fit the context: a long one is kept whole in a file the agent is pointed to. */
function fit(d: Deps, run: Run, call: ToolCall, result: string): string {
  const max = d.settings.current.resultChars;
  if (result.length <= max) return result;
  const rel = path.join(RESULTS_DIR, `run-${run.n}-${call.id.replace(/[^\w-]/g, "_")}.txt`);
  try {
    fs.mkdirSync(path.join(d.workspace, RESULTS_DIR), { recursive: true });
    fs.writeFileSync(path.join(d.workspace, rel), result);
  } catch (err) {
    run.log.warn("result not kept", { error: err instanceof Error ? err.message : String(err) });
    return result.length > MAX_RESULT_CHARS ? `${result.slice(0, MAX_RESULT_CHARS)}\n… [cut]` : result;
  }
  return `${result.slice(0, max)}\n… [cut here; ${result.length - max} more characters are saved in ${rel}. To see more, read_file that path with from (a line number).]`;
}

export function isFailure(result: string): boolean {
  return result.startsWith("error:") || result.startsWith("not saved:");
}
