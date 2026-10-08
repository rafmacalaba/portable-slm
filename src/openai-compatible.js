import { DEFAULTS } from "./models.js";

const REQUEST_KEYS = new Set([
  "model", "messages", "stream", "max_tokens", "max_completion_tokens",
  "temperature", "top_p", "seed", "response_format",
]);

function parseRequest(ai, request, { signal } = {}) {
  if (!request || typeof request !== "object" || Array.isArray(request)) throw new Error("request must be an object");
  for (const key of Object.keys(request)) {
    if (!REQUEST_KEYS.has(key)) throw new Error(`Unsupported chat option: ${key}`);
  }
  const { model, messages, stream = false } = request;
  if (typeof model !== "string" || !Object.hasOwn(ai.models, model)) throw new Error(`Unknown model: ${model}`);
  if (typeof stream !== "boolean") throw new Error("stream must be a boolean");
  if (!Array.isArray(messages) || messages.length === 0) throw new Error("messages must be a non-empty array");
  const safeMessages = messages.map((message) => {
    if (!message || !["system", "user", "assistant"].includes(message.role) || typeof message.content !== "string") {
      throw new Error("Only system, user and assistant messages with text content are supported");
    }
    if (Object.keys(message).some((key) => key !== "role" && key !== "content")) {
      throw new Error("Only role and content message fields are supported");
    }
    return { role: message.role, content: message.content };
  });
  if (request.max_tokens !== undefined && request.max_completion_tokens !== undefined) {
    throw new Error("Set max_tokens or max_completion_tokens, not both");
  }
  const maxTokens = request.max_completion_tokens ?? request.max_tokens ?? DEFAULTS.maxTokens;
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1) throw new Error("max_tokens must be a positive safe integer");
  if (request.temperature !== undefined && (!Number.isFinite(request.temperature) || request.temperature < 0 || request.temperature > 2)) {
    throw new Error("temperature must be between 0 and 2");
  }
  if (request.top_p !== undefined && (!Number.isFinite(request.top_p) || request.top_p < 0 || request.top_p > 1)) {
    throw new Error("top_p must be between 0 and 1");
  }
  if (request.seed !== undefined && !Number.isSafeInteger(request.seed)) throw new Error("seed must be a safe integer");
  const generation = { maxTokens, signal };
  for (const key of ["temperature", "top_p", "seed", "response_format"]) {
    if (request[key] !== undefined) generation[key] = request[key];
  }
  return { model, messages: safeMessages, generation, stream };
}

function completionId() {
  return `chatcmpl-${globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}`;
}

function usageOf(result) {
  if (!result.usage) return undefined;
  const { prompt_tokens, completion_tokens } = result.usage;
  return { prompt_tokens, completion_tokens, total_tokens: prompt_tokens + completion_tokens };
}

function completionChunk(id, created, model, delta, finishReason = null, usage) {
  return {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...(usage ? { usage } : {}),
  };
}

async function complete(ai, parsed) {
  parsed.generation.signal?.throwIfAborted();
  await ai.load(parsed.model);
  parsed.generation.signal?.throwIfAborted();
  const result = await ai.generate(parsed.messages, parsed.generation);
  const usage = usageOf(result);
  return {
    id: completionId(),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: parsed.model,
    choices: [{ index: 0, message: { role: "assistant", content: result.text }, finish_reason: "stop" }],
    ...(usage ? { usage } : {}),
  };
}

async function* streamCompletion(ai, parsed, signal) {
  signal?.throwIfAborted();
  await ai.load(parsed.model);
  signal?.throwIfAborted();
  const id = completionId();
  const created = Math.floor(Date.now() / 1000);
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener("abort", abort, { once: true });

  let queue = [];
  let settled = false;
  let failure;
  let result;
  let wake;
  const notify = () => { wake?.(); wake = undefined; };
  try {
    yield completionChunk(id, created, parsed.model, { role: "assistant" });
    const generation = Promise.resolve().then(() => ai.generate(parsed.messages, {
      ...parsed.generation,
      signal: controller.signal,
      onToken: (text) => { queue.push(text); notify(); },
    })).then(
      (value) => { result = value; settled = true; notify(); },
      (error) => { failure = error; settled = true; notify(); },
    );
    while (queue.length || !settled) {
      if (queue.length) {
        yield completionChunk(id, created, parsed.model, { content: queue.shift() });
      } else {
        await new Promise((resolve) => { wake = resolve; });
      }
    }
    await generation;
    if (failure) throw failure;
    yield completionChunk(id, created, parsed.model, {}, "stop", usageOf(result));
  } finally {
    if (!settled) controller.abort();
    signal?.removeEventListener("abort", abort);
  }
}

/** OpenAI-shaped, in-process chat API. It creates no HTTP endpoint or network request. */
export function createOpenAICompatibleClient(ai) {
  if (!ai?.models || typeof ai.load !== "function" || typeof ai.generate !== "function") {
    throw new Error("Expected a LocalSLM instance");
  }
  return {
    chat: {
      completions: {
        create(request, options) {
          const parsed = parseRequest(ai, request, options);
          return parsed.stream ? streamCompletion(ai, parsed, options?.signal) : complete(ai, parsed);
        },
      },
    },
  };
}
