// What exactly goes into the prompt, by part, for a real question against the site's corpus.
import { readdirSync, readFileSync } from "node:fs";
import { DEFAULT_CONTEXT, assistantSystemPrompt, composeContext, toolInstructions } from "./integrations/chat-core.js";
import { defaultTools } from "./src/tools.js";
import { buildIndex, chunkText, rankChunks, selectUnderCap } from "./src/retrieval.js";

const DIR = "../rafmacalaba.github.io/public/portable-slm/corpus";
const files = [];
for (const sub of ["", "work", "writing"]) {
  const d = sub ? `${DIR}/${sub}` : DIR;
  for (const f of readdirSync(d).filter((n) => n.endsWith(".md"))) files.push([sub ? `${sub}/${f}` : f, readFileSync(`${d}/${f}`, "utf8")]);
}
const index = buildIndex({ chunks: files.flatMap(([p, t]) => chunkText(t, { path: p, targetChars: 480 })) });

const QUESTIONS = [
  ["complex, in-corpus", "he built an orchestration tool for agent teams, how does it decide a phase is finished and what evidence does it need"],
  ["simple, in-corpus", "what did he build for agent orchestration"],
  ["off-corpus", "what is the capital of Peru"],
];
const tok = (s) => Math.round(s.length / 3.6); // rough, for share-of-prompt only

for (const [label, question] of QUESTIONS) {
  const ranked = rankChunks(index, question, { k: 5, minSimilarity: 0.1 });
  const { text: retrieved } = selectUnderCap(ranked, { maxBytes: 6144 });
  const identity = assistantSystemPrompt({ app: "Rafael Macalaba", context: "app", kind: "content" });
  const tools = toolInstructions(defaultTools(), { lfm: false });
  const composed = composeContext(retrieved).text;
  const parts = [
    ["identity + content instruction", identity],
    ["tool rules", tools],
    ["SDK self-description (DEFAULT_CONTEXT)", DEFAULT_CONTEXT],
    ["--- separator line", "--- context supplied by this application ---"],
    ["retrieved context", retrieved],
    ["keyword-only note", retrieved.match(/\n\[[^\]]*\]$/)?.[0] ?? ""],
  ];
  const total = identity.length + tools.length + composed.length + 4;
  console.log(`\n${label}: "${question.slice(0, 60)}"  (top section: ${ranked[0]?.chunk.heading ?? "none"})`);
  console.log(`  total ${total} chars, ~${tok(String(total))} tokens`);
  for (const [name, body] of parts) {
    if (!body) continue;
    const share = ((body.length / total) * 100).toFixed(0);
    console.log(`    ${String(share).padStart(3)}%  ${String(body.length).padStart(4)} chars  ${name}`);
  }
}
console.log("\n=== sentences repeated inside the composed instruction ===");
const tools = toolInstructions(defaultTools(), { lfm: false });
const sentences = tools.split(/(?<=\.)\s+/).map((x) => x.trim()).filter((x) => x.length > 25);
const counts = new Map();
for (const s of sentences) counts.set(s, (counts.get(s) ?? 0) + 1);
for (const [s, n] of counts) if (n > 1) console.log(`  x${n}: ${s.slice(0, 110)}`);
console.log(`  tool rules: ${sentences.length} sentences, ${tools.length} chars, ~${tok(tools)} tokens`);
console.log("\n=== DEFAULT_CONTEXT lines that are operational caveats, not identity ===");
for (const line of DEFAULT_CONTEXT.split("\n").filter((l) => l.trim().length > 40)) {
  if (/tool|network|endpoint|screen|save|publish|refuse|refus/i.test(line)) console.log(`  ${line.trim().slice(0, 120)}`);
}
