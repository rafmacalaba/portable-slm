import { runBenchmark, summary } from "../bench/run.js";
import { TASKS } from "../bench/tasks.js";

// Same benchmark component in standalone /benchmark.html and inside the HF-embedded chat shell.
export function mountBenchmark(root, ai, { embedded = false } = {}) {
  root.innerHTML = `
    <h2>General-task benchmark</h2>
    <p>Runs 12 short, authored fixtures on this device—classification, JSON extraction, grounded QA, instruction following and a fixture-based tool call. No prompts leave the device. A small smoke comparison, not a published quality leaderboard.</p>
    ${embedded ? "" : '<p><a href="./">Chat / model manager</a> · <a href="./catalogue-qa.html">Catalogue Q&amp;A</a> · <a href="./field-suggest.html">Field suggestion</a></p>'}
    <label>Installed model <select id="model"></select></label>
    <label>Engine <select id="engine"><option value="auto">Automatic</option><option value="cpu">CPU</option><option value="webgpu">WebGPU</option></select></label>
    <button id="run" type="button">Run / resume benchmark</button><button id="export" type="button" disabled>Export JSON</button><button id="reset" type="button">Reset results</button>
    <p id="status" role="status" aria-live="polite">Checking model…</p>
    <div class="scroll"><table><thead><tr><th>Task</th><th>Passed</th><th>Total</th></tr></thead><tbody id="scores"></tbody></table></div>
    <p id="progress"></p>
    <h2>Saved model comparisons</h2>
    <p>Run the same fixtures once per installed model, then compare scores here. Counts show passed / attempted, not a general quality rating.</p>
    <div class="scroll"><table><thead><tr><th>Model</th><th>Engine</th><th>Passed / attempted</th></tr></thead><tbody id="compare"></tbody></table></div>`;
  const $ = (id) => root.querySelector(`#${id}`);
  for (const [id, m] of Object.entries(ai.models)) $("model").add(new Option(m.label, id));
  $("model").value = "lfm2.5-350m-q4km";
  const key = () => `portable-slm-bench-v1:${$("model").value}:${$("engine").value}`;
  const saved = () => { try { return JSON.parse(localStorage.getItem(key())) ?? { rows: [] }; } catch { return { rows: [] }; } };
  const persist = (state) => { try { localStorage.setItem(key(), JSON.stringify(state)); } catch { /* export still possible */ } };
  let result = null;
  let running = false;

  function renderComparisons() {
    const rows = [];
    for (const [id, model] of Object.entries(ai.models)) {
      for (const engine of ["auto", "cpu", "webgpu"]) {
        let report;
        try { report = JSON.parse(localStorage.getItem(`portable-slm-bench-v1:${id}:${engine}`)); } catch { continue; }
        if (!report?.rows?.length) continue;
        const tr = document.createElement("tr");
        const passed = report.rows.filter((r) => r.passed).length;
        for (const value of [model.label, report.engine ?? `${engine} (unconfirmed)`, `${passed} / ${report.rows.length}`]) {
          tr.append(Object.assign(document.createElement("td"), { textContent: value }));
        }
        rows.push(tr);
      }
    }
    $("compare").replaceChildren(...rows);
  }

  function render(state) {
    const scores = summary(state.rows);
    $("scores").replaceChildren(...Object.entries(scores).map(([task, { passed, total }]) => {
      const tr = document.createElement("tr");
      for (const value of [task, passed, total]) tr.append(Object.assign(document.createElement("td"), { textContent: String(value) }));
      return tr;
    }));
    $("progress").textContent = `${state.rows.length} / ${TASKS.length} examples done${state.pending ? ` (last interrupted: ${state.pending})` : ""}`;
    $("export").disabled = !state.rows.length;
    renderComparisons();
  }
  async function refresh() {
    const s = await ai.status($("model").value);
    if (!root.isConnected) return;
    $("status").textContent = s.state === "installed" ? "Model installed. Benchmark runs locally, including in airplane mode." : "Install this model on the Chat page first.";
    $("run").disabled = s.state !== "installed";
    const state = saved();
    if (state.pending && !state.rows.some((r) => r.id === state.pending)) {
      const item = TASKS.find((t) => t.id === state.pending);
      state.rows.push({ id: state.pending, task: item?.task ?? "unknown", passed: false, error: "Page interrupted/reloaded during example", ms: null });
      state.pending = null;
      persist(state);
    }
    render(state);
  }
  $("model").addEventListener("change", () => { result = null; refresh(); });
  $("engine").addEventListener("change", () => { result = null; refresh(); });
  $("run").addEventListener("click", async () => {
    $("run").disabled = true;
    running = true;
    const state = saved();
    try {
      result = await runBenchmark(ai, $("model").value, {
        engine: $("engine").value, previous: state.rows,
        onStart: (item) => { state.pending = item.id; persist(state); $("status").textContent = `Running ${item.task}: ${item.id}…`; },
        onResult: (_, rows) => { state.rows = rows; state.pending = null; persist(state); render(state); },
      });
      state.engine = result.engine;
      persist(state);
      render(state);
      $("status").textContent = `Done: ${result.rows.length} cases; loaded on ${result.engine} in ${result.loadMs} ms. Export results to compare devices.`;
    } catch (err) {
      $("status").textContent = `Benchmark stopped: ${err.message}`;
    } finally { running = false; $("run").disabled = false; }
  });
  $("export").addEventListener("click", () => {
    const state = saved();
    const report = { version: 1, at: new Date().toISOString(), model: $("model").value, sha256: ai.models[$("model").value].sha256,
      engine: result?.engine ?? state.engine ?? $("engine").value, userAgent: navigator.userAgent, loadMs: result?.loadMs ?? null,
      rows: state.rows, scores: summary(state.rows) };
    const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }));
    const a = document.createElement("a"); a.href = url; a.download = `portable-slm-benchmark-${report.model}.json`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  $("reset").addEventListener("click", () => {
    if (!confirm("Delete this model's benchmark results?")) return;
    localStorage.removeItem(key()); result = null; render({ rows: [] }); $("status").textContent = "Results reset.";
  });
  refresh().catch((err) => { if (root.isConnected) $("status").textContent = `Could not start: ${err.message}`; });
  return { busy: () => running };
}
