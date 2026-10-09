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
import { buildCorpusIndex, createRetrievalContext, indexParams } from "../integrations/retrieval-context.js";
import { buildIndex, chunkText, serializeIndex } from "../src/retrieval.js";
import { DEFAULTS } from "../src/models.js";

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

/**
 * Build the prebuilt artifact with the real default embedder. ternlight runs in Node as well as the browser,
 * so the artifact is produced by the same model the browser will use to embed the question, and the whole
 * path is exercised with nothing faked and nothing large downloaded.
 */
async function prebuiltIndex() {
  const { embed } = await import("@ternlight/base");
  const { chunks: chunkChars, dims, embedderId } = indexParams(DEFAULTS.embedder, {});
  const chunks = chunkText(CORPUS, { path: "Handbook", targetChars: chunkChars });
  const vectors = new Float32Array(chunks.length * dims);
  chunks.forEach((chunk, i) => vectors.set(embed(chunk.text), i * dims));
  return serializeIndex(buildIndex({ chunks, vectors, dims, embedderId, corpusVersion: CORPUS_VERSION, chunkChars }));
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
writeFileSync(join(FIXTURE, "pslm.index.json"), prebuilt);
console.log(`prebuilt index: built with ${DEFAULTS.embedder}, ${(prebuilt.length / 1024).toFixed(0)} KB, no download\n`);

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

    // One provider per page, held open, so the background upgrade to embeddings is observed rather than
    // restarted. No embedder is injected: this is the default tier doing the work.
    const ask = (question) => page.evaluate(async (q) => {
      const mod = await import("./embed.js");
      const name = location.pathname.includes("bm25") ? "bm25.host.json" : "portable-slm.host.json";
      const declared = await (await fetch(`./${name}`)).json();
      // The embedder has to be handed over: without one the provider is BM25-only by design, and the
      // disclosure says so. The panel passes its own; a bare caller has to pass this one.
      globalThis.__pslmProvider ??= mod.createRetrievalContext({
        manifest: declared, base: location.href, embedder: mod.createEmbedder({}),
      });
      const provider = globalThis.__pslmProvider;
      const ready = await provider.ready();
      // Wait for the embedding upgrade, which the bundled runtime finishes in milliseconds.
      for (let i = 0; i < 60 && provider.source !== "embedded" && provider.source !== "prebuilt"; i++) {
        await new Promise((r) => setTimeout(r, 50));
        if (provider.source !== "bm25") break;
      }
      return { source: provider.source, note: ready.note, context: await provider.onContext(q) };
    }, question);

    const first = await ask("house_hold_id");
    check(`[${label}] an identifier is retrieved and labelled`, /^### Identifiers\n[\s\S]*house_hold_id/.test(first.context));
    check(`[${label}] the context is a selection, not the document`, (first.context.match(/^### /gm) || []).length < 8);

    // The real thing: a question sharing no words with the corpus, answered by the bundled embedder, in a
    // browser, with nothing downloaded and no stand-in.
    const semantic = await ask("how long before I can read it");
    check(`[${label}] a paraphrase reaches the section that shares no words`, /twelve months after deposit/.test(semantic.context), `source=${semantic.source}`);
    check(`[${label}] and does not drag in unrelated sections`, !/house_hold_id|Write to the data team/.test(semantic.context));

    const off = await ask("how do I bake sourdough bread");
    check(`[${label}] a question the corpus does not cover yields nothing`, off.context.length === 0, `bytes=${off.context.length}`);

    if (expectSource === "prebuilt") {
      check(`[${label}] the artifact is used as shipped`, semantic.source === "prebuilt", `source=${semantic.source}`);
    } else {
      check(`[${label}] with no artifact the browser indexes the corpus itself`, semantic.source === "embedded", `source=${semantic.source}`);
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
