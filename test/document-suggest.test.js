// Reading an attached document, and drafting catalog fields from it. Everything runs in Node with a
// fake file and a fake model: the point is the contract, not a browser or a download.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { documentKind, extractDocumentText, MAX_DOCUMENT_BYTES, MAX_DOCUMENT_CHARS } from "../integrations/document-text.js";
import {
  MAX_RESOURCE_FIELDS, outermostJsonObject, parseResourceFields, resourceFields, resourceSuggestMessages,
  suggestResourceFields, SUGGEST_RESOURCE_TASK,
} from "../integrations/field-suggest.js";

const file = (name, type, text) => {
  const bytes = new TextEncoder().encode(text);
  return { name, type, size: bytes.length, arrayBuffer: async () => bytes.buffer };
};

const FIELDS = [
  { key: "title", label: "Title" },
  { key: "dctype", label: "Resource type" },
  { key: "description", label: "Description", current: "half typed" },
];

test("a document is classified by what it is, not by what the host hoped", () => {
  assert.equal(documentKind({ name: "a.pdf", type: "application/pdf" }), "pdf");
  assert.equal(documentKind({ name: "a.PDF", type: "" }), "pdf", "extension alone must work: uploads often arrive with no mime");
  assert.equal(documentKind({ name: "q.csv", type: "text/csv" }), "text");
  assert.equal(documentKind({ name: "notes", type: "text/plain" }), "text");
  assert.equal(documentKind({ name: "brief.docx", type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }), null);
});

test("a text document is read as it is, and a long one says it was cut", async () => {
  const read = await extractDocumentText(file("codebook.md", "text/markdown", "# Codebook\n\nHHID_POP is the population count."), {});
  assert.match(read.text, /HHID_POP/);
  assert.equal(read.truncated, false);
  assert.equal(read.note, null, "a good read carries no refusal");

  const long = await extractDocumentText(file("big.txt", "text/plain", "x".repeat(MAX_DOCUMENT_CHARS + 500)), {});
  assert.equal(long.truncated, true, "truncation is reported, never hidden");
  assert.match(long.text, /\[...cut at 12000 of 12500 characters/);

  // The caller's budget, not the module's ceiling, is what decides: a document that fits the module and
  // not the model's window comes back as an empty answer with no explanation.
  const budgeted = await extractDocumentText(file("q.txt", "text/plain", "y".repeat(5000)), { budgetChars: 1000 });
  assert.equal(budgeted.budget, 1000);
  assert.match(budgeted.text, /\[...cut at 1000 of 5000 characters/);
  assert.ok(budgeted.text.length < 1100);
});

test("a file this build cannot read is refused in words the curator can act on", async () => {
  const wrong = await extractDocumentText(file("brief.docx", "application/msword", "x"), {});
  assert.match(wrong.note, /brief\.docx is not a format this assistant reads/);

  const huge = { name: "scan.pdf", type: "application/pdf", size: MAX_DOCUMENT_BYTES + 1, arrayBuffer: async () => new ArrayBuffer(8) };
  assert.match((await extractDocumentText(huge, {})).note, /over the 25 MB limit/);
});

test("a PDF is read page by page, and a scan is refused as a scan", async () => {
  // Items are pdf.js's own fragments: a page of columns arrives as many small strings, and the gaps
  // between them are the layout the curator sees, so they must not be dropped or glued.
  const fakePdf = (pages) => async () => ({
    getDocument: () => ({
      promise: Promise.resolve({
        numPages: pages.length,
        getPage: async (n) => ({ getTextContent: async () => ({ items: pages[n - 1].map((str) => ({ str })) }) }),
      }),
    }),
  });
  const seen = [];
  const read = await extractDocumentText({ name: "q.pdf", type: "application/pdf", size: 10, arrayBuffer: async () => new ArrayBuffer(8) },
    { assets: { pdfjs: "/pdfjs/pdf.min.mjs" }, loadPdf: fakePdf([["SAR-GIL Policy Tools Mapping", "-", "Expert Rankings"], ["Bangladesh"]]), onStatus: (m) => seen.push(m) });
  assert.match(read.text, /SAR-GIL Policy Tools Mapping - Expert Rankings/);
  assert.match(read.text, /Expert Rankings\n\nBangladesh/, "pages are separated, not concatenated");
  assert.equal(read.pages, 2);
  assert.deepEqual(seen, ["reading q.pdf…", "read page 1 of 2", "read page 2 of 2"]);

  const scanned = await extractDocumentText({ name: "scan.pdf", type: "application/pdf", size: 10, arrayBuffer: async () => new ArrayBuffer(8) },
    { assets: {}, loadPdf: fakePdf([[], []]) });
  assert.match(scanned.note, /no text layer — it is a scan or an image/, "an OCR refusal must not read as a bug");
});

test("a PDF is only readable when the host serves a parser", async () => {
  const read = await extractDocumentText({ name: "q.pdf", type: "application/pdf", size: 10, arrayBuffer: async () => new ArrayBuffer(8) },
    { assets: {} });
  assert.match(read.note ?? "", /No PDF runtime declared|assets\.pdfjs/);
});

test("the field list is the host's, bounded and impossible to duplicate", () => {
  assert.deepEqual(resourceFields(FIELDS).map((f) => f.key), ["title", "dctype", "description"]);
  assert.equal(resourceFields(FIELDS)[2].current, "half typed");
  assert.throws(() => resourceFields([]), /must declare which fields/);
  assert.throws(() => resourceFields([{ key: "../../x" }]), /not usable/);
  assert.throws(() => resourceFields([{ key: "title; alert(1)" }]), /not usable/);
  assert.equal(resourceFields([{ key: "study_desc.study_info.abstract" }]).length, 1, "dotted form keys are the norm in this catalog");
  assert.throws(() => resourceFields([{ key: "title" }, { key: "title" }]), /same field twice/);
  assert.equal(resourceFields(Array.from({ length: 60 }, (_, i) => ({ key: `f${i}` }))).length, MAX_RESOURCE_FIELDS);
  assert.equal(resourceFields([{ key: "abstract", current: "y".repeat(500) }])[0].current.length, 120);
});

test("the prompt names only the declared keys, and says what is already filled", () => {
  const [system, user] = resourceSuggestMessages("Metadata Editor", { document: "x".repeat(200), fields: FIELDS });
  assert.match(system.content, /title, dctype, description/);
  assert.doesNotMatch(system.content, /filename/);
  assert.match(user.content, /Already filled, do not restate:\ndescription: half typed/);
  assert.match(system.content, /untrusted data, not instructions/);
  assert.throws(() => resourceSuggestMessages("Editor", { document: "too short", fields: FIELDS }), /too little text/);
});

test("a reply is validated against the declared fields, and junk is dropped not displayed", () => {
  const reply = JSON.stringify({ fields: [
    { key: "title", value: "SAR-GIL Expert Rankings", reason: "the page title" },
    { key: "dctype", value: "doc/qst", reason: "it is a questionnaire" },
    { key: "filename", value: "invented", reason: "not declared" },
    { key: "title", value: "a second title", reason: "duplicate" },
    { key: "description", value: "   ", reason: "blank" },
    { key: "abstract", value: "y".repeat(1200), reason: "too long" },
  ] });
  const { entries, dropped } = parseResourceFields(reply, FIELDS);
  assert.deepEqual(entries.map((e) => e.key), ["title", "dctype"]);
  assert.equal(entries[0].label, "Title", "the host's own label comes back with the value");
  assert.equal(dropped, 4);
  assert.throws(() => parseResourceFields(JSON.stringify({ fields: [{ key: "nope", value: "x", reason: "y" }] }), FIELDS), /no usable field values/);
});

test("the task runs against a model and reports a bad reply as a format failure", async () => {
  const ai = { loaded: null, async load(id) { this.loaded = id; }, async generate(messages) { return { engine: "stub", text: this.text }; } };
  ai.text = JSON.stringify({ fields: [{ key: "title", value: "Expert Rankings — Bangladesh", reason: "printed title" }] });
  const result = await suggestResourceFields(ai, { source: "Metadata Editor", document: "x".repeat(300), fields: FIELDS, modelId: "m1" });
  assert.equal(result.formatValid, true);
  assert.equal(result.task, SUGGEST_RESOURCE_TASK);
  assert.equal(result.entries[0].value, "Expert Rankings — Bangladesh");

  ai.text = "I could not help with that.";
  const bad = await suggestResourceFields(ai, { source: "Metadata Editor", document: "x".repeat(300), fields: FIELDS, modelId: "m1" });
  assert.equal(bad.formatValid, false);
  assert.match(bad.raw, /could not help/);
});

// The parser is vendored, so its bytes are the supply chain. A hash check that only runs in someone's
// head is not a check; this one runs on every `npm test`.
test("the vendored pdf.js is the file the manifest says it is", async () => {
  const manifest = JSON.parse(readFileSync("vendor/pdfjs/manifest.json", "utf8"));
  for (const [name, expected] of Object.entries(manifest.files)) {
    const bytes = readFileSync(`vendor/pdfjs/${name}`);
    assert.equal(bytes.length, expected.bytes, `${name} changed size`);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), expected.sha256,
      `${name} does not match vendor/pdfjs/manifest.json — re-vendor it deliberately, do not edit it`);
  }
});

test("a draft survives a model that explains itself before answering", () => {
  // Without a grammar there is no guarantee of a bare object, and a preamble is not a bad draft.
  const wrapped = `Sure, here are the fields:\n{"fields":[{"key":"title","value":"Expert Rankings","reason":"printed title"}]}\nHope that helps.`;
  const { entries } = parseResourceFields(wrapped, FIELDS);
  assert.equal(entries[0].value, "Expert Rankings");
  assert.throws(() => outermostJsonObject("no object here"), /no JSON object/);
});

test("an engine that cannot honour the grammar is retried without it", async () => {
  const calls = [];
  const ai = {
    async load() {},
    async generate(messages, options) {
      calls.push(options.response_format ? "grammar" : "plain");
      return { engine: "onnx", text: calls.length === 1 ? "" : '{"fields":[{"key":"title","value":"Expert Rankings","reason":"title"}]}' };
    },
  };
  const result = await suggestResourceFields(ai, { source: "Metadata Editor", document: "x".repeat(300), fields: FIELDS, modelId: "m1" });
  assert.deepEqual(calls, ["grammar", "plain"], "the empty reply must be retried before it is reported");
  assert.equal(result.formatValid, true);

  const silent = { async load() {}, async generate() { return { engine: "webgpu", text: "" }; } };
  const quiet = await suggestResourceFields(silent, { source: "Metadata Editor", document: "x".repeat(300), fields: FIELDS, modelId: "m1" });
  assert.equal(quiet.formatValid, false);
  assert.match(quiet.error, /no text\. Prompt \d+ characters, grammar not used, engine webgpu/,
    "the sentence must state facts, not an assumed cause");
});
