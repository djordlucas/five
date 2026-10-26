// A client for Ollama's native chat API (/api/chat), for models served on
// this machine or the local network. The native API, not Ollama's
// OpenAI-compatible one, because only it takes the context window (num_ctx):
// without it Ollama uses a few thousand tokens and silently drops the start of
// longer conversations.

import { noopLogger, preview } from "../log.ts";
import type { ChatModel, Completion, CompletionRequest, Message, ToolCall } from "./model.ts";

export interface OllamaOptions {
  model: string;
  endpoint?: string;
  /** The context window to load the model with (num_ctx), in tokens. */
  contextTokens: number;
  /** How long Ollama keeps the model loaded after a call (keep_alive), e.g. "5m". */
  keepAlive?: string;
  /** Whether a thinking model thinks before answering. A model without the capability is never asked. */
  think?: boolean;
}

export const OLLAMA_ENDPOINT = "http://localhost:11434";

type OllamaMessage =
  | { role: "system" | "user" | "assistant"; content: string; tool_calls?: OllamaToolCall[]; images?: string[] }
  | { role: "tool"; content: string; tool_name: string };

interface OllamaToolCall {
  id?: string;
  function: { name: string; arguments: Record<string, unknown> | string };
}

interface RawChat {
  message?: { content?: string; thinking?: string; tool_calls?: OllamaToolCall[] };
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
}

export class Ollama implements ChatModel {
  private readonly opts: OllamaOptions & { endpoint: string; think: boolean };
  private calls = 0;
  private thinking?: Promise<boolean>;

  constructor(opts: OllamaOptions) {
    this.opts = { endpoint: OLLAMA_ENDPOINT, think: false, ...opts };
  }

  /** Whether the model can think, from Ollama's capabilities for it; asked once. */
  canThink(): Promise<boolean> {
    this.thinking ??= fetch(`${this.opts.endpoint}/api/show`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: this.opts.model }),
    })
      .then(async (res) => (res.ok ? ((await res.json()) as { capabilities?: string[] }) : {}))
      .then((info) => info.capabilities?.includes("thinking") ?? false)
      .catch(() => false);
    return this.thinking;
  }

  async complete({
    messages,
    tools = [],
    maxTokens,
    signal,
    log = noopLogger,
    image,
    onProgress,
  }: CompletionRequest): Promise<Completion> {
    const think = (await this.canThink()) ? this.opts.think : undefined;
    const body = JSON.stringify({
      model: this.opts.model,
      messages: messages.map((m) => toOllama(m, image)),
      ...(tools.length > 0 && { tools: tools.map((t) => ({ type: "function", function: t })) }),
      // Streamed: a non-streamed reply sends nothing until it is complete, and
      // Node's fetch gives up on a response whose headers take over 300 s —
      // a long generation on a busy local model. Chunks keep it alive.
      stream: true,
      ...(think !== undefined && { think }),
      options: { num_ctx: this.opts.contextTokens, ...(maxTokens && { num_predict: maxTokens }) },
      ...(this.opts.keepAlive && { keep_alive: this.opts.keepAlive }),
    });

    log.debug("model request", {
      model: this.opts.model,
      messages: messages.length,
      tools: tools.length,
      request_bytes: body.length,
      last_message: preview(messages.at(-1)?.content ?? null),
    });

    const started = performance.now();
    let res: Response;
    try {
      res = await fetch(`${this.opts.endpoint}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        signal,
      });
    } catch (err) {
      if (signal?.aborted) log.debug("model call aborted", { attempt: 1 });
      else log.error("model call failed", { attempt: 1, error: err });
      throw err;
    }
    const ms = Math.round(performance.now() - started);

    if (!res.ok) {
      const text = await res.text();
      log.error("model call failed", { status: res.status, attempt: 1, duration_ms: ms, body: preview(text) });
      throw new Error(`ollama: ${res.status} ${res.statusText}: ${text.slice(0, 500)}`);
    }

    const out = this.parse(await read(res, onProgress));
    log.info("model replied", {
      model: this.opts.model,
      duration_ms: ms,
      attempt: 1,
      finish_reason: out.finishReason,
      ...(think && { think }),
      tool_calls: out.message.tool_calls?.map((c) => c.function.name),
      prompt_tokens: out.usage?.prompt_tokens,
      completion_tokens: out.usage?.completion_tokens,
    });
    if (log.enabled("debug") && out.message.content) {
      log.debug("model reply content", { content: preview(out.message.content) });
    }
    // Ollama truncates a prompt longer than num_ctx instead of failing; a full
    // window means the start of the conversation was probably dropped.
    if (out.usage && out.usage.prompt_tokens >= this.opts.contextTokens) {
      log.warn("model context full", {
        prompt_tokens: out.usage.prompt_tokens,
        context_tokens: this.opts.contextTokens,
      });
    }
    return out;
  }

  private parse(raw: RawChat): Completion {
    if (!raw.message) throw new Error(`ollama: reply has no message: ${JSON.stringify(raw).slice(0, 500)}`);
    const { content, thinking, tool_calls } = raw.message;
    // Ollama does not always give tool calls an id; the UI pairs each tool
    // result with its call by id, so make one up.
    const calls = tool_calls?.map(
      (c): ToolCall => ({
        id: c.id || `call_${(++this.calls).toString(36)}_${Date.now().toString(36)}`,
        type: "function",
        function: {
          name: c.function.name,
          arguments:
            typeof c.function.arguments === "string" ? c.function.arguments : JSON.stringify(c.function.arguments),
        },
      }),
    );
    const prompt = raw.prompt_eval_count ?? 0;
    const completion = raw.eval_count ?? 0;
    return {
      message: {
        role: "assistant",
        content: content || null,
        ...(thinking && { thinking }),
        ...(calls?.length && { tool_calls: calls }),
      },
      usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion },
      finishReason: calls?.length ? "tool_calls" : raw.done_reason,
    };
  }
}

/**
 * One reply from a streamed body, read as it arrives: NDJSON chunks, each with
 * a piece of the content and perhaps tool calls, the last with the counts.
 * `onProgress` gets the thinking and text so far after each piece. A body that
 * is a single JSON object (a non-streamed reply) is read the same way.
 */
async function read(res: Response, onProgress?: CompletionRequest["onProgress"]): Promise<RawChat> {
  const out: RawChat = { message: { content: "", thinking: "", tool_calls: [] } };
  const m = out.message as { content: string; thinking: string; tool_calls: OllamaToolCall[] };
  const add = (line: string) => {
    if (!line.trim()) return;
    const chunk = JSON.parse(line) as RawChat & { error?: string };
    if (chunk.error) throw new Error(`ollama: ${chunk.error}`);
    if (chunk.message?.content) m.content += chunk.message.content;
    if (chunk.message?.thinking) m.thinking += chunk.message.thinking;
    if (chunk.message?.tool_calls?.length) m.tool_calls.push(...chunk.message.tool_calls);
    if (chunk.done_reason) out.done_reason = chunk.done_reason;
    if (chunk.prompt_eval_count !== undefined) out.prompt_eval_count = chunk.prompt_eval_count;
    if (chunk.eval_count !== undefined) out.eval_count = chunk.eval_count;
  };
  const decoder = new TextDecoder();
  let rest = "";
  for await (const piece of (res.body ?? []) as AsyncIterable<Uint8Array>) {
    rest += decoder.decode(piece, { stream: true });
    const lines = rest.split("\n");
    rest = lines.pop() ?? "";
    for (const line of lines) add(line);
    onProgress?.({ thinking: m.thinking, content: m.content });
  }
  add(rest + decoder.decode());
  return out;
}

function toOllama(m: Message, image?: (path: string) => string | undefined): OllamaMessage {
  switch (m.role) {
    case "tool":
      return { role: "tool", content: m.content, tool_name: m.name };
    case "assistant":
      return {
        role: "assistant",
        content: m.content ?? "",
        ...(m.tool_calls?.length && {
          tool_calls: m.tool_calls.map((c) => ({
            function: { name: c.function.name, arguments: parseArgs(c.function.arguments) },
          })),
        }),
      };
    default: {
      if (!m.images?.length) return { role: m.role, content: m.content };
      // Images go as base64; one deleted since is named in the text instead.
      const data = m.images.map((p) => image?.(p));
      const gone = m.images.filter((_, i) => data[i] === undefined);
      return {
        role: m.role,
        content: gone.length ? `${m.content}\n[five: no longer in the workspace: ${gone.join(", ")}]` : m.content,
        images: data.filter((d): d is string => d !== undefined),
      };
    }
  }
}

/** Ollama takes a call's arguments as an object; the conversation stores them as JSON text. */
function parseArgs(text: string): Record<string, unknown> {
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}
