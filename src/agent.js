// Agent loop is independent of wllama, DOM, and any particular consuming application.
// `complete` is a trusted model adapter; `tools` are trusted host-provided functions. Model
// output and web search results are untrusted. Only declared, validated, permitted tools run.

function checkArgs(raw, schema) {
  const args = JSON.parse(raw);
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Tool arguments must be a JSON object");
  const properties = schema.properties ?? {};
  for (const key of schema.required ?? []) {
    if (!Object.hasOwn(args, key)) throw new Error(`Missing tool argument: ${key}`);
  }
  for (const [key, value] of Object.entries(args)) {
    const rule = properties[key];
    if (!rule) throw new Error(`Unexpected tool argument: ${key}`);
    if (rule.type === "string" && (typeof value !== "string" || value.length > 500)) throw new Error(`Invalid string: ${key}`);
    if (rule.type === "number" && (typeof value !== "number" || !Number.isFinite(value))) throw new Error(`Invalid number: ${key}`);
    if (rule.type === "boolean" && typeof value !== "boolean") throw new Error(`Invalid boolean: ${key}`);
    if (!["string", "number", "boolean"].includes(rule.type)) throw new Error(`Unsupported argument type: ${key}`);
    if (rule.enum && !rule.enum.includes(value)) throw new Error(`Invalid value: ${key}`);
  }
  return args;
}

export async function runAgent({ complete, messages, tools = [], allowNetwork = false, approveTool, sampling, signal, onTool, onToken, maxRounds = 2, maxTokens = 192 }) {
  if (!Array.isArray(messages) || !messages.length) throw new Error("messages must be a non-empty array");
  if (!Number.isInteger(maxRounds) || maxRounds < 0 || maxRounds > 3) throw new Error("maxRounds must be between 0 and 3");
  if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 512) throw new Error("maxTokens must be between 1 and 512");
  const allowed = tools.filter((t) => !t.network || allowNetwork);
  const byName = new Map();
  for (const tool of allowed) {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(tool.name) || byName.has(tool.name) || tool.parameters?.type !== "object" || typeof tool.run !== "function") {
      throw new Error("Invalid tool definition");
    }
    byName.set(tool.name, tool);
  }
  const history = messages.map((m) => ({ ...m }));
  for (let round = 0; round <= maxRounds; round++) {
    signal?.throwIfAborted();
    const toolSpecs = round === maxRounds ? [] : allowed.map(({ name, description, parameters }) => ({
      type: "function", function: { name, description, parameters },
    }));
    const choice = await complete(history, { tools: toolSpecs, toolChoice: toolSpecs.length ? "auto" : "none", maxTokens, sampling, signal });
    const calls = choice.message?.tool_calls ?? [];
    if (!calls.length) {
      const text = choice.message?.content ?? "";
      onToken?.(text); // Agent steps are non-streaming; plain generate() still streams tokens.
      return { text, messages: history, toolRounds: round };
    }
    if (round === maxRounds) throw new Error("Model requested a tool after tool round limit");
    if (calls.length > 2) throw new Error("Too many tool calls in one round");
    history.push(choice.message);
    for (const call of calls) {
      signal?.throwIfAborted();
      const name = call.function?.name;
      const tool = byName.get(name);
      if (!tool) throw new Error(`Tool not permitted: ${name}`);
      let args;
      try { args = checkArgs(call.function.arguments, tool.parameters); }
      catch (err) { throw new Error(`Invalid arguments for ${name}: ${err.message}`, { cause: err }); }
      onTool?.({ stage: "call", name, args, network: Boolean(tool.network) });
      // Untrusted page/model text can smuggle private data into a search query. Online tools
      // require approval of the exact arguments even after the user enables online mode.
      if (tool.network && !(await approveTool?.({ name, args }))) throw new Error(`Online tool ${name} was not approved`);
      // Timeout aborts fetch-based tools; Promise.race also bounds tools that ignore AbortSignal.
      const controller = new AbortController();
      let onAbort;
      const interrupted = new Promise((_, reject) => {
        onAbort = () => { controller.abort(); reject(new DOMException("Aborted", "AbortError")); };
        signal?.addEventListener("abort", onAbort, { once: true });
      });
      let timer;
      try {
        signal?.throwIfAborted();
        const timeout = new Promise((_, reject) => {
          timer = setTimeout(() => { controller.abort(); reject(new Error(`${name} timed out`)); }, 10000);
        });
        const result = await Promise.race([tool.run(args, { signal: controller.signal }), timeout, interrupted]);
        const content = JSON.stringify(result);
        if (!content || content.length > 2048) throw new Error(`${name} returned too much data`);
        onTool?.({ stage: "result", name, result });
        history.push({ role: "tool", tool_call_id: call.id, content });
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      }
    }
  }
  throw new Error("Tool loop failed to finish");
}
