// pslm-host/1 manifest and context rules, kept free of runtime imports so hosts and tests
// can validate a manifest without loading the inference engine.
export const HOST_API_VERSION = "pslm-host/1";

// The task ids this SDK implements. Hosts only allowlist these; adding a task is a portable-slm
// change, never a host change. `source` in the helpers says *whose* metadata is being read —
// the task id says *what operation* runs, and is what the manifest allowlist and the result
// envelope name.
export const TASKS = ["pslm.chat", "pslm.suggest-field", "pslm.suggest-datafile-description"];

/** A manifest that omits `tasks` gets every task this SDK ships (L1 default). */
export function allowsTask(manifest, task) {
  const allowed = manifest?.tasks ?? TASKS;
  return allowed.includes(task);
}

export function validateManifest(manifest) {
  if (!manifest || typeof manifest !== "object") throw new Error("Host manifest is missing");
  if (manifest.apiVersion !== HOST_API_VERSION) {
    throw new Error(`This page targets ${HOST_API_VERSION}; manifest says ${manifest.apiVersion || "none"}`);
  }
  if (manifest.writeBack === true) throw new Error("Manifest asks for writeBack; pslm-host/1 is read-only");
  // A manifest has to declare *something* the assistant may read, otherwise it is a config file that
  // changes nothing. Either source is enough on its own: `record` for a page about one object, `app`
  // for a page that is not.
  if (!manifest.context?.record?.url && !manifest.context?.app?.url) {
    throw new Error("Manifest declares no context source; set context.record.url, context.app.url, or both");
  }
  // What kind of thing `context.app` is. The SDK's app-mode instruction was written for help text about
  // *using* an application, and it tells the model to fall back to general guidance; a host whose document
  // is content to answer questions *about* was fighting its own system prompt. Declaring the kind picks the
  // right instruction instead of making every content host argue with the default. Typos fail the mount.
  const kind = manifest.context.app?.kind;
  if (kind !== undefined && !["help", "content"].includes(kind)) {
    throw new Error(`context.app.kind must be "help" or "content", got ${JSON.stringify(kind)}`);
  }
  const credentials = manifest.context.credentials ?? "same-origin";
  if (!["same-origin", "none"].includes(credentials)) {
    throw new Error(`context.credentials must be same-origin or none, got ${credentials}`);
  }
  // Per-call approval is the default contract; a host may explicitly wave its read-only tools
  // through (auto). Anything else is a typo and fails the mount rather than silently allowing.
  if (manifest.toolApproval !== undefined && !["per-call", "auto"].includes(manifest.toolApproval)) {
    throw new Error('toolApproval must be "per-call" or "auto"');
  }
  // Fail closed on a typo'd or future task id: an allowlist that silently ignores unknown entries
  // would let a host believe it had disabled a task it never enabled.
  for (const task of manifest.tasks ?? []) {
    if (!TASKS.includes(task)) throw new Error(`Unknown task "${task}" in manifest; this build offers ${TASKS.join(", ")}`);
  }
  // Same reasoning for declared tools: validate them at mount, not when the model asks.
  hostTools(manifest);
  // Retrieval is validated at mount for the same reason a tool is: a typo that silently disables it looks
  // exactly like a corpus that answers badly, and the difference is only visible in the prompt.
  documents(manifest);
  retrievalOptions(manifest);
  return manifest;
}

/**
 * The corpus a host offers for retrieval. Same-origin paths, because the assistant has no business
 * reading another origin, and the same rule the context readers already enforce.
 */
export function documents(manifest) {
  const declared = manifest?.context?.documents;
  if (declared === undefined) return [];
  if (!Array.isArray(declared)) throw new Error("context.documents must be an array of paths or {url, label} objects");
  return declared.map((entry, index) => {
    const url = typeof entry === "string" ? entry : entry?.url;
    if (typeof url !== "string" || !url.trim()) {
      throw new Error(`context.documents[${index}] needs a url`);
    }
    // A path cannot carry a scheme, and a protocol-relative `//host/path` is cross-origin too, so both
    // are refused at mount. Missing the second form is how a same-origin guard quietly stops being one.
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(url)) {
      throw new Error(`context.documents[${index}] must be same-origin: got ${url}`);
    }
    return { url: url.trim(), label: (typeof entry === "object" && entry?.label) || url.trim() };
  });
}

// `minSimilarity` is per corpus on purpose: the floor that suits one corpus is wrong for another, and a
// host that has measured its own questions knows better than the catalogue's default.
const RETRIEVAL_KEYS = new Set(["index", "corpusVersion", "dims", "alpha", "topK", "maxBytes", "minSimilarity"]);

/**
 * Retrieval settings, with every out-of-range value refused rather than clamped. A host that asks for
 * `dims: 300` has misunderstood Matryoshka, and quietly giving it 256 would hide that.
 */
export function retrievalOptions(manifest) {
  const declared = manifest?.retrieval;
  if (declared === undefined) return {};
  if (!declared || typeof declared !== "object") throw new Error("retrieval must be an object");
  for (const key of Object.keys(declared)) {
    if (!RETRIEVAL_KEYS.has(key)) throw new Error(`Unknown retrieval key "${key}"; known: ${[...RETRIEVAL_KEYS].join(", ")}`);
  }
  const out = {};
  if (declared.index !== undefined) {
    if (typeof declared.index !== "string" || !declared.index.startsWith("/")) {
      throw new Error("retrieval.index must be a path starting with / (same-origin)");
    }
    out.index = declared.index;
  }
  if (declared.dims !== undefined) {
    if (!Number.isInteger(declared.dims) || declared.dims < 1) throw new Error("retrieval.dims must be a positive integer");
    out.dims = declared.dims;
  }
  if (declared.minSimilarity !== undefined) {
    if (typeof declared.minSimilarity !== "number" || !(declared.minSimilarity >= -1 && declared.minSimilarity <= 1)) {
      throw new Error("retrieval.minSimilarity must be a number between -1 and 1");
    }
    out.minSimilarity = declared.minSimilarity;
  }
  if (declared.alpha !== undefined) {
    if (typeof declared.alpha !== "number" || !(declared.alpha >= 0 && declared.alpha <= 1)) {
      throw new Error("retrieval.alpha must be a number between 0 and 1");
    }
    out.alpha = declared.alpha;
  }
  for (const key of ["topK", "maxBytes"]) {
    if (declared[key] === undefined) continue;
    if (!Number.isInteger(declared[key]) || declared[key] < 1) throw new Error(`retrieval.${key} must be a positive integer`);
    out[key] = declared[key];
  }
  if (declared.corpusVersion !== undefined) {
    if (typeof declared.corpusVersion !== "string" || !declared.corpusVersion.trim()) {
      throw new Error("retrieval.corpusVersion must be a non-empty string");
    }
    out.corpusVersion = declared.corpusVersion.trim();
  }
  return out;
}

// Only {id} and {pointer} are substituted. An unlisted placeholder stays literal, so a
// manifest cannot smuggle a dynamic segment into the request.
export function expand(template, values) {
  return template.replace(/\{(\w+)\}/g, (match, key) =>
    (key in values ? encodeURIComponent(values[key]) : match));
}

export function byteCap(value, maxBytes) {
  // Strings pass through as themselves; anything else is sent as JSON. The cap is always measured in
  // encoded bytes, because that is what the engine's context window counts.
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (new TextEncoder().encode(text).length <= maxBytes) return { text, truncated: false };
  let cut = text.slice(0, maxBytes);
  while (cut.length && new TextEncoder().encode(cut).length > maxBytes) cut = cut.slice(0, cut.length - 512);
  return { text: cut, truncated: true };
}

/**
 * Fit a tool result inside the byte budget its own declaration promises.
 *
 * `src/agent.js` *fails the turn* when the encoded result exceeds `maxResultBytes`, because a tool
 * that ignores the budget it declared is a bug worth surfacing. A tool that wraps a host payload
 * therefore has to bound that payload itself: the host's caps (`context.record.maxBytes`,
 * `context.datafile.maxBytes`) are **prompt** budgets and can be larger than a tool's **result**
 * budget — 24 KB of record behind a 16 KB tool is the shape that broke it.
 *
 * Measured, not estimated: `JSON.stringify` escaping and the wrapper count towards the cap, so a
 * quote-heavy record grows by about a tenth on the way in. Trimming beats failing here — a shorter
 * answer beats no answer — and both trims keep the result readable JSON: `record` is cut as text
 * (the agent already passes truncated JSON through as text), `page.variables` loses its tail.
 */
export function fitToolResult(result, maxBytes) {
  const out = { ...result };
  // Must measure `out`: the trims below write to it, and measuring the untouched input would loop
  // to exhaustion and report an unfittable result every time.
  const size = () => new TextEncoder().encode(JSON.stringify(out)).length;
  if (typeof out.record === "string") {
    while (out.record.length > 256 && size() > maxBytes) {
      out.record = out.record.slice(0, Math.max(256, Math.floor(out.record.length * 0.75)));
      out.truncated = true;
    }
  }
  if (Array.isArray(out.page?.variables)) {
    const variables = out.page.variables;
    let keep = variables.length;
    while (keep > 0 && size() > maxBytes) {
      keep -= Math.max(1, Math.ceil(keep / 4));
      out.page = { ...out.page, variables: variables.slice(0, keep), variablesTruncated: true };
    }
  }
  // Only reachable if a single field is itself larger than the whole budget: say so instead of
  // returning something the agent will reject and kill the turn with.
  if (size() > maxBytes) return { error: "The current view is too large to load in one request; ask about a single field instead." };
  return out;
}

/**
 * Host-declared tools (`tools` in the manifest). A tool is a **GET, same-origin** endpoint the
 * model may ask for by name — the only way `pslm-host/1` lets the assistant reach beyond the
 * context it was given.
 *
 * Three properties are enforced here rather than at call time, because a typo in a tool declaration
 * would otherwise surface mid-conversation as a failed tool call:
 *   - `id` must match what `runAgent` accepts (`/^[a-z][a-z0-9_]{0,63}$/`), so a bad id fails the
 *     mount instead of throwing `Tool not permitted` after the model already spent a round;
 *   - method is GET only — this contract has no write path, and a declared POST would be a
 *     write-back wearing a different hat;
 *   - `endpoint` must be a path starting with `/`, so the browser cannot be pointed at another
 *     origin by configuration alone.
 *
 * `enum: "$declaredPointers"` in a parameter schema expands to the manifest's own
 * `context.field.pointers` list, so the model can only ever ask for a field the host declared
 * without the host repeating that list.
 */
const TOOL_ID = /^[a-z][a-z0-9_]{1,63}$/;
export const DECLARED_POINTERS = "$declaredPointers";

/**
 * Whether a change of the host-declared data-file id is a **different subject**: two concrete files.
 * Entering or leaving a file section is not one — either side empty means the datafiles list or a
 * project-level view, whose context does not replace a conversation about a file. Used to decide
 * whether an in-flight transcript must be discarded when the open file changes.
 */
export function fileSubjectChanged(previous, next) {
  return Boolean(previous) && Boolean(next) && previous !== next;
}

/**
 * Translate the manifest's credential word into the one `fetch()` accepts.
 *
 * The contract says `same-origin` or `none`; the Fetch API says `same-origin`, `omit` or `include`. Passing
 * the manifest's word straight through throws in the browser — `'none' is not a valid enum value of type
 * RequestCredentials` — so the translation lives here, once, for every declared read and tool.
 */
export function fetchCredentials(manifest) {
  return manifest?.context?.credentials === "none" ? "omit" : "same-origin";
}

export function hostTools(manifest) {
  const declared = manifest?.tools;
  if (!declared) return [];
  if (!Array.isArray(declared)) throw new Error("manifest.tools must be an array");
  return declared.map((tool) => {
    const id = tool?.id;
    if (!TOOL_ID.test(id ?? "")) {
      throw new Error(`manifest tool id ${JSON.stringify(id)} must be lower_snake_case, 2-64 characters`);
    }
    for (const key of ["label", "description", "endpoint"]) {
      if (typeof tool[key] !== "string" || !tool[key].trim()) {
        throw new Error(`manifest tool "${id}" needs a ${key} — the model cannot be asked to guess one`);
      }
    }
    if ((tool.method ?? "GET") !== "GET") {
      throw new Error(`manifest tool "${id}" must be GET; pslm-host/1 has no write path`);
    }
    if (!tool.endpoint.startsWith("/")) {
      throw new Error(`manifest tool "${id}" endpoint must be a path starting with / (same-origin)`);
    }
    const schema = tool.parameters;
    if (schema && (schema.type !== "object" || typeof schema.properties !== "object" || !schema.properties)) {
      throw new Error(`manifest tool "${id}" parameters must be a JSON Schema object with properties`);
    }
    for (const [name, prop] of Object.entries(schema?.properties || {})) {
      if (prop?.enum === DECLARED_POINTERS && name !== "pointer") {
        throw new Error(`manifest tool "${id}": ${DECLARED_POINTERS} is only allowed on a "pointer" parameter`);
      }
    }
    return { method: "GET", maxBytes: 4096, ...tool };
  });
}

/**
 * Runnable tools from the manifest's `tools` declarations.
 *
 * Each one is marked `network: true`, which is not a label but a gate: `runAgent` drops network
 * tools unless the host passes allowNetwork, and then asks `approveTool` about the **exact
 * arguments** before every single call (src/agent.js). A declared tool is therefore two opt-ins —
 * the manifest declares it and the mount element asks for it — plus a human click per call.
 *
 * Arguments fill the endpoint's `{placeholders}` from the declared schema only, and never `id`:
 * otherwise a model-invented `id` would read another curator's project through a tool that was
 * declared for the record on screen.
 */
export function buildHostTools(manifest, recordId, { fetch: request = globalThis.fetch, origin = globalThis.location?.origin ?? "http://localhost", base = origin } = {}) {
  const pointerOptions = manifest?.context?.field?.pointers || [];
  const pointers = pointerOptions.map((p) => p.pointer);
  return hostTools(manifest).map((tool) => {
    const schema = structuredClone(tool.parameters || { type: "object", properties: {} });
    for (const prop of Object.values(schema.properties || {})) {
      if (prop.enum === DECLARED_POINTERS) {
        if (!pointers.length) throw new Error(`tool "${tool.id}" asks for declared pointers, but the manifest declares none`);
        prop.enum = pointers;
        const choices = pointerOptions.map((p) => `${p.label || p.pointer}: ${p.pointer}`).join("; ");
        prop.description = `${prop.description || "Choose a declared JSON Pointer"}. Match the user's field name to one of these choices: ${choices}`;
      }
    }
    const names = Object.keys(schema.properties || {});
    return {
      name: tool.id,
      description: tool.description,
      parameters: schema,
      network: true,
      async run(args = {}) {
        const vars = { id: recordId };
        for (const key of names) if (key !== "id" && args[key] !== undefined) vars[key] = String(args[key]);
        // `base` is the manifest's directory, so a host can declare a tool with a relative endpoint and
        // serve the pack at any subpath. The origin guard is what actually constrains the reach.
        const url = new URL(expand(tool.endpoint, vars), base);
        if (url.origin !== origin) throw new Error(`tool ${tool.id} left the host origin`);
        const res = await request(url.href, { credentials: fetchCredentials(manifest) });
        if (!res.ok) throw new Error(`${tool.id}: HTTP ${res.status}`);
        return byteCap(await res.text(), tool.maxBytes).text;
      },
    };
  });
}

/**
 * What a mount is allowed to do, derived from the only two things a host declares on the element:
 * a manifest and a record id. Pure, so the policy is testable without a DOM and so it cannot drift
 * between the tabs that read it.
 *
 * The point of the table is that the assistant degrades *downward to a working chat* instead of
 * refusing to mount. Any page can put `<div data-pslm>` plus one script tag in its HTML and get a
 * usable assistant with no manifest, no record and no knowledge of what the page is about; adding a
 * manifest adds authorized context reads, and adding a record id makes them mean something.
 *
 *   manifest  record id →  chat        field suggest   fill
 *   ✗          ✗            plain (a)   ✗              ✗
 *   ✓          ✗            plain (a)   ✗              ✗
 *   ✓ + app    ✗            app help    ✗              ✗
 *   ✓          ✓            grounded    ✓              host opt-in
 *   ✗          ✓            refused — an id with no endpoint to resolve it is a misconfiguration
 *
 * (a) plain = no host context at all. Portable SLM's own description is still in the prompt
 *     (composeContext in chat-core.js is append-only), so the assistant always knows what it is.
 *
 * `context` names which host source a mount reads, if any: "record" | "app" | "none".
 */
export function mountMode({ manifest, recordId }) {
  if (recordId && !manifest) {
    throw new Error("data-record-id needs a host manifest to resolve it; serve portable-slm.host.json or set data-manifest");
  }
  const record = Boolean(recordId && manifest?.context?.record?.url);
  // A datafile mount is a record page that also names the open file; the host updates
  // data-file-id as the curator navigates. It needs a declared endpoint, not a static file id.
  const datafile = Boolean(record && manifest?.context?.datafile?.url);
  return {
    record,                                                       // fetch a snapshot per question
    datafile,
    // App-level context is what a record-less page declares: help text, a list, anything that is
    // about the application rather than about one record. A record wins when both are declared.
    app: !record && Boolean(manifest?.context?.app?.url),
    suggest: record && Boolean(manifest?.context?.field?.url && manifest?.context?.field?.pointers?.length),
    fill: record,                                                 // the host still opts in with data-fill
    context: record ? "record" : !manifest ? "none" : manifest.context.app?.url ? "app" : "none",
  };
}
