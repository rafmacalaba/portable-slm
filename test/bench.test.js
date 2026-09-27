import assert from "node:assert/strict";
import { test } from "node:test";
import { runBenchmark, summary } from "../bench/run.js";
import { TASKS } from "../bench/tasks.js";

test("offline benchmark scores plain and tool tasks; resumes without rerunning rows", async () => {
  let generated = 0;
  const ai = {
    models: { m: { sha256: "abc" } },
    status: async () => ({ state: "installed" }), load: async () => ({ engine: "cpu" }),
    generate: async () => { generated++; return { text: "food", timings: { predicted_per_second: 12 } }; },
    runAgent: async (_, { tools, onTool }) => {
      assert.equal(tools[0].network, false);
      onTool({ stage: "call", name: "get_datetime" });
      return { text: "2030-02-14" };
    },
  };
  const tasks = [TASKS[0], TASKS.at(-1)];
  const result = await runBenchmark(ai, "m", { tasks });
  assert.deepEqual(result.scores, { classification: { passed: 1, total: 1 }, tool_call: { passed: 1, total: 1 } });
  assert.equal(result.rows.length, 2);
  const resumed = await runBenchmark(ai, "m", { tasks, previous: result.rows });
  assert.equal(generated, 1);
  assert.equal(resumed.rows.length, 2);
  assert.deepEqual(summary(resumed.rows), result.scores);
});
