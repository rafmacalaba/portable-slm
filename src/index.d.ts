export type Engine = "webgpu" | "cpu";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export type AgentMessage = ChatMessage |
  { role: "assistant"; content: string | null; tool_calls: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> } |
  { role: "tool"; content: string; tool_call_id: string };

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, { type: "string" | "number" | "boolean"; description?: string; enum?: Array<string | number | boolean> }>;
    required?: string[];
  };
  /** True if execution can make a network request. Hidden from model unless allowNetwork=true. */
  network: boolean;
  run(args: Record<string, unknown>, context: { signal: AbortSignal }): unknown | Promise<unknown>;
}

export interface ToolEvent {
  stage: "call" | "result";
  name: string;
  args?: Record<string, unknown>;
  result?: unknown;
  network?: boolean;
}

export interface AgentResult {
  text: string;
  toolRounds: number;
  messages: AgentMessage[];
}

export interface ModelSpec {
  label: string;
  format: "GGUF";
  license: string;
  url: string;
  file: string;
  bytes: number;
  sha256: string;
  verified: string;
}

export interface LocalSLMOptions {
  /** Self-hosted wllama assets (required: the app must work offline). */
  assets: {
    /** @wllama/wllama esm/wasm/wllama.wasm */
    wasm: string;
    /** @wllama/wllama-compat wasm/wllama.wasm (used on Safari and browsers without JSPI) */
    compatWasm: string;
    /** @wllama/wllama-compat wasm/wllama.js */
    compatWorker: string;
  };
  /** Context window in tokens. Default 8192. */
  ctx?: number;
}

export interface Status {
  model: string;
  /** installed = all chunks stored and sha256-verified; partial = interrupted download/import. */
  state: "installed" | "partial" | "missing";
  loaded: boolean;
  engine: Engine | null;
  webgpu: boolean;
  crossOriginIsolated: boolean;
  online: boolean;
}

export interface Progress {
  phase: "download" | "import" | "verify";
  done: number;
  total: number;
}

export interface GenerateResult {
  text: string;
  /** True when stopped through the AbortSignal; `text` holds the partial output. */
  aborted: boolean;
  engine: Engine;
  usage: { prompt_tokens: number; completion_tokens: number } | null;
  timings: { prompt_n: number; prompt_per_second: number; predicted_n: number; predicted_per_second: number } | null;
  ms: number;
}

export interface LocalSLM {
  models: Record<string, ModelSpec>;
  status(id: string): Promise<Status>;
  /** Download (or resume) a pinned model. Optional HTTPS mirror(s) must match its SHA-256. */
  download(id: string, options?: {
    sources?: string[];
    onProgress?: (p: Progress) => void;
    onRetry?: (r: { chunk: number; total: number; attempt: number; maxAttempts: number; reason: string }) => void;
    /** Called when host ignores byte ranges; full response is streamed in bounded chunks. */
    onFallback?: (r: { chunk: number; total: number }) => void;
    signal?: AbortSignal;
  }): Promise<void>;
  /** Import a model file picked by the user (USB, SD card, Files). Resolves with the model id. */
  importModel(file: File, options?: { onProgress?: (p: Progress) => void }): Promise<string>;
  /** Load an installed model. "auto" = CPU on iOS, otherwise WebGPU when available, with CPU fallback. */
  load(id: string, options?: { engine?: "auto" | Engine }): Promise<{ engine: Engine }>;
  generate(
    messages: ChatMessage[],
    options?: {
      onToken?: (text: string) => void;
      signal?: AbortSignal;
      maxTokens?: number;
      temperature?: number;
      top_k?: number;
      seed?: number;
      response_format?: { type: "json_object" | "text" | "json_schema"; json_schema?: { name: string; strict?: boolean; schema: unknown } };
    },
  ): Promise<GenerateResult>;
  /** Model-directed, bounded tool loop. First model step is not streamed; final text is sent to onToken. */
  runAgent(messages: ChatMessage[], options?: {
    tools?: ToolDefinition[];
    allowNetwork?: boolean;
    /** Required to execute online tools; receives exact arguments to show to the user. */
    approveTool?: (call: { name: string; args: Record<string, unknown> }) => boolean | Promise<boolean>;
    onTool?: (event: ToolEvent) => void;
    onToken?: (text: string) => void;
    signal?: AbortSignal;
    maxRounds?: number;
    maxTokens?: number;
    sampling?: { temperature?: number; top_k?: number; seed?: number };
  }): Promise<AgentResult>;
  /** Delete a model from storage (unloads it first). */
  remove(id: string): Promise<void>;
  unload(): Promise<void>;
}

export function createLocalSLM(options: LocalSLMOptions): LocalSLM;
export function defaultTools(options?: { fetch?: typeof fetch }): ToolDefinition[];
export function runAgent(options: {
  complete: (messages: AgentMessage[], request: { tools: unknown[]; toolChoice: string; maxTokens: number; sampling?: { temperature?: number; top_k?: number; seed?: number }; signal?: AbortSignal }) => Promise<{ message: AgentMessage }>;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  allowNetwork?: boolean;
  approveTool?: (call: { name: string; args: Record<string, unknown> }) => boolean | Promise<boolean>;
  onTool?: (event: ToolEvent) => void;
  onToken?: (text: string) => void;
  signal?: AbortSignal;
  maxRounds?: number;
  maxTokens?: number;
  sampling?: { temperature?: number; top_k?: number; seed?: number };
}): Promise<AgentResult>;

export const MODELS: Record<string, ModelSpec>;
export const DEFAULTS: {
  ctx: number;
  maxTokens: number;
  sampling: Record<string, number>;
  license: string;
};
