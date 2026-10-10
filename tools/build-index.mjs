// Freeze a corpus into a prebuilt index, so a reader never pays to embed it.
//
//   npm run index -- <corpus-dir> --out <file> [--tier ternlight-base] [--corpus-version <string>]
//
// Why this exists: indexing is minutes, not milliseconds, at documentation scale. Measured on a 1.9 MB corpus
// of a host's guides, the bundled encoder ran at 44 chunks per second, so 4,264 chunks was 96 seconds in a
// browser. Frozen, that becomes a file fetch, and the artifact is reviewable in a diff.
//
// The artifact is keyed by the hash of the corpus it was built from, so the runtime refuses it the moment the
// corpus changes, whether or not the host remembered to bump `corpusVersion`. Run this again after editing the
// corpus; nothing else needs to know.
//
// `--corpus-version` is therefore optional and defaults to "0". Pass it only if the manifest declares the same
// string: the value is a second thing to keep in sync, and getting it wrong makes the artifact silently
// refused, which is a fall back to keyword search rather than an error. The hash is the part that cannot be
// forgotten.
//
// Only the bundled tier can be frozen here, because it ships inside the package. The ONNX tier needs the
// browser's ORT assets and a downloaded model, so a build machine would have to reproduce that path; use the
// browser to build those, or add it here deliberately.
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { buildIndex, chunkText, corpusHash, serializeIndex } from "../src/retrieval.js";
import { embedDims } from "../src/embedder.js";
import { DEFAULTS, MODELS } from "../src/models.js";

const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith("--"));
const value = (flag) => { const at = args.indexOf(flag); return at >= 0 ? args[at + 1] : undefined; };
if (!dir) {
  console.error("usage: npm run index -- <corpus-dir> --out <file> [--tier ternlight-base] [--corpus-version <string>]");
  process.exit(2);
}
const out = value("--out");
if (!out) {
  console.error("--out <file> is required: a frozen index has to be written somewhere a host can serve it");
  process.exit(2);
}
const tier = value("--tier") ?? DEFAULTS.embedder;
const spec = MODELS[tier];
if (!spec || spec.kind !== "embedding") {
  console.error(`--tier must be an embedding model from the catalogue; known: ${Object.entries(MODELS).filter(([, s]) => s.kind === "embedding").map(([id]) => id).join(", ")}`);
  process.exit(2);
}
if (spec.runtime !== "ternlight") {
  console.error(`${tier} is the ${spec.runtime} runtime: freezing it needs the ONNX Runtime assets and a local model, which this tool does not do yet`);
  process.exit(2);
}

/** Every text file under a directory, as documents. One file is one document, and its path is its label. */
function readCorpus(root) {
  const found = [];
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    if (statSync(path).isDirectory()) found.push(...readCorpus(path));
    else if (/\.(md|markdown|txt)$/i.test(name)) found.push({ path: relative(root, path), text: readFileSync(path, "utf8") });
  }
  return found.sort((a, b) => a.path.localeCompare(b.path));
}

const corpus = readCorpus(resolve(dir));
if (!corpus.length) {
  console.error(`no .md, .markdown or .txt files under ${resolve(dir)}`);
  process.exit(1);
}

const dims = embedDims(spec, spec.dims);
const chunkChars = spec.chunkChars;
const chunks = corpus.flatMap((doc) => chunkText(doc.text, { path: doc.path, targetChars: chunkChars }));
const contentHash = corpusHash(corpus);
const { embed } = await import(spec.package);

const started = Date.now();
const vectors = new Float32Array(chunks.length * dims);
for (let start = 0; start < chunks.length; start += 8) {
  const batch = chunks.slice(start, start + 8);
  batch.forEach((chunk, i) => vectors.set(embed(chunk.text), (start + i) * dims));
}
const seconds = (Date.now() - started) / 1000;

const corpusVersion = value("--corpus-version") ?? "0";
const index = buildIndex({ chunks, vectors, dims, embedderId: tier, corpusVersion, chunkChars, contentHash });
const json = serializeIndex(index);
writeFileSync(resolve(out), json);

console.log(`frozen -> ${resolve(out)}`);
console.log(`  ${corpus.length} documents, ${chunks.length} chunks at ${chunkChars} chars, ${dims} dims`);
console.log(`  embedded in ${seconds.toFixed(0)} s (${(chunks.length / seconds).toFixed(0)} chunks/s), artifact ${(json.length / 1048576).toFixed(1)} MB`);
console.log(`  key ${index.key}`);
console.log(`  a reader now fetches this instead of embedding ${chunks.length} chunks`);
