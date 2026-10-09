import assert from "node:assert/strict";
import { test } from "node:test";
import {
  allowsTask, buildHostTools, byteCap, documents, expand, fileSubjectChanged, fitToolResult, hostTools,
  mountMode, retrievalOptions, TASKS, validateManifest, HOST_API_VERSION,
} from "../integrations/host-contract.js";

const manifest = () => ({
  apiVersion: HOST_API_VERSION,
  app: { name: "Example App", version: "1.2.1" },
  context: {
    record: { url: "/index.php/api/editor/json/{id}?exclude_private_fields=1", maxBytes: 12288 },
    field: {
      url: "/index.php/api/editor/json_field/{id}?path={pointer}", maxBytes: 4096,
      pointers: [{ pointer: "/study_desc/study_info/abstract", label: "Abstract" }],
    },
    credentials: "same-origin",
  },
  tasks: ["pslm.chat", "pslm.suggest-field"],
  writeBack: false,
});

test("accepts a pslm-host/1 manifest and defaults credentials to same-origin", () => {
  const withoutCredentials = manifest();
  delete withoutCredentials.context.credentials;
  assert.equal(validateManifest(manifest()).app.name, "Example App");
  assert.equal(validateManifest(withoutCredentials).context.record.maxBytes, 12288);
});

test("rejects version mismatch, write access and a manifest with no context source", () => {
  const wrongVersion = { ...manifest(), apiVersion: "pslm-host/2" };
  assert.throws(() => validateManifest(wrongVersion), /targets pslm-host\/1/);
  assert.throws(() => validateManifest({ ...manifest(), writeBack: true }), /read-only/);
  const noSource = manifest();
  delete noSource.context.record;
  assert.throws(() => validateManifest(noSource), /no context source/);
  // An app-only manifest is legitimate: a page that is not about one record can still declare help.
  const appOnly = manifest();
  delete appOnly.context.record;
  appOnly.context.app = { url: "/pslm-help.md", maxBytes: 8192 };
  assert.equal(validateManifest(appOnly).context.app.url, "/pslm-help.md");
  assert.throws(() => validateManifest({ ...manifest(), context: { ...manifest().context, credentials: "api-key" } }), /same-origin or none/);
  assert.throws(() => validateManifest(undefined), /manifest is missing/);
});

test("substitutes only {id} and {pointer}, and escapes them", () => {
  assert.equal(
    expand("/api/editor/json_field/{id}?path={pointer}", { id: "6", pointer: "/study_desc/study_info/abstract" }),
    "/api/editor/json_field/6?path=%2Fstudy_desc%2Fstudy_info%2Fabstract",
  );
  // An unknown placeholder must stay literal instead of becoming an open redirect or injection.
  assert.equal(expand("/api/{action}/{id}", { id: "6" }), "/api/{action}/6");
});

test("only a move between two concrete files is a different subject", () => {
  assert.equal(fileSubjectChanged("F1", "F2"), true);   // switching files
  assert.equal(fileSubjectChanged("F1", "F1"), false);  // same file
  assert.equal(fileSubjectChanged("", "F1"), false);    // datafiles list → a file
  assert.equal(fileSubjectChanged("F1", ""), false);    // a file → datafiles list
  assert.equal(fileSubjectChanged(null, "F1"), false);  // first mount
  assert.equal(fileSubjectChanged(undefined, ""), false);
});

test("byteCap reports truncation in bytes, not characters", () => {
  const small = byteCap({ abstract: "x".repeat(50) }, 4096);
  assert.equal(small.truncated, false);

  // Multibyte: 4 000 characters are 12 000 bytes, so a 4 096-byte cap must truncate.
  const big = byteCap({ abstract: "é".repeat(4000) }, 4096);
  assert.equal(big.truncated, true);
  assert.ok(new TextEncoder().encode(big.text).length <= 4096);
});

test("task allowlist: declared ids gate the UI, an unknown id fails the whole manifest", () => {
  assert.deepEqual(TASKS, ["pslm.chat", "pslm.suggest-field", "pslm.suggest-datafile-description"]);
  assert.equal(allowsTask(manifest(), "pslm.chat"), true);

  // A manifest that names no tasks gets what this SDK ships — L1 must stay drop-in.
  const noTasks = manifest();
  delete noTasks.tasks;
  assert.equal(allowsTask(noTasks, "pslm.suggest-field"), true);

  // Disabling chat must remove the tab, not leave a disabled one.
  assert.equal(allowsTask({ ...manifest(), tasks: ["pslm.suggest-field"] }, "pslm.chat"), false);

  // A typo would otherwise read as "no tasks allowed" while the host believed it had enabled one.
  assert.throws(() => validateManifest({ ...manifest(), tasks: ["pslm.suggest"] }), /Unknown task/);
});

test("the panel degrades to a working chat instead of refusing to mount", () => {
  // Any page can drop in <div data-pslm> + one script tag: no manifest, no record, no app knowledge.
  // It still gets Portable SLM's own shipped description (composeContext), just no host data.
  assert.deepEqual(mountMode({ manifest: null, recordId: undefined }),
    { record: false, datafile: false, app: false, suggest: false, fill: false, context: "none" });

  // A manifest alone declares authorized reads, but reads of what? Still no host source.
  assert.equal(mountMode({ manifest: manifest(), recordId: undefined }).context, "none");
  assert.equal(mountMode({ manifest: manifest(), recordId: undefined }).suggest, false);

  // App-level context grounds the assistant in the application, never in the user's data.
  const withApp = manifest();
  withApp.context.app = { url: "/pslm-help.md", maxBytes: 8192 };
  assert.deepEqual(mountMode({ manifest: withApp, recordId: undefined }).context, "app");
  assert.equal(mountMode({ manifest: withApp, recordId: undefined }).suggest, false);

  // Manifest + record is the full L2 panel, and a record outranks app context when both are declared.
  assert.deepEqual(mountMode({ manifest: withApp, recordId: "6" }),
    { record: true, datafile: false, app: false, suggest: true, fill: true, context: "record" });

  // A record id with nowhere to resolve it is a misconfiguration, not a mode.
  assert.throws(() => mountMode({ manifest: null, recordId: "6" }), /needs a host manifest/);

  // Declaring a record but no field endpoints must not offer a Suggest tab with an empty picker.
  const noFields = manifest();
  delete noFields.context.field;
  assert.equal(mountMode({ manifest: noFields, recordId: "6" }).suggest, false);
});

test("byteCap caps encoded bytes and passes strings through unquoted", () => {
  assert.deepEqual(byteCap({ a: 1 }, 128), { text: '{"a":1}', truncated: false });
  // Help text is sent as itself, not as a JSON string with escapes and wrapping quotes.
  assert.equal(byteCap("hello", 128).text, "hello");
  const cut = byteCap("x".repeat(500), 100);
  assert.equal(cut.truncated, true);
  assert.ok(new TextEncoder().encode(cut.text).length <= 100);
  // Multi-byte characters must be measured in bytes, not UTF-16 units.
  assert.ok(new TextEncoder().encode(byteCap("é".repeat(400), 100).text).length <= 100);
});

// --- declared tools (pslm-host/1 `tools`) -----------------------------------------------
const toolManifest = (tool) => ({
  apiVersion: "pslm-host/1",
  context: { record: { url: "/api/record/{id}" }, field: { url: "/api/f/{id}?p={pointer}",
    pointers: [{ pointer: "/a/title", label: "Title" }, { pointer: "/b/abstract", label: "Abstract" }] } },
  tools: [tool],
});
const goodTool = {
  id: "read_project_field", label: "Read one field", description: "Read one declared field.",
  endpoint: "/api/f/{id}?p={pointer}", maxBytes: 4096,
  parameters: { type: "object", properties: { pointer: { type: "string", enum: "$declaredPointers" } },
    required: ["pointer"] },
};

test("toolApproval must be per-call or auto, never a typo", () => {
  const base = { apiVersion: HOST_API_VERSION, app: { name: "X" }, context: { record: { url: "/r/{id}" } } };
  assert.equal(validateManifest({ ...base, toolApproval: "auto" }).toolApproval, "auto");
  assert.equal(validateManifest(base).toolApproval, undefined); // default stays per-call
  assert.throws(() => validateManifest({ ...base, toolApproval: "yolo" }), /must be "per-call" or "auto"/);
});

test("a declared tool is GET, same-origin, and named the way runAgent demands", () => {
  const [tool] = hostTools(toolManifest(goodTool));
  assert.equal(tool.method, "GET");
  assert.equal(tool.maxBytes, 4096);
  assert.match(tool.id, /^[a-z][a-z0-9_]{1,63}$/);   // agent.js rejects anything else at call time
});

test("bad tool declarations fail the manifest, not the conversation", () => {
  assert.throws(() => hostTools(toolManifest({ ...goodTool, id: "Read-Field" })), /lower_snake_case/);
  assert.throws(() => hostTools(toolManifest({ ...goodTool, method: "POST" })), /no write path/);
  assert.throws(() => hostTools(toolManifest({ ...goodTool, endpoint: "https://other.example/{id}" })), /same-origin/);
  assert.throws(() => hostTools(toolManifest({ ...goodTool, description: " " })), /needs a description/);
  assert.throws(() => hostTools(toolManifest({ ...goodTool, parameters: { type: "array" } })), /JSON Schema/);
  assert.throws(() => hostTools(toolManifest({ ...goodTool, parameters: { type: "object",
    properties: { field: { enum: "$declaredPointers" } } } })), /only allowed on a "pointer"/);
  assert.throws(() => validateManifest(toolManifest({ ...goodTool, id: "Bad Id" })), /lower_snake_case/);
});

test("declared tools run through the panel's own builder: same-origin GET, capped, id never overridable", async () => {
  const calls = [];
  const tools = buildHostTools(toolManifest(goodTool), "6", {
    origin: "http://localhost",
    fetch: async (url) => { calls.push(url); return new Response(JSON.stringify({ value: "Survey" }), { status: 200 }); },
  });
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, "read_project_field");
  assert.equal(tools[0].network, true);   // network:true ⇒ allowNetwork + a per-call approval
  assert.deepEqual(tools[0].parameters.properties.pointer.enum, ["/a/title", "/b/abstract"]);
  assert.match(tools[0].parameters.properties.pointer.description, /Title: \/a\/title; Abstract: \/b\/abstract/);
  const out = await tools[0].run({ pointer: "/a/title", id: "999" });   // id spoofing attempt
  assert.equal(calls[0], "http://localhost/api/f/6?p=%2Fa%2Ftitle");    // stays on the record on screen
  assert.match(out, /Survey/);
});

test("a tool whose endpoint escapes the origin is refused before the request", async () => {
  const manifest = toolManifest({ ...goodTool, endpoint: "/../../evil" });
  const tools = buildHostTools(manifest, "6", { origin: "http://localhost", fetch: async () => { throw new Error("must not fetch"); } });
  await assert.rejects(tools[0].run({ pointer: "/a/title" }), /left the host origin|Failed to fetch|must not fetch/);
});

test("a tool asking for declared pointers on a manifest with none fails loudly", () => {
  const manifest = toolManifest(goodTool);
  manifest.context.field.pointers = [];
  assert.throws(() => buildHostTools(manifest, "6", { origin: "http://localhost" }), /declares none/);
});

test("fitToolResult keeps a 24 KB record inside a 16 KB tool budget by trimming it", () => {
  // The bug this exists for: manifest.context.record.maxBytes (24 KB, a *prompt* budget) is larger
  // than the get_current_page tool's maxResultBytes (16 KB). agent.js fails the turn on overflow, so
  // the tool has to fit itself — and it must measure the encoded result, not the raw string.
  const record = JSON.stringify({ dataset: Array.from({ length: 400 }, (_, i) => ({ title: `field ${i}`, abstract: "x".repeat(60) })) });
  const fitted = fitToolResult({ view: "Project overview", record }, 15600);
  assert.ok(new TextEncoder().encode(JSON.stringify(fitted)).length <= 15600);
  assert.equal(fitted.truncated, true);
  assert.match(fitted.record, /field 0/);          // the head survives: the descriptive metadata
  assert.doesNotMatch(fitted.record, /field 399/);  // the tail is what goes
});

test("fitToolResult leaves a result that already fits untouched", () => {
  const payload = { view: "Project overview", record: '{"a":1}' };
  assert.deepEqual(fitToolResult(payload, 15600), payload);
});

test("fitToolResult trims a datafile page's variable tail and still returns parseable JSON", () => {
  const page = { datafile: { file_name: "f.csv", description: "x".repeat(500) },
    variables: Array.from({ length: 300 }, (_, i) => ({ name: `v${i}`, label: "l".repeat(120) })) };
  const fitted = fitToolResult({ view: "Variables", page }, 15600);
  assert.ok(new TextEncoder().encode(JSON.stringify(fitted)).length <= 15600);
  assert.equal(fitted.page.variablesTruncated, true);
  assert.ok(fitted.page.variables.length < 300 && fitted.page.variables.length > 0);
  assert.equal(JSON.parse(JSON.stringify(fitted.page)).datafile.file_name, "f.csv");
});

test("fitToolResult reports an unfittable result instead of returning something the agent rejects", () => {
  // No trimmable field is large enough to get under the budget, so the honest answer is an error the
  // model can relay — not a payload agent.js will throw on.
  const fitted = fitToolResult({ view: "project", page: { datafile: { description: "x".repeat(2000) } } }, 512);
  assert.match(fitted.error, /too large/);
});

test("context.app.kind is validated, so a typo fails the mount rather than the instruction", () => {
  const withKind = (kind) => ({
    apiVersion: HOST_API_VERSION,
    app: { name: "App", version: "1.0.0" },
    context: { app: { url: "app.md", kind }, credentials: "none" },
    tasks: ["pslm.chat"],
    writeBack: false,
  });
  assert.equal(validateManifest(withKind("content")).context.app.kind, "content");
  assert.equal(validateManifest(withKind("help")).context.app.kind, "help");
  assert.equal(validateManifest(withKind(undefined)).context.app.kind, undefined);
  assert.throws(() => validateManifest(withKind("docs")), /context\.app\.kind must be/);
});

test("a corpus is same-origin, and a bare string and an object mean the same thing", () => {
  const base = { apiVersion: HOST_API_VERSION, app: { name: "App", version: "1.0.0" }, context: { app: { url: "app.md" } }, writeBack: false };
  assert.deepEqual(documents(base), [], "no documents means no retrieval, not an error");
  const declared = documents({ ...base, context: { ...base.context, documents: ["/a.md", { url: "/b.md", label: "Handbook" }] } });
  assert.deepEqual(declared, [{ url: "/a.md", label: "/a.md" }, { url: "/b.md", label: "Handbook" }]);
  assert.throws(() => documents({ ...base, context: { ...base.context, documents: "a.md" } }), /must be an array/);
  assert.throws(() => documents({ ...base, context: { ...base.context, documents: [{ label: "no url" }] } }), /needs a url/);
  assert.throws(
    () => documents({ ...base, context: { ...base.context, documents: ["https://example.com/manual.md"] } }),
    /must be same-origin/,
    "another origin is refused at mount, not at fetch",
  );
});

test("retrieval options are validated, and a bad value is refused rather than clamped", () => {
  const base = { apiVersion: HOST_API_VERSION, app: { name: "App", version: "1.0.0" }, context: { app: { url: "app.md" } }, writeBack: false };
  assert.deepEqual(retrievalOptions(base), {}, "retrieval is optional");
  const ok = retrievalOptions({ ...base, retrieval: { index: "/pslm.index.json", corpusVersion: " 2026-10-09 ", dims: 256, alpha: 0.5, topK: 6, maxBytes: 8192 } });
  assert.deepEqual(ok, { index: "/pslm.index.json", dims: 256, alpha: 0.5, topK: 6, maxBytes: 8192, corpusVersion: "2026-10-09" });
  assert.throws(() => retrievalOptions({ ...base, retrieval: { dims: 300.5 } }), /positive integer/);
  assert.throws(() => retrievalOptions({ ...base, retrieval: { dims: 0 } }), /positive integer/);
  assert.throws(() => retrievalOptions({ ...base, retrieval: { alpha: 1.5 } }), /between 0 and 1/);
  assert.throws(() => retrievalOptions({ ...base, retrieval: { alpha: "0.5" } }), /between 0 and 1/);
  assert.throws(() => retrievalOptions({ ...base, retrieval: { index: "pslm.index.json" } }), /starting with \//);
  assert.throws(() => retrievalOptions({ ...base, retrieval: { corpusVersion: "  " } }), /non-empty string/);
  assert.throws(() => retrievalOptions({ ...base, retrieval: { chunkSize: 500 } }), /Unknown retrieval key/);
});

test("validateManifest refuses a bad corpus or retrieval block at mount", () => {
  const withRetrieval = (retrieval, docs) => ({
    apiVersion: HOST_API_VERSION,
    app: { name: "App", version: "1.0.0" },
    context: { app: { url: "app.md" }, ...(docs ? { documents: docs } : {}) },
    ...(retrieval ? { retrieval } : {}),
    writeBack: false,
  });
  assert.ok(validateManifest(withRetrieval({ dims: 256 }, ["/a.md"])));
  assert.throws(() => validateManifest(withRetrieval({ alpha: 2 })), /between 0 and 1/);
  assert.throws(() => validateManifest(withRetrieval(undefined, ["//cdn.example.com/a.md"])), /must be same-origin/);
});
