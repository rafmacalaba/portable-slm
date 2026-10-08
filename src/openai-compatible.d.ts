import type { ChatMessage, LocalSLM } from "./index.d.ts";

type ResponseFormat = NonNullable<Parameters<LocalSLM["generate"]>[1]>["response_format"];

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  /** Completion cap is also bounded by the loaded model's context window. */
  max_tokens?: number;
  max_completion_tokens?: number;
  temperature?: number;
  top_p?: number;
  seed?: number;
  response_format?: ResponseFormat;
  stream?: boolean;
}

export interface ChatCompletionCallOptions {
  signal?: AbortSignal;
}

export interface ChatCompletionUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface ChatCompletion {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: Array<{
    index: 0;
    message: { role: "assistant"; content: string };
    finish_reason: "stop";
  }>;
  usage?: ChatCompletionUsage;
}

export interface ChatCompletionChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: Array<{
    index: 0;
    delta: { role?: "assistant"; content?: string };
    finish_reason: "stop" | null;
  }>;
  usage?: ChatCompletionUsage;
}

export interface OpenAICompatibleClient {
  chat: {
    completions: {
      create(request: ChatCompletionRequest & { stream: true }, options?: ChatCompletionCallOptions): AsyncIterable<ChatCompletionChunk>;
      create(request: ChatCompletionRequest & { stream?: false }, options?: ChatCompletionCallOptions): Promise<ChatCompletion>;
      create(request: ChatCompletionRequest, options?: ChatCompletionCallOptions): Promise<ChatCompletion> | AsyncIterable<ChatCompletionChunk>;
    };
  };
}

/** In-process OpenAI-shaped chat facade; not an HTTP client or server. */
export function createOpenAICompatibleClient(ai: Pick<LocalSLM, "models" | "load" | "generate">): OpenAICompatibleClient;
