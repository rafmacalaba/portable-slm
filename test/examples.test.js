// Example code is tested too: an example that does not run is worse than no example.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { PUBLIC_CATALOGUE, loadPublicDemoStudy } from "../examples/catalogue/public-catalogue-demo.js";

test("the public catalogue example sends no credentials and returns the bounded summary", async () => {
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/catalogue-study.json", import.meta.url), "utf8"));
  const snapshot = await loadPublicDemoStudy("Test001_OD", {
    fetch: async (url, options) => {
      assert.equal(url, `${PUBLIC_CATALOGUE}/index.php/api/catalog/Test001_OD`);
      assert.deepEqual(options, { credentials: "omit", mode: "cors" });
      return new Response(JSON.stringify(fixture), { status: 200 });
    },
  });
  assert.match(snapshot.title, /Popstan/);
  assert.match(snapshot.abstract, /national welfare monitoring survey/);
  assert.deepEqual(Object.keys(snapshot), ["idno", "title", "abstract"]);
});

test("the example points at any catalogue, and rejects a malformed id", async () => {
  const seen = [];
  await loadPublicDemoStudy("Test001_OD", { host: "https://catalogue.example", fetch: async (url) => { seen.push(url); return new Response(JSON.stringify({ idno: "Test001_OD" }), { status: 200 }); } });
  assert.equal(seen[0], "https://catalogue.example/index.php/api/catalog/Test001_OD");
  await assert.rejects(loadPublicDemoStudy("bad id with spaces"), /short study id/);
});
