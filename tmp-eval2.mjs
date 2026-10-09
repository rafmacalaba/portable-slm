// True paraphrase: questions that share NO content token with the document that answers them, verified
// rather than asserted. Plus off-corpus questions, to price what the semantic half adds and what it costs.
import { readdirSync, readFileSync } from "node:fs";
import { embed } from "@ternlight/base";
import { buildIndex, chunkText, rankChunks, tokenize } from "./src/retrieval.js";

const DIR = "../rafmacalaba.github.io/public/portable-slm/corpus";
const files = [];
for (const sub of ["", "work", "writing"]) {
  const d = sub ? `${DIR}/${sub}` : DIR;
  for (const f of readdirSync(d).filter((n) => n.endsWith(".md"))) files.push([sub ? `${sub}/${f}` : f, readFileSync(`${d}/${f}`, "utf8")]);
}
const indexed = files.filter(([p]) => p !== "about.md");
const chunks = buildIndex({ chunks: indexed.flatMap(([p, t]) => chunkText(t, { path: p, targetChars: 480 })) }).chunks;
const DIMS = 384;
const vectors = new Float32Array(chunks.length * DIMS);
chunks.forEach((c, i) => vectors.set(embed(c.text), i * DIMS));
const index = buildIndex({ chunks, vectors, dims: DIMS, embedderId: "ternlight-base", corpusVersion: "eval2" });

// Each question deliberately avoids the vocabulary of its target document.
const PARA = [
  ["a supervisor that halts progress until the required proof is handed over", "writing/armada-intro.md"],
  ["software that stops assistants from clobbering one another's edits", "writing/armada-intro.md"],
  ["which of his projects recognises proper nouns in documents", "work/gliner.md"],
  ["a conversational interface onto a statistical platform", "work/data360-chatbot.md"],
  ["did he publish anything about global warming", "writing/climate-change-ai-iclr2025.md"],
  ["does he study how often datasets get cited or reused", "writing/wb-tracking-dataset-use.md"],
  ["why the sequence of columns in a table should not change the outcome", "writing/arxiv-2606-30473.md"],
  ["his work on guarantees attached to numeric results", "work/pcn.md"],
  ["making quantitative investing research quicker", "work/fastquant.md"],
  ["a paper about fabricating records to find where data is named", "writing/arxiv-2502-10263.md"],
];
const OUT = ["what is the capital of Peru", "how do I bake sourdough", "who won the 1998 world cup", "explain quantum tunnelling", "price of copper today", "how do I fix a leaking tap", "best pizza in Rome", "how do I train for a marathon"];

const docTokens = (p) => new Set(tokenize(indexed.find(([f]) => f === p)[1]));
console.log("overlap check (a real paraphrase shares no content token with its target):");
for (const [q, want] of PARA) {
  const shared = [...new Set(tokenize(q))].filter((t) => docTokens(want).has(t));
  console.log(`  ${shared.length === 0 ? "clean" : "SHARES " + shared.join(",")}  ${q.slice(0, 54)} -> ${want}`);
}

const rankOf = (ranked, want) => {
  const at = ranked.findIndex((r) => r.chunk.path === want);
  return at < 0 ? Infinity : at + 1;
};
const run = (q, alpha, floor) => rankChunks(index, q, { k: chunks.length, alpha, queryVector: alpha > 0 ? embed(q) : undefined, minSimilarity: floor });

for (const [name, alpha, floor] of [["keyword only", 0, 0], ["hybrid, floor 0.10", 0.5, 0.1], ["hybrid, floor 0.20", 0.5, 0.2], ["hybrid, floor 0.30", 0.5, 0.3]]) {
  const ranks = PARA.map(([q, want]) => rankOf(run(q, alpha, floor), want));
  const top1 = ranks.filter((r) => r === 1).length;
  const top3 = ranks.filter((r) => r <= 3).length;
  const out = OUT.filter((q) => run(q, alpha, floor).length > 0).length;
  console.log(`${name.padEnd(20)} paraphrase top-1 ${top1}/10  top-3 ${top3}/10   ·   off-corpus returning something ${out}/8 (0 is correct)`);
}
console.log("\nper-question, hybrid at floor 0.10 vs keyword:");
PARA.forEach(([q, want]) => {
  const k = rankOf(run(q, 0, 0), want), h = rankOf(run(q, 0.5, 0.1), want);
  console.log(`  keyword ${String(k === Infinity ? "-" : k).padStart(2)}  hybrid ${String(h === Infinity ? "-" : h).padStart(2)}   ${q.slice(0, 50)}`);
});
