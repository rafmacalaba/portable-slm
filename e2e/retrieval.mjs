// End-to-end retrieval, in real Chrome against a real origin, checking what actually reaches the prompt.
//
// Usage: npm run e2e:retrieval
//   CHROME_PATH=...            override the browser
//   PSLM_LOCAL_MODEL=/path     a directory holding the pinned embedder (config.json, tokenizer.json, the
//                              q4f16 onnx graph and its _data), used to build a real prebuilt index. Without
//                              it the prebuilt checks are skipped and the BM25 path is still verified.
//
// The fixture is generated here rather than committed, so the corpus, the manifests and the artifact cannot
// drift from the assertions. The embedder itself is exercised against real weights in test/, and the query
// half is exercised here with a deterministic stand-in: downloading 181 MB into a test profile would test
// the network rather than the wiring.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import puppeteer from "puppeteer-core";
import { buildCorpusIndex, createRetrievalContext } from "../integrations/retrieval-context.js";
import { buildIndex, chunkText, matryoshka, serializeIndex } from "../src/retrieval.js";
import { DEFAULTS, EMBEDDING_PREFIXES } from "../src/models.js";

const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = Number(process.env.PORT ?? 8799);
const FIXTURE = join(process.env.TMPDIR ?? "/tmp", "pslm-retrieval-fixture");
const DIMS = 256;
const CORPUS_VERSION = "2026-10-09";

const CORPUS = `# Data handbook

## Release timing
Records under an embargo become public twelve months after deposit. A curator may ask for an extension, which the board reviews each quarter.

## Identifiers
The household identifier is stored as house_hold_id. Population counts are stored as HHID_POP.

## Contact
Write to the data team for anything not covered here.

## File formats
Deliverables are distributed as CSV and Stata files, with a codebook in PDF.

## Citation
Cite the study by its title and year, and link to the landing page rather than the file.

## Embargo exceptions
A depositor may request a shorter embargo where the data are already public elsewhere.

## Quality checks
Every release passes range, consistency and missing-value checks before publication.

## Versioning
A new version is published when values change; the previous version stays available.
`;

const manifest = (withIndex) => ({
  apiVersion: "pslm-host/1",
  app: { name: "Fixture App", version: "1.0.0" },
  context: {
    app: { url: "handbook.md", maxBytes: 8192, kind: "content" },
    documents: [{ url: "handbook.md", label: "Handbook" }],
    credentials: "none",
  },
  retrieval: { corpusVersion: CORPUS_VERSION, dims: DIMS, alpha: 0.5, topK: 3, maxBytes: 4096, ...(withIndex ? { index: "/pslm.index.json" } : {}) },
  tasks: ["pslm.chat"],
  writeBack: false,
});

const page_ = (name) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${name}</title></head>
<body><h1>Fixture</h1>
<div data-pslm data-manifest="./${name}" data-launcher="Ask this page"></div>
<script type="module" src="./embed.js"></script></body></html>`;

/** Build a real prebuilt artifact when the pinned embedder is available locally. */
async function prebuiltIndex() {
  const dir = process.env.PSLM_LOCAL_MODEL;
  if (!dir || !existsSync(join(dir, "onnx", "model_q4f16.onnx"))) return null;
  const { AutoModel, AutoTokenizer, env } = await import("@huggingface/transformers");
  env.allowLocalModels = true;
  env.allowRemoteModels = false;
  env.localModelPath = dir.slice(0, dir.lastIndexOf("/")) || "/";
  env.useBrowserCache = false;
  env.useFSCache = false;
  const id = dir.slice(dir.lastIndexOf("/") + 1);
  const chunks = chunkText(CORPUS, { path: "Handbook" });
  const tokenizer = await AutoTokenizer.from_pretrained(id, { revision: "local" });
  const model = await AutoModel.from_pretrained(id, { dtype: "q4f16", subfolder: "onnx", device: "cpu" });
  const encoded = await tokenizer(chunks.map((chunk) => EMBEDDING_PREFIXES.document(chunk.heading, chunk.text)), { padding: true, truncation: true, max_length: 8192 });
  const out = await model({ input_ids: encoded.input_ids, attention_mask: encoded.attention_mask });
  const [count, width] = out.sentence_embedding.dims;
  const vectors = new Float32Array(count * DIMS);
  for (let i = 0; i < count; i++) vectors.set(matryoshka(out.sentence_embedding.data.subarray(i * width, (i + 1) * width), DIMS), i * DIMS);
  return serializeIndex(buildIndex({ chunks, vectors, dims: DIMS, embedderId: DEFAULTS.embedder, corpusVersion: CORPUS_VERSION }));
}

const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok }); console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` -- ${detail}` : ""}`); };

if (!existsSync("dist/embed.js")) {
  console.error("no built bundle: run `npm run build:embed` first");
  process.exit(1);
}
rmSync(FIXTURE, { recursive: true, force: true });
mkdirSync(FIXTURE, { recursive: true });
for (const name of ["embed.js", "embed-assets.json"]) {
  writeFileSync(join(FIXTURE, name), readFileSync(join("dist", name)));
}
const assets = JSON.parse(readFileSync("dist/embed-assets.json", "utf8"));
for (const path of Object.values(assets)) {
  const rel = path.replace(/^\.\//, "");
  mkdirSync(join(FIXTURE, rel.split("/").slice(0, -1).join("/") || "."), { recursive: true });
  writeFileSync(join(FIXTURE, rel), readFileSync(join("dist", rel)));
}
// Every chunk, rather than the ones a regex can see: the bundle reaches its chunks with dynamic
// import(), which has no `from "..."` form to match, and a missing chunk fails the mount silently.
for (const name of readdirSync("dist").filter((f) => f.endsWith(".js"))) {
  writeFileSync(join(FIXTURE, name), readFileSync(join("dist", name)));
}
writeFileSync(join(FIXTURE, "handbook.md"), CORPUS);
writeFileSync(join(FIXTURE, "portable-slm.host.json"), JSON.stringify(manifest(true), null, 2));
writeFileSync(join(FIXTURE, "bm25.host.json"), JSON.stringify(manifest(false), null, 2));
writeFileSync(join(FIXTURE, "host.html"), page_("portable-slm.host.json"));
writeFileSync(join(FIXTURE, "host-bm25.html"), page_("bm25.host.json"));

const prebuilt = await prebuiltIndex();
if (prebuilt) writeFileSync(join(FIXTURE, "pslm.index.json"), prebuilt);
console.log(prebuilt ? "prebuilt index: built from the local pinned embedder" : "prebuilt index: PSLM_LOCAL_MODEL not set, skipping those checks\n");

// The provider itself, without a browser, so a failure says whether it is the ranker or the DOM.
{
  const provider = createRetrievalContext({
    manifest: manifest(!!prebuilt), base: "https://fixture.example/",
    fetch: async (url) => new Response(String(url).endsWith(".json") ? prebuilt ?? "" : CORPUS, { status: 200, headers: { "content-type": "text/plain" } }),
  });
  const { note } = await provider.ready();
  check("the provider reports its source before any browser", Boolean(note), note);
}

const server = spawn("python3", ["-m", "http.server", String(PORT), "--bind", "127.0.0.1", "--directory", FIXTURE], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 900));
const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new", args: ["--no-sandbox", "--disable-dev-shm-usage"] });

try {
  for (const [file, label, expectSource] of [["host.html", "prebuilt artifact", "prebuilt"], ["host-bm25.html", "no artifact", "bm25"]]) {
    const page = await browser.newPage();
    await page.setCacheEnabled(false); // dist ships without Cache-Control; a stale bundle would invalidate this
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => { if (m.type() === "error" && !/status of 404/.test(m.text())) errors.push(m.text()); });
    await page.goto(`http://127.0.0.1:${PORT}/${file}`, { waitUntil: "networkidle2" });
    await page.waitForFunction(() => document.querySelector("[data-pslm] .state")?.textContent?.trim(), { timeout: 15000 });

    const disclosure = await page.evaluate(() => document.querySelector(".state").title);
    check(`[${label}] the panel discloses retrieval as the source`, /retrieved from this application's own documents/.test(disclosure));

    const ask = (question, withEmbedder = false) => page.evaluate(async (q, useEmbedder) => {
      const mod = await import("./embed.js");
      const name = location.pathname.includes("bm25") ? "bm25.host.json" : "portable-slm.host.json";
      const declared = await (await fetch(`./${name}`)).json();
      let loaded = null;
      const fake = useEmbedder ? {
        status: async () => ({ state: "installed" }),
        load: async () => { loaded = { dims: 768, device: "wasm" }; return {}; },
        get loaded() { return loaded; },
        embed: async (texts, { kind }) => (Array.isArray(texts) ? texts : [texts]).map((text) => {
          const v = new Float32Array(256);
          v[kind === "query" ? (/read|public|wait/.test(text) ? 0 : 1) : (/embargo|twelve months|board/.test(text) ? 0 : 1)] = 1;
          return v;
        }),
      } : null;
      const provider = mod.createRetrievalContext({ manifest: declared, base: location.href, embedder: fake });
      const ready = await provider.ready();
      if (useEmbedder) await fake.load();
      return { source: provider.source, note: ready.note, context: await provider.onContext(q) };
    }, question, withEmbedder);

    const keyword = await ask("house_hold_id");
    check(`[${label}] an identifier is retrieved and labelled`, /^### Identifiers\n[\s\S]*house_hold_id/.test(keyword.context));

    const sections = (keyword.context.match(/^### /gm) || []).length;
    check(`[${label}] the context is a selection, not the document`, sections <= 3 && sections < 8, `${sections} of 8 sections cited`);

    const off = await ask("what is the capital of Peru");
    check(`[${label}] a question the corpus does not cover yields nothing`, off.context.length === 0, `bytes=${off.context.length}`);

    if (expectSource === "prebuilt" && prebuilt) {
      const semantic = await ask("how long before I can read it", true);
      check(`[${label}] with an embedder, a paraphrase reaches the section that shares no words`, /twelve months after deposit/.test(semantic.context));
      check(`[${label}] and does not drag in unrelated sections`, !/house_hold_id|Write to the data team/.test(semantic.context));
    } else {
      const semantic = await ask("how long before I can read it");
      // Honest limitation: a prebuilt artifact removes the corpus embedding cost, not the query cost, so
      // without the embedder a question sharing no words with the corpus retrieves nothing.
      check(`[${label}] a pure paraphrase finds nothing without a query embedder`, !/twelve months/.test(semantic.context));
      check(`[${label}] the disclosure says it is keyword-only`, /keyword search only/.test(semantic.note || ""));
    }

    check(`[${label}] no page errors`, errors.length === 0, errors.slice(0, 1).join(""));
    await page.close();
  }
} finally {
  await browser.close();
  server.kill();
  rmSync(FIXTURE, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} pass, ${failed.length} fail`);
assert.equal(failed.length, 0, `${failed.length} retrieval check(s) failed`);
