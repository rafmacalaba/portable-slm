// Reading an attached document, and drafting catalog fields from it. Everything runs in Node with a
// fake file and a fake model: the point is the contract, not a browser or a download.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { documentKind, extractDocumentText, MAX_DOCUMENT_BYTES, MAX_DOCUMENT_CHARS } from "../integrations/document-text.js";
import {
  outermostJsonObject, parseResourceFieldReply, resourceSuggestMessages, suggestResourceField, SUGGEST_RESOURCE_TASK,
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

const TITLE_FIELD = { key: "title", label: "Title" };
const TYPE_FIELD = {
  key: "dctype", label: "Resource type", current: "",
  options: [
    { value: "doc/qst", label: "Document, Questionnaire [doc/qst]" },
    { value: "doc/rep", label: "Document, Report [doc/rep]" },
  ],
};

// Each generation receives one field, not a form-shaped array. Select options are part of that one
// field's prompt so the suggestion is a value the host can actually accept.
test("the prompt asks for exactly one field and includes its accepted options", () => {
  const [system, user] = resourceSuggestMessages("Metadata Editor", {
    document: "x".repeat(200), field: TYPE_FIELD,
  });
  assert.match(system.content, /exactly one value for one catalog field/);
  assert.match(system.content, /doc\/qst/);
  assert.match(user.content, /Field key: dctype/);
  assert.match(user.content, /Field label: Resource type/);
  assert.match(user.content, /Document text:/);
  assert.doesNotMatch(user.content, /Field key: title/);
  assert.throws(() => resourceSuggestMessages("Editor", { document: "too short", field: TITLE_FIELD }), /too little text/);
  assert.throws(() => resourceSuggestMessages("Editor", { document: "x".repeat(100), field: { key: "../x" } }), /not usable/);
});

test("single-field parser accepts a supported value or explicit no-evidence answer", () => {
  assert.deepEqual(parseResourceFieldReply('{"suggestion":"doc/qst","reason":"The document is a questionnaire."}', TYPE_FIELD), {
    supported: true, suggestion: "doc/qst", reason: "The document is a questionnaire.",
  });
  assert.deepEqual(parseResourceFieldReply('{"suggestion":"","reason":"Publisher is not stated."}', TITLE_FIELD), {
    supported: false, reason: "Publisher is not stated.",
  });
  assert.equal(parseResourceFieldReply('Here is the result: {"suggestion":"Title","reason":"printed heading"}', TITLE_FIELD).suggestion, "Title");
  assert.equal(parseResourceFieldReply('{"suggestion":"Document, Questionnaire [doc/qst]","reason":"label"}', TYPE_FIELD).suggestion, "doc/qst", "exact label maps to stored value");
  assert.equal(parseResourceFieldReply('{"suggestion":"survey","reason":"near miss"}', TYPE_FIELD).supported, false, "unsupported choices cannot be filled");
  assert.throws(() => parseResourceFieldReply("not json", TITLE_FIELD), /no JSON object/);
  assert.throws(() => parseResourceFieldReply(JSON.stringify({ suggestion: "x".repeat(1001), reason: "r" }), TITLE_FIELD), /too long/);
});

test("each Draft call generates one flat suggestion for only the requested field", async () => {
  const calls = [];
  const ai = {
    async load(id) { calls.push({ load: id }); },
    async generate(messages, options) {
      calls.push({ messages, options });
      return { engine: "stub", text: JSON.stringify({ suggestion: "doc/qst", reason: "The text identifies this as a questionnaire." }) };
    },
  };
  const result = await suggestResourceField(ai, {
    source: "Metadata Editor", document: "The attached document is a questionnaire.".repeat(8), field: TYPE_FIELD, modelId: "m1",
  });
  assert.equal(result.formatValid, true);
  assert.equal(result.supported, true);
  assert.equal(result.task, SUGGEST_RESOURCE_TASK);
  assert.equal(calls.filter((call) => call.messages).length, 1, "one button press means one model generation");
  const [system, user] = calls.find((call) => call.messages).messages;
  assert.match(system.content, /suggestion and reason/);
  assert.match(user.content, /Field key: dctype/);
  assert.doesNotMatch(user.content, /Field key: title/);
  const options = calls.find((call) => call.options).options;
  assert.equal(options.maxTokens, 192);
  assert.equal(options.response_format.json_schema.schema.properties.suggestion.type, "string");
  assert.equal(options.response_format.json_schema.schema.properties.fields, undefined, "flat output, not an array of fields");
});

test("empty flat-schema reply retries once without grammar; second empty reply reports facts", async () => {
  const calls = [];
  const retrying = {
    async load() {},
    async generate(messages, options) {
      calls.push(options.response_format ? "flat grammar" : "plain");
      return { engine: "webgpu", text: calls.length === 1 ? "" : '{"suggestion":"SAR-GIL Policy Tools Mapping","reason":"Printed heading."}' };
    },
  };
  const result = await suggestResourceField(retrying, {
    source: "Metadata Editor", document: "x".repeat(200), field: TITLE_FIELD, modelId: "m1",
  });
  assert.deepEqual(calls, ["flat grammar", "plain"]);
  assert.equal(result.suggestion, "SAR-GIL Policy Tools Mapping");

  const silent = { async load() {}, async generate() { return { engine: "webgpu", text: "" }; } };
  const quiet = await suggestResourceField(silent, {
    source: "Metadata Editor", document: "x".repeat(200), field: TITLE_FIELD, modelId: "m1",
  });
  assert.equal(quiet.formatValid, false);
  assert.match(quiet.error, /no text for Title\. Prompt \d+ characters, grammar not used, engine webgpu/);
});

// The parser is vendored, so its bytes are the supply chain. This hash check runs on every `npm test`.
test("the vendored pdf.js is the file the manifest says it is", async () => {
  const manifest = JSON.parse(readFileSync("vendor/pdfjs/manifest.json", "utf8"));
  for (const [name, expected] of Object.entries(manifest.files)) {
    const bytes = readFileSync(`vendor/pdfjs/${name}`);
    assert.equal(bytes.length, expected.bytes, `${name} changed size`);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), expected.sha256,
      `${name} does not match vendor/pdfjs/manifest.json — re-vendor it deliberately, do not edit it`);
  }
});

test("outermost JSON extraction ignores model preamble without loosening field validation", () => {
  assert.equal(outermostJsonObject('Sure:\n{"suggestion":"v","reason":"r"}\nDone.'), '{"suggestion":"v","reason":"r"}');
});
