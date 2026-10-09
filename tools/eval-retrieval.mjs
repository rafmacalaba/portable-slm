// Measure retrieval against a fixed set of questions with known answers.
//
// This is the artifact that decides retrieval policy. Every claim about chunk size, the hybrid weight or the
// similarity floor should come from here rather than from a single question that happened to fail, which is
// how the floor was set too low once already.
//
// Usage: node tools/eval-retrieval.mjs <corpus-dir> [questions.json]
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { embed } from "@ternlight/base";
import { buildIndex, chunkText, rankChunks, tokenize } from "../src/retrieval.js";

const dir = resolve(process.argv[2] ?? "");
if (!dir) {
  console.error("usage: node tools/eval-retrieval.mjs <corpus-dir> [questions.json]");
  process.exit(2);
}
const spec = JSON.parse(readFileSync(process.argv[3] ?? new URL("./eval/retrieval-questions.json", import.meta.url), "utf8"));

const files = [];
for (const sub of ["", "work", "writing"]) {
  const d = sub ? join(dir, sub) : dir;
  for (const name of readdirSync(d).filter((n) => n.endsWith(".md"))) {
    files.push([sub ? `${sub}/${name}` : name, readFileSync(join(d, name), "utf8")]);
  }
}
// The manifest names the application document as a URL; the corpus lists it as a path. Compare the tail so
// either spelling excludes it, or the always-present document competes in the ranking it should not be in.
const excluded = spec.excludedFromIndex ?? "";
const isExcluded = (p) => Boolean(excluded) && (p === excluded || excluded.endsWith(`/${p}`));
const indexed = files.filter(([p]) => !isExcluded(p));
const chunks = buildIndex({ chunks: indexed.flatMap(([p, t]) => chunkText(t, { path: p, targetChars: 480 })) }).chunks;
const dims = 384;
const vectors = new Float32Array(chunks.length * dims);
chunks.forEach((chunk, i) => vectors.set(embed(chunk.text), i * dims));
const index = buildIndex({ chunks, vectors, dims, embedderId: "ternlight-base", corpusVersion: "eval" });

const rank = (question, alpha, floor, wanted) => {
  const ranked = rankChunks(index, question, { k: chunks.length, alpha, queryVector: alpha > 0 ? embed(question) : undefined, minSimilarity: floor });
  const at = ranked.findIndex((r) => wanted.includes(r.chunk.path));
  return { rank: at < 0 ? Infinity : at + 1, returned: ranked.length };
};

console.log(`corpus: ${indexed.length} documents, ${chunks.length} chunks`);
if (excluded) console.log(`excluded from ranking: ${excluded} (supplied always, unranked)`);
console.log();
console.log("questions that are not paraphrases:");
for (const [q, want] of spec.paraphrase) {
  const shared = [...new Set(tokenize(q))].filter((t) => new Set(tokenize(indexed.find(([f]) => f === want[0])[1])).has(t));
  if (shared.length) console.log(`  shares ${shared.join(", ")} with ${want[0]}  "${q.slice(0, 48)}"`);
}

const settings = [["keyword only", 0, 0], ["hybrid 0.10", 0.5, 0.1], ["hybrid 0.20", 0.5, 0.2], ["hybrid 0.30", 0.5, 0.3], ["hybrid 0.40", 0.5, 0.4]];
console.log("\nsetting                term top-1   paraphrase top-1 / top-3   off-corpus returning something");
for (const [name, alpha, floor] of settings) {
  const term = spec.term.map(([q, want]) => rank(q, alpha, floor, want));
  const para = spec.paraphrase.map(([q, want]) => rank(q, alpha, floor, want));
  const off = spec.offCorpus.filter((q) => rank(q, alpha, floor, []).returned > 0).length;
  const pct = (n, d) => `${n}/${d}`.padEnd(5);
  console.log(`${name.padEnd(22)} ${pct(term.filter((r) => r.rank === 1).length, term.length)}        ${pct(para.filter((r) => r.rank === 1).length, para.length)} / ${pct(para.filter((r) => r.rank <= 3).length, para.length)}          ${off}/${spec.offCorpus.length}`);
}
