import { defaultTools } from "../src/tools.js";
import { TASKS } from "./tasks.js";

export function summary(rows) {
  const scores = {};
  for (const row of rows) {
    const s = scores[row.task] ??= { passed: 0, total: 0 };
    s.total++;
    if (row.passed) s.passed++;
  }
  return scores;
}

export async function runBenchmark(ai, modelId, { engine = "auto", previous = [], onStart, onResult, signal, tasks = TASKS } = {}) {
  if ((await ai.status(modelId)).state !== "installed") throw new Error("Install this model before benchmarking");
  const start = performance.now();
  const { engine: chosen } = await ai.load(modelId, { engine });
  const loadMs = Math.round(performance.now() - start);
  const rows = [...previous];
  const completed = new Set(previous.map((row) => row.id));
  const fixedDate = { ...defaultTools()[0], run: async () => ({ datetime: "2030-02-14T09:30:00.000Z" }) };
  for (const item of tasks) {
    signal?.throwIfAborted();
    if (completed.has(item.id)) continue;
    onStart?.(item, rows);
    const began = performance.now();
    let text = "";
    let passed = false;
    let error = null;
    let calls = [];
    let decodeTokS = null;
    try {
      if (item.task === "tool_call") {
        const r = await ai.runAgent(item.messages, {
          tools: [fixedDate], allowNetwork: false, maxTokens: 96,
          sampling: { temperature: 0, top_k: 1, seed: 42 }, signal,
          onTool: (event) => { if (event.stage === "call") calls.push(event.name); },
        });
        text = r.text;
      } else {
        const r = await ai.generate(item.messages, { maxTokens: 96, temperature: 0, top_k: 1, seed: 42, signal });
        text = r.text;
        decodeTokS = r.timings?.predicted_per_second ?? null;
      }
      passed = Boolean(item.check(text, calls));
    } catch (err) {
      if (signal?.aborted) throw err;
      error = String(err?.message ?? err);
    }
    const row = { id: item.id, task: item.task, passed, text: text.slice(0, 500), calls, error, ms: Math.round(performance.now() - began), decodeTokS };
    rows.push(row);
    onResult?.(row, rows);
  }
  return { model: modelId, sha256: ai.models[modelId].sha256, engine: chosen, loadMs, rows, scores: summary(rows) };
}
