// A client for MLX's server (`mlx_lm.server`), on Apple silicon: its OpenAI
// chat completions API. One server serves one model, the one it was started
// with, so requests name none. It decodes concurrent requests together
// (--decode-concurrency), where Ollama's slots mostly take turns.
//
// No num_ctx: MLX grows each request's cache as it needs. No constrained
// output either: a JSON Schema goes into the system prompt, and the reply's
// JSON is cut out of whatever surrounds it.

import { noopLogger, preview } from "../log.ts";
import type { ChatModel, Completion, CompletionRequest, Message, ToolCall } from "./model.ts";

export interface MlxOptions {
  /** A name for logs and status; the server answers with the model it loaded. */
  model: string;
  endpoint?: string;
  /** Whether a thinking model thinks before answering (the chat template's enable_thinking). */
  think?: boolean;
  /** The reply's limit when the caller sets none: the server's own default is 512 tokens. */
  maxTokens?: number;
}

export const MLX_ENDPOINT = "http://localhost:8080";
/**
 * Sampling as Ollama runs qwen3.5 (its Modelfile's parameters). MLX's server
 * samples greedily unless told: at temperature 0 without a presence penalty, a
 * small model fetches the same page twelve times over.
 */
export const SAMPLING = { temperature: 1, top_p: 0.95, top_k: 20, presence_penalty: 1.5 };
/**
 * Sampling of a reply that must be JSON: greedy. Ollama constrains such a reply
 * to its schema; MLX cannot, and the presence penalty — which punishes every
 * quote, comma and brace already written — breaks the JSON within a few lines.
 */
export const JSON_SAMPLING = { temperature: 0 };
/** Tries of a call whose connection fails. */
const ATTEMPTS = 2;

type Part = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

type MlxMessage =
  | { role: "system" | "user"; content: string | Part[] }
  | { role: "assistant"; content: string; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

interface Delta {
  content?: string | null;
  reasoning?: string;
  tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[];
}

interface Chunk {
  choices?: { delta?: Delta; message?: Delta; finish_reason?: string | null }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string } | string;
}

interface Raw {
  content: string;
  reasoning: string;
  calls: { id?: string; name: string; arguments: string }[];
  finishReason?: string;
  prompt: number;
  completion: number;
}

export class Mlx implements ChatModel {
  private readonly opts: MlxOptions & { endpoint: string; think: boolean; maxTokens: number };
  private calls = 0;

  constructor(opts: MlxOptions) {
    this.opts = { endpoint: MLX_ENDPOINT, think: false, maxTokens: 8192, ...opts };
  }

  async complete({
    messages,
    tools = [],
    maxTokens,
    signal,
    log = noopLogger,
    image,
    onProgress,
    format,
  }: CompletionRequest): Promise<Completion> {
    const body = JSON.stringify({
      messages: withSchema(messages, format).map((m) => toMlx(m, image)),
      ...(tools.length > 0 && { tools: tools.map((t) => ({ type: "function", function: t })) }),
      // Streamed, as with Ollama: Node's fetch gives up on headers after 300 s.
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: maxTokens ?? this.opts.maxTokens,
      ...(format ? JSON_SAMPLING : SAMPLING),
      chat_template_kwargs: { enable_thinking: this.opts.think },
    });

    log.debug("model request", {
      model: this.opts.model,
      messages: messages.length,
      tools: tools.length,
      request_bytes: body.length,
      last_message: preview(messages.at(-1)?.content ?? null),
    });

    let started = performance.now();
    let res: Response | undefined;
    let attempt = 1;
    // A connection that fails — the server stalled until fetch gave up, or restarted — is tried once more.
    for (; !res; attempt++) {
      started = performance.now();
      try {
        res = await fetch(`${this.opts.endpoint}/v1/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
          signal,
        });
      } catch (err) {
        if (signal?.aborted) log.debug("model call aborted", { attempt });
        else log.error("model call failed", { attempt, error: err });
        if (signal?.aborted || attempt >= ATTEMPTS) throw err;
      }
    }
    attempt--;
    const ms = Math.round(performance.now() - started);

    if (!res.ok) {
      const text = await res.text();
      log.error("model call failed", { status: res.status, attempt, duration_ms: ms, body: preview(text) });
      throw new Error(`mlx: ${res.status} ${res.statusText}: ${text.slice(0, 500)}`);
    }

    const out = this.parse(await read(res, onProgress), format !== undefined);
    log.info("model replied", {
      model: this.opts.model,
      duration_ms: ms,
      attempt,
      finish_reason: out.finishReason,
      ...(this.opts.think && { think: true }),
      tool_calls: out.message.tool_calls?.map((c) => c.function.name),
      prompt_tokens: out.usage?.prompt_tokens,
      completion_tokens: out.usage?.completion_tokens,
    });
    if (log.enabled("debug") && out.message.content) {
      log.debug("model reply content", { content: preview(out.message.content) });
    }
    return out;
  }

  private parse(raw: Raw, json: boolean): Completion {
    const calls = raw.calls.map(
      (c): ToolCall => ({
        id: c.id || `call_${(++this.calls).toString(36)}_${Date.now().toString(36)}`,
        type: "function",
        function: { name: c.name, arguments: c.arguments || "{}" },
      }),
    );
    const content = json ? jsonIn(raw.content) : raw.content;
    return {
      message: {
        role: "assistant",
        content: content || null,
        ...(raw.reasoning && { thinking: raw.reasoning }),
        ...(calls.length && { tool_calls: calls }),
      },
      usage: {
        prompt_tokens: raw.prompt,
        completion_tokens: raw.completion,
        total_tokens: raw.prompt + raw.completion,
      },
      finishReason: calls.length ? "tool_calls" : raw.finishReason,
    };
  }
}

/**
 * One reply from a streamed body: server-sent events, each a chunk with a
 * piece of the text, the reasoning or a tool call (whole, or its arguments in
 * pieces under one index), the last with the counts. A non-streamed body, one
 * JSON object, is read the same way.
 */
async function read(res: Response, onProgress?: CompletionRequest["onProgress"]): Promise<Raw> {
  const out: Raw = { content: "", reasoning: "", calls: [], prompt: 0, completion: 0 };
  const byIndex = new Map<number, Raw["calls"][number]>();
  let choices = 0;
  const add = (line: string) => {
    const data = line.startsWith("data:") ? line.slice(5).trim() : line.trim();
    if (!data || data === "[DONE]" || line.startsWith(":")) return;
    const chunk = JSON.parse(data) as Chunk;
    if (chunk.error) throw new Error(`mlx: ${typeof chunk.error === "string" ? chunk.error : chunk.error.message}`);
    for (const choice of chunk.choices ?? []) {
      choices++;
      const d = choice.delta ?? choice.message ?? {};
      if (d.content) out.content += d.content;
      if (d.reasoning) out.reasoning += d.reasoning;
      for (const [i, c] of (d.tool_calls ?? []).entries()) {
        const index = c.index ?? out.calls.length + i;
        let call = byIndex.get(index);
        if (!call) {
          call = { name: "", arguments: "" };
          byIndex.set(index, call);
          out.calls.push(call);
        }
        if (c.id) call.id = c.id;
        if (c.function?.name) call.name += c.function.name;
        if (c.function?.arguments) call.arguments += c.function.arguments;
      }
      if (choice.finish_reason) out.finishReason = choice.finish_reason;
    }
    if (chunk.usage) {
      out.prompt = chunk.usage.prompt_tokens ?? out.prompt;
      out.completion = chunk.usage.completion_tokens ?? out.completion;
    }
  };
  const decoder = new TextDecoder();
  let rest = "";
  for await (const piece of (res.body ?? []) as AsyncIterable<Uint8Array>) {
    rest += decoder.decode(piece, { stream: true });
    const lines = rest.split("\n");
    rest = lines.pop() ?? "";
    for (const line of lines) add(line);
    onProgress?.({ thinking: out.reasoning, content: out.content });
  }
  add(rest + decoder.decode());
  // A server whose generation died mid-reply ends the stream with nothing in it.
  if (!choices) throw new Error("mlx: the reply ended before it began");
  return out;
}

/** The messages, with the schema a reply must match told in the system prompt. */
function withSchema(messages: Message[], format?: Record<string, unknown>): Message[] {
  if (!format) return messages;
  const rule = `Reply with only JSON that matches this JSON Schema, and nothing else:\n${JSON.stringify(format)}`;
  const [first, ...rest] = messages;
  if (first?.role === "system") return [{ ...first, content: `${first.content}\n\n${rule}` }, ...rest];
  return [{ role: "system", content: rule }, ...messages];
}

/** The JSON in a reply: the text itself, or what sits between fences or the outer brackets. */
export function jsonIn(text: string): string {
  const candidates = [text.trim()];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  if (fenced?.[1]) candidates.push(fenced[1].trim());
  const start = text.search(/[[{]/);
  const end = Math.max(text.lastIndexOf("}"), text.lastIndexOf("]"));
  if (start >= 0 && end > start) candidates.push(text.slice(start, end + 1));
  for (const c of candidates) {
    try {
      JSON.parse(c);
      return c;
    } catch {}
  }
  return text;
}

function toMlx(m: Message, image?: (path: string) => string | undefined): MlxMessage {
  switch (m.role) {
    case "tool":
      return { role: "tool", tool_call_id: m.tool_call_id, content: m.content };
    case "assistant":
      return {
        role: "assistant",
        content: m.content ?? "",
        ...(m.tool_calls?.length && { tool_calls: m.tool_calls }),
      };
    default: {
      if (!m.images?.length) return { role: m.role, content: m.content };
      // Images go as data URLs; one deleted since is named in the text instead.
      const data = m.images.map((p) => image?.(p));
      const gone = m.images.filter((_, i) => data[i] === undefined);
      const text = gone.length ? `${m.content}\n[five: no longer in the workspace: ${gone.join(", ")}]` : m.content;
      return {
        role: m.role,
        content: [
          { type: "text", text },
          ...data
            .filter((d): d is string => d !== undefined)
            .map((d): Part => ({ type: "image_url", image_url: { url: `data:image/png;base64,${d}` } })),
        ],
      };
    }
  }
}
