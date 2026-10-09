// Retrieval quality on the site's own corpus, as it stands today. No generator model needed: this measures
// the half that decides what the model gets, which is what the user is asking about.
import { readdirSync, readFileSync } from "node:fs";
import { embed, cosineSim } from "@ternlight/base";
import { buildIndex, chunkText, rankChunks } from "./src/retrieval.js";

const DIR = "../rafmacalaba.github.io/public/portable-slm/corpus";
const APP = "/portable-slm/corpus/about.md";
const files = [];
for (const sub of ["", "work", "writing"]) {
  const d = sub ? `${DIR}/${sub}` : DIR;
  for (const f of readdirSync(d).filter((n) => n.endsWith(".md"))) files.push([sub ? `${sub}/${f}` : f, readFileSync(`${d}/${f}`, "utf8")]);
}
// about.md is the always-present application description, excluded from the index by URL.
const indexed = files.filter(([p]) => p !== "about.md");
const chunks = buildIndex({ chunks: indexed.flatMap(([p, t]) => chunkText(t, { path: p, targetChars: 480 })) }).chunks;
const DIMS = 384;
const vectors = new Float32Array(chunks.length * DIMS);
chunks.forEach((c, i) => vectors.set(embed(c.text), i * DIMS));
const index = buildIndex({ chunks, vectors, dims: DIMS, embedderId: "ternlight-base", corpusVersion: "eval" });

// Questions a visitor would ask, with the document that plainly answers each.
const { execSync } = await import("node:child_process");
void execSync;
const IN = [
  ["term", "what did he build for agent orchestration", ["work/armada.md", "writing/armada-intro.md"]],
  ["term", "how does armada decide a phase is finished and what evidence does it need", ["writing/armada-intro.md", "work/armada.md"]],
  ["term", "what is GLiNER used for", ["work/gliner.md"]],
  ["term", "tell me about the data360 chatbot", ["work/data360-chatbot.md"]],
  ["term", "what is the data360 mcp server", ["work/data360-mcp.md"]],
  ["term", "what is fastquant", ["work/fastquant.md"]],
  ["term", "what is proof-carrying numbers", ["work/pcn.md"]],
  ["term", "what is phoenix about", ["work/phoenix.md"]],
  ["term", "what is ai4data", ["work/ai4data.md"]],
  ["term", "what is he working on now", ["now.md"]],
  ["term", "has he written about synthetic data for dataset mentions", ["writing/arxiv-2502-10263.md"]],
  ["term", "paper about field order and permutation invariance", ["writing/arxiv-2606-30473.md"]],
  ["term", "does he have a climate change paper", ["writing/climate-change-ai-iclr2025.md"]],
  ["term", "tracking dataset use at scale", ["writing/wb-tracking-dataset-use.md"]],
  ["term", "monitoring and classifying data used in research", ["writing/arxiv-2605-30582.md"]],
  ["paraphrase", "software that refuses to move on until the evidence is there", ["writing/armada-intro.md", "work/armada.md"]],
  ["paraphrase", "how does his tool stop agents from editing the same file differently", ["writing/armada-intro.md", "work/armada.md"]],
  ["paraphrase", "does he work on making models run on the device instead of a server", ["about.md", "work/gliner.md", "writing/arxiv-2605-30582.md"]],
  ["paraphrase", "what does he do about measuring how data gets reused", ["writing/wb-tracking-dataset-use.md", "writing/arxiv-2502-10263.md"]],
  ["paraphrase", "a tool for coordinating several AI agents on one coding task", ["work/armada.md", "writing/armada-intro.md"]],
];
const OUT = ["what is the capital of Peru", "how do I bake sourdough", "who won the 1998 world cup", "explain quantum tunnelling", "price of copper today", "how do I fix a leaking tap", "best pizza in Rome"];

const rankOf = (ranked, want) => {
  const at = ranked.findIndex((r) => want.includes(r.chunk.path));
  return at < 0 ? Infinity : at + 1;
};
const run = (question, alpha, minSimilarity) => {
  const qv = alpha > 0 ? embed(question) : undefined;
  return rankChunks(index, question, { k: chunks.length, alpha, queryVector: qv, minSimilarity });
};

for (const [name, alpha, floor] of [["keyword only (BM25)", 0, 0], ["hybrid 50/50", 0.5, 0.1]]) {
  const ranks = IN.map(([, q, want]) => rankOf(run(q, alpha, floor), want));
  const at = (k) => ranks.filter((r) => r <= k).length;
  const byKind = (kind) => {
    const idx = IN.map((x, i) => [x[0], i]).filter(([k]) => k === kind).map(([, i]) => i);
    return { n: idx.length, top1: idx.filter((i) => ranks[i] === 1).length, top3: idx.filter((i) => ranks[i] <= 3).length };
  };
  const term = byKind("term"), par = byKind("paraphrase");
  const none = IN.map(([, q], i) => [q, ranks[i]]).filter(([, r]) => r === Infinity).length;
  const outTop = OUT.map((q) => run(q, alpha, floor)[0]?.semantic ?? 0);
  console.log(`\n${name}`);
  console.log(`  in-corpus   top-1 ${at(1)}/${IN.length}   top-3 ${at(3)}/${IN.length}   not retrieved at all ${none}`);
  console.log(`    term questions      top-1 ${term.top1}/${term.n}  top-3 ${term.top3}/${term.n}`);
  console.log(`    paraphrase          top-1 ${par.top1}/${par.n}  top-3 ${par.top3}/${par.n}`);
  if (alpha > 0) console.log(`  off-corpus  sections returned: ${outTop.filter((s) => s >= floor).length}/${OUT.length} (0 is correct)`);
  console.log("  misses:");
  IN.forEach(([kind, q, want], i) => {
    if (ranks[i] === 1) return;
    const got = run(q, alpha, floor)[0]?.chunk.path ?? "-";
    console.log(`    ${kind.padEnd(10)} rank ${String(ranks[i] === Infinity ? "-" : ranks[i]).padStart(2)}  "${q.slice(0, 52)}"\n        wanted ${want[0]}, got ${got}`);
  });
}
console.log(`\ncorpus: ${indexed.length} documents, ${chunks.length} chunks (about.md excluded: always in the prompt)`);
void cosineSim;
