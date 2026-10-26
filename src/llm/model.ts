// What the loop needs from a model: messages, function tools, one reply.
// The shape is the chat completions one (as in seven); Ollama's client converts
// to and from its own.

import type { Message } from "../api/types.ts";
import type { Logger } from "../log.ts";

export type { Message, ToolCall } from "../api/types.ts";

export interface ToolDef {
  name: string;
  description: string;
  /** JSON Schema for the arguments object. */
  parameters: Record<string, unknown>;
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface Completion {
  message: Extract<Message, { role: "assistant" }>;
  usage?: Usage;
  finishReason?: string;
}

export interface CompletionRequest {
  messages: Message[];
  tools?: ToolDef[];
  maxTokens?: number;
  signal?: AbortSignal;
  /** The caller's logger (its turn and step), for this call's lines. */
  log?: Logger;
  /** A message's image, by its workspace path, as base64; undefined when it is gone. */
  image?: (path: string) => string | undefined;
  /** The reply so far, as it streams in: its thinking and its text. */
  onProgress?: (so: { thinking: string; content: string }) => void;
}

export interface ChatModel {
  complete(req: CompletionRequest): Promise<Completion>;
}
