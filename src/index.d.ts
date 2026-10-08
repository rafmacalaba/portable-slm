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
  /** Byte budget for the serialized result. Over it the result is trimmed (and reported) — never fatal. */
  maxResultBytes?: number;
  /**
   * Let an oversized result be distilled by an isolated summariser turn instead of being carried in
   * full. For disposable bulk (search snippets), not for evidence a grounded answer must be
   * recoverable from.
   */
  digest?: boolean;
  run(args: Record<string, unknown>, context: { signal: AbortSignal }): unknown | Promise<unknown>;
}

export interface ToolEvent {
  stage: "call" | "result" | "capped" | "repeat" | "failed" | "truncated" | "digested" | "refused";
  name: string;
  args?: Record<string, unknown>;
  result?: unknown;
  network?: boolean;
  /** Only for `capped`: how many surplus calls this round were ignored. */
  dropped?: number;
  /** Only for `failed`: why the tool threw. The error is handed to the model, not raised. */
  message?: string;
  /** Only for `truncated`: the budget the result was trimmed to. */
  cap?: number;
  /** Only for `digested`: bytes of raw result in, and bytes of digest out. */
  bytes?: number;
  digest?: number;
  /** Only for `refused`: the call was valid but the turn had used its tool budget. */
  reason?: string;
}

export interface AgentResult {
  text: string;
  toolRounds: number;
  messages: AgentMessage[];
  /**
   * What the turn consumed. `peakPromptTokens` is the largest prompt any round carried — the real
   * pressure on the context window, because every round re-sends the whole history while the KV cache
   * saves only the prefill *compute*. `promptTokens` is the sum across rounds (prefill work).
   */
  /**
   * Whether the reply is a finished answer, decided in code (`src/completeness.js`): a model that
   * reasons past its budget, emits the plan it was about to act on, or is cut off mid-structure
   * otherwise reaches the reader as though it had answered. `ok: false` means the text is not an
   * answer. Nothing here is a guarantee that the model finished the *task* — only that the difference
   * is visible in the result instead of silently absent.
   */
  completeness: { ok: boolean; reason: "empty" | "plan-shaped" | "truncated" | null; evidence: string | null };
  usage: {
    peakPromptTokens: number;
    promptTokens: number;
    generatedTokens: number;
    /** Oldest exchanges the window forced out of a round's prompt; the model is told in its prompt. */
    trimmed: number;
    rounds: Array<{ round: number; promptTokens: number | null; generatedTokens: number | null }>;
  };
}

export interface ModelFileSpec {
  /** Relative path within the pinned model repo, also used under a host model mirror. */
  path?: string;
  file: string;
  url: string;
  bytes: number;
  sha256: string;
}

export interface ModelSpec {
  label: string;
  format: "GGUF" | "ONNX";
  runtime?: "transformers";
  license: string;
  /** GGUF single-file source. ONNX files carry their own pinned URLs in `files`. */
  url?: string;
  file?: string;
  bytes?: number;
  sha256?: string;
  files?: ModelFileSpec[];
  repo?: string;
  revision?: string;
  dtype?: string;
  subfolder?: string;
  verified: string;
}

export interface LocalSLMOptions {
  /** Self-hosted wllama assets (required only when loading a GGUF model). */
  assets?: {
    /** @wllama/wllama esm/wasm/wllama.wasm */
    wasm: string;
    /** @wllama/wllama-compat wasm/wllama.wasm (used on Safari and browsers without JSPI) */
    compatWasm: string;
    /** @wllama/wllama-compat wasm/wllama.js */
    compatWorker: string;
  };
  /** Context window in tokens. Default 32768 (LFM2.5 native). */
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
  file?: string;
}

export interface GenerateResult {
  text: string;
  /** True when stopped through the AbortSignal; `text` holds the partial output. */
  aborted: boolean;
  engine: Engine;
  usage: { prompt_tokens: number; completion_tokens: number } | null;
  timings: { prompt_n: number; prompt_per_second: number; predicted_n: number; predicted_per_second: number } | null;
  ms: number;
  /**
   * Exchanges the context window forced out of this prompt (0 when it fitted). Non-zero means the
   * answer came from a trimmed history, which the model is told about in its own prompt.
   */
  trimmed?: number;
}

export interface LocalSLM {
  models: Record<string, ModelSpec>;
  status(id: string): Promise<Status>;
  /** Download (or resume) a pinned model. Optional HTTPS mirror(s) must match its SHA-256. */
  download(id: string, options?: {
    sources?: string[];
    /** Per-file source list for multi-part ONNX models; files are verified before becoming installed. */
    sourceForFile?: (file: ModelFileSpec) => string[];
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
      /** LFM only: streamed reasoning from the `think` block, for a collapsible trace. */
      onReasonToken?: (text: string) => void;
      /** LFM only: cumulative generated-token count, for a live tok/s readout. */
      onMetrics?: (tokens: number) => void;
      signal?: AbortSignal;
      maxTokens?: number;
      temperature?: number;
      top_p?: number;
      top_k?: number;
      seed?: number;
      response_format?: { type: "json_object" | "text" | "json_schema"; json_schema?: { name: string; strict?: boolean; schema: unknown } };
    },
  ): Promise<GenerateResult>;
  /** Model-directed, bounded tool loop. The final answer streams via onToken on streaming engines. */
  runAgent(messages: ChatMessage[], options?: {
    tools?: ToolDefinition[];
    allowNetwork?: boolean;
    /** Required to execute online tools; receives exact arguments to show to the user. */
    approveTool?: (call: { name: string; args: Record<string, unknown> }) => boolean | Promise<boolean>;
    onTool?: (event: ToolEvent) => void;
    onToken?: (text: string) => void;
    /** LFM only: streamed reasoning, for a collapsible trace. */
    onReasonToken?: (text: string) => void;
    /** LFM only: cumulative generated tokens, for a live tok/s readout. */
    onMetrics?: (tokens: number) => void;
    signal?: AbortSignal;
    /** Tool rounds allowed, 0-5. Default 5; the tighter bound is 5 executed tool calls per turn. */
    maxRounds?: number;
    /** Per-round generation budget; reasoning and the answer share it. */
    maxTokens?: number;
    sampling?: { temperature?: number; top_k?: number; seed?: number };
  }): Promise<AgentResult>;
  /** Delete one model's local cached files (unloads it first). Remote model is unaffected. */
  remove(id: string): Promise<void>;
  /** Delete all Portable SLM model files, including orphaned/legacy registry entries; does not clear app-shell caches. */
  clearModels(): Promise<number>;
  /** Unload model weights from RAM/GPU memory while retaining verified cached files. */
  unload(): Promise<void>;
}

export function createLocalSLM(options: LocalSLMOptions): LocalSLM;
export function defaultTools(options?: { fetch?: typeof fetch }): ToolDefinition[];
export function runAgent(options: {
  complete: (messages: AgentMessage[], request: { tools: unknown[]; toolChoice: string; maxTokens: number; sampling?: { temperature?: number; top_k?: number; seed?: number }; signal?: AbortSignal; onStreamToken?: (text: string) => void; onReasonToken?: (text: string) => void; onMetrics?: (tokens: number) => void; seedThink?: boolean }) => Promise<{ message: AgentMessage }>;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  allowNetwork?: boolean;
  approveTool?: (call: { name: string; args: Record<string, unknown> }) => boolean | Promise<boolean>;
  onTool?: (event: ToolEvent) => void;
  onToken?: (text: string) => void;
  /** LFM only: streamed reasoning and cumulative token count (live tok/s). */
  onReasonToken?: (text: string) => void;
  onMetrics?: (tokens: number) => void;
  signal?: AbortSignal;
  /** Tool rounds allowed, 0-5. Default 5; the tighter bound is 5 executed tool calls per turn. */
  maxRounds?: number;
  /** Per-round generation budget; reasoning and the answer share it. */
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
