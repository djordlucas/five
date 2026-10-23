// Tool calls written as text. Smaller models (llama3.1, phi, some qwen
// quantisations) often reply with the call as JSON in the message text —
// `{"name": "set_next_prompt", "parameters": {"text": "…"}}`, sometimes in a code fence,
// `<tool_call>` tags or after llama's `<|python_tag|>` — instead of as a tool
// call. When the text is nothing but such calls to tools the agent has, they
// are taken as its tool calls.

import { randomUUID } from "node:crypto";
import { parseLenient } from "../agent/args.ts";
import type { ToolCall } from "../llm/model.ts";

interface TextCall {
  name?: unknown;
  parameters?: unknown;
  arguments?: unknown;
}

/**
 * The tool calls in `text`, or undefined when it has none. A reply that is
 * only calls (one, an array, or several in `<tool_call>` tags) gives them all.
 * Otherwise the first JSON object in the text that is a call is taken, alone:
 * a model that writes out a plan of calls ("First … Then …") usually means
 * later ones to use earlier results, which it sees on its next step.
 * `tools` are the names offered; a call to any other name is not a call.
 */
export function recoverToolCalls(raw: string, tools: Set<string>): ToolCall[] | undefined {
  // `{"name": "f", {"a": 1}}`: the arguments without their key.
  const text = raw.replace(/("name"\s*:\s*"[^"]+"\s*,\s*)\{/g, '$1"parameters": {');
  const body = unwrap(text);
  const whole = body.startsWith("{") || body.startsWith("[") ? parseCalls(body) : undefined;
  const all = whole?.map((c) => toCall(c, tools));
  if (all?.length && all.every((c) => c !== undefined)) return all as ToolCall[];
  for (const candidate of jsonObjects(text)) {
    const call = toCall(candidate, tools);
    if (call) return [call];
  }
  return undefined;
}

function toCall(c: TextCall | undefined, tools: Set<string>): ToolCall | undefined {
  if (!c || typeof c !== "object" || typeof c.name !== "string") return undefined;
  let args: unknown = c.parameters ?? c.arguments ?? {};
  if (typeof args === "string") {
    try {
      args = parseLenient(args);
    } catch {
      return undefined;
    }
  }
  if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
  const name = c.name;
  if (!tools.has(name)) return undefined;
  return {
    id: `text_${randomUUID().slice(0, 8)}`,
    type: "function",
    function: { name, arguments: JSON.stringify(args) },
  };
}

/**
 * Every top-level JSON object in `text`, in order, parsed. An object cut off
 * at the end of the text, or missing its last closing braces, is completed.
 */
function* jsonObjects(text: string): Generator<TextCall> {
  for (let i = text.indexOf("{"); i >= 0; i = text.indexOf("{", i + 1)) {
    let depth = 0;
    let inString = false;
    let end = -1;
    for (let j = i; j < text.length; j++) {
      const ch = text[j];
      if (inString) {
        if (ch === "\\") j++;
        else if (ch === '"') inString = false;
      } else if (ch === '"') inString = true;
      else if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) {
        end = j;
        break;
      }
    }
    const candidate = end >= 0 ? text.slice(i, end + 1) : text.slice(i);
    try {
      const v = parseLenient(candidate);
      if (v && typeof v === "object" && !Array.isArray(v)) {
        yield v;
        if (end >= 0) i = end;
      }
    } catch {
      // not JSON from here; try the next brace
    }
    if (end < 0) return;
  }
}
/** The text without a code fence, `<tool_call>` tags or a `<|python_tag|>` prefix around it. */
function unwrap(text: string): string {
  let t = text
    .trim()
    .replace(/^<\|python_tag\|>/, "")
    // A stray brace left over from a call the model began earlier.
    .replace(/^\}\s*(?=\{)/, "")
    .trim();
  const fence = /^```(?:json|javascript|js)?\s*\n?([\s\S]*?)\n?```$/.exec(t);
  if (fence?.[1] !== undefined) t = fence[1].trim();
  const tags = [...t.matchAll(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g)];
  if (tags.length > 0 && t.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "").trim() === "") {
    t = `[${tags.map((m) => m[1]).join(",")}]`;
  }
  return t;
}

/** One call, an array of calls, or calls separated by `;` or newlines. */
function parseCalls(body: string): TextCall[] | undefined {
  try {
    const v = parseLenient(body);
    return Array.isArray(v) ? (v as TextCall[]) : [v as TextCall];
  } catch {
    // Several objects one after another.
    const parts = body.split(/\}\s*[;\n]\s*\{/);
    if (parts.length < 2) return undefined;
    try {
      return parts.map((p, i) => parseLenient(`${i > 0 ? "{" : ""}${p}${i < parts.length - 1 ? "}" : ""}`) as TextCall);
    } catch {
      return undefined;
    }
  }
}
