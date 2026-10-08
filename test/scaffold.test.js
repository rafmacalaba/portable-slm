// A starter is only worth shipping if what it emits is valid. These assertions run the generated manifest
// through the real validator and mount resolver, so a change to the contract that would break a new host's
// first five minutes fails here instead of in their repo.
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildHostTools, mountMode, validateManifest } from "../integrations/host-contract.js";
import { starterFiles, starterManifest } from "../tools/scaffold.mjs";

test("the static starter is a valid manifest, and mounts in app mode", () => {
  const manifest = validateManifest(starterManifest("static", { name: "My Site" }));
  assert.equal(manifest.app.name, "My Site");
  assert.equal(manifest.writeBack, false);
  // No record, so no Suggest tab and no Fill: the correct shape for a host with no API.
  assert.deepEqual(mountMode({ manifest, recordId: undefined }), {
    record: false, datafile: false, app: true, suggest: false, fill: false, context: "app",
  });
  // A public page has no session to send.
  assert.equal(manifest.context.credentials, "none");
  assert.equal(manifest.tools, undefined, "a static host declares no tools — there is nothing to read");
});

test("the record starter is valid, and mounts with a record, a Suggest tab and one declared tool", () => {
  const manifest = validateManifest(starterManifest("record", { name: "My App" }));
  assert.deepEqual(mountMode({ manifest, recordId: "123" }), {
    record: true, datafile: false, app: false, suggest: true, fill: true, context: "record",
  });
  assert.equal(manifest.context.credentials, "same-origin");
  assert.equal(manifest.tools.length, 1);
  // The tool's pointer enum comes from the manifest's own pointers, so the model can only ask for a field
  // the host declared — and a host that declares none fails at mount rather than mid-conversation.
  assert.deepEqual(manifest.context.field.pointers.map((p) => p.pointer), ["/title", "/description"]);
  assert.equal(manifest.tools[0].parameters.properties.pointer.enum, "$declaredPointers");
  // Per-call approval is the contract's default; the starter must not weaken it for the host.
  assert.equal(manifest.toolApproval, undefined);
});

test("a record starter without declared pointers fails loudly, which is why the starter declares them", () => {
  const manifest = starterManifest("record");
  delete manifest.context.field.pointers;
  validateManifest(manifest); // the manifest itself is still well-formed...
  // ...but the tool asks for declared pointers, so the mount fails rather than the conversation. This is
  // the check that makes an allowlist a real allowlist, and it happens before a model is ever involved.
  assert.throws(() => buildHostTools(manifest, "1", { origin: "https://app.example" }), /declares none/);
});

test("the emitted files are the four a host needs, and the checklist names the host's own directory", () => {
  const files = starterFiles("record", { name: "My App", url: "https://app.example", out: "/tmp/app/public/portable-slm" });
  assert.deepEqual(Object.keys(files), ["portable-slm.host.json", "app.md", "host.html", "STARTER.md"]);
  // The pack command must point at the host's directory, not at portable-slm's cwd.
  assert.match(files["STARTER.md"], /npm run pack:site -- --out \/tmp\/app\/public\/portable-slm --runtimes onnx/);
  assert.match(files["STARTER.md"], /host-check\.html\?manifest=\/portable-slm\/portable-slm\.host\.json&sid=<a test record id>/);
  // The traps that cost real time in both existing integrations, so a new host does not rediscover them.
  // The traps that cost real time in the existing integrations. The subpath one is now stated as the rule
  // that fixes it rather than a warning, so assert the rule.
  for (const trap of ["per browser origin", "COOP/COEP", "resolve against the manifest", "Cache-Control", "weights in a repository"]) {
    assert.match(files["STARTER.md"], new RegExp(trap), `checklist should warn about ${trap}`);
  }
  // The mount is two elements and one script tag, and the manifest is found next to the bundle.
  assert.match(files["host.html"], /<div id="pslm-panel" class="pslm" data-pslm data-launcher="Ask My App" data-resize><\/div>/);
  assert.match(files["host.html"], /<script type="module" src="\.\/embed\.js"><\/script>/);
  assert.doesNotMatch(files["host.html"], /data-manifest=/, "no data-manifest attribute: the manifest sits next to embed.js");
  // Every file is non-trivial: an empty starter is worse than none.
  for (const [name, body] of Object.entries(files)) assert.ok(body.length > 200, `${name} looks empty`);
});
