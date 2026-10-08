// Assemble the subset of the embed bundle a *static* host serves.
//
// `dist/` is two builds at once: the web app (dist/assets/**, ~63 MB, which a host never needs) and the
// embed build (embed.js + its chunks + embed-assets/). A host that copies the whole thing ships 101 MB
// to serve three files it uses. This takes the embed half, drops the runtime the host's manifest does
// not offer, and writes a README with the paste-in snippet.
//
//   npm run pack:site                      # -> dist-site/portable-slm
//   npm run pack:site -- --out public/portable-slm --runtimes onnx
//
// `--runtimes` decides which inference runtimes ship: `onnx` (Transformers.js), `wllama` (GGUF), or
// `both`. Shipping a runtime the manifest cannot use is ~24 MB of dead weight on every deploy, which
// is why this is a flag and not "copy everything".
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};

// Resolve against this file, not the caller's cwd: the packer is meant to be run from another
// repository (a site repo invokes it via its own pack script), and a cwd-relative `dist` silently looks
// in the wrong project.
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = resolve(flag("out", "dist-site/portable-slm"));
const runtimes = flag("runtimes", "onnx");
const dist = join(packageRoot, "dist");

if (!existsSync(join(dist, "embed.js"))) {
  console.error("pack:site needs a built embed bundle — run `npm run build:embed` first.");
  process.exit(1);
}
if (!["onnx", "wllama", "both"].includes(runtimes)) {
  console.error(`--runtimes must be onnx, wllama or both (got "${runtimes}")`);
  process.exit(1);
}

// The embed build's entry points and the chunks they import. Read from the built file rather than a
// hardcoded list, so a renamed chunk or a new dependency does not silently ship a broken pack.
function chunksFrom(entry) {
  const found = new Set();
  const visit = (file) => {
    const path = join(dist, file);
    if (found.has(file) || !existsSync(path)) return;
    found.add(file);
    const source = readFileSync(path, "utf8");
    // Vite emits `import("./chunk-X.js")` for dynamic imports and relative static imports for the rest.
    for (const match of source.matchAll(/["'(](\.\/)?([A-Za-z0-9._-]+\.js)["')]/g)) {
      const name = match[2];
      if (!name.startsWith("embed") && existsSync(join(dist, name))) visit(name);
    }
  };
  visit(entry);
  found.add(entry);
  return [...found];
}

const js = new Set([...chunksFrom("embed.js"), ...chunksFrom("chat.js"), ...chunksFrom("logging.js")]);
// The acceptance page is markup that imports the bundle, not an app: small, and useful to whoever runs
// the site (HOST_CONTRACT.md §7 is a checklist a human should not have to re-derive).
const pages = ["host-check.html", "chat.html"];
const meta = ["version.json", "icon.svg"];

const WANTED_ASSETS = {
  onnx: ["onnxWasm.wasm", "onnxMjs.mjs"],
  wllama: ["wasm.wasm", "compatWasm.wasm", "compatWorker.js"],
  both: ["onnxWasm.wasm", "onnxMjs.mjs", "wasm.wasm", "compatWasm.wasm", "compatWorker.js"],
};

// The pack owns the files it generates and nothing else. It used to wipe the output directory and
// preserve a hardcoded author list, which deleted a host's own page and grounding document — a build step
// must never remove files it did not write. So: write ours, and prune only stale generated files.
mkdirSync(join(outDir, "embed-assets"), { recursive: true });

// What this run writes. Anything in the output directory that looks generated but is NOT in here is stale
// from an earlier build and gets pruned.
const WRITTEN = new Set(["embed-assets.json", "README.md", ...js, ...pages, ...meta]);
const GENERATED_DIRS = new Set(["embed-assets"]);

let bytes = 0;
const count = (file) => { bytes += statSync(file).size; return file; };

for (const file of js) copyFileSync(count(join(dist, file)), join(outDir, file));
for (const file of pages) {
  if (existsSync(join(dist, file))) copyFileSync(count(join(dist, file)), join(outDir, file));
}
for (const file of meta) {
  if (existsSync(join(dist, file))) copyFileSync(count(join(dist, file)), join(outDir, file));
}

// embed-assets.json is what the bundle reads to find its runtimes, so it has to describe the pack, not
// the build. A host whose manifest pins ONNX models gets an assets file with no wllama paths in it.
const assets = JSON.parse(readFileSync(join(dist, "embed-assets.json"), "utf8"));
const shipped = {};
for (const [key, relative] of Object.entries(assets)) {
  const name = relative.split("/").pop();
  if (!WANTED_ASSETS[runtimes].includes(name)) continue;
  cpSync(count(join(dist, "embed-assets", name)), join(outDir, "embed-assets", name));
  shipped[key] = `./embed-assets/${name}`;
}
writeFileSync(join(outDir, "embed-assets.json"), `${JSON.stringify(shipped, null, 2)}\n`);

// A manifest template only when the host has not written one (kept above across the re-pack).
const manifestPath = join(outDir, "portable-slm.host.json");
if (!existsSync(manifestPath)) {
  writeFileSync(manifestPath, `${JSON.stringify({
    apiVersion: "pslm-host/1",
    model: "lfm2.5-350m-onnx-q4f16",
    app: { name: "replace-with-your-site-name", version: "1.0.0" },
    context: {
      // A static host has no API to read, so app mode is the whole ladder: one bounded, public document
      // the assistant may answer from. It has no access control, so it must hold documentation only.
      app: { url: "/portable-slm/app.md", maxBytes: 8192 },
      credentials: "none",
    },
    models: { available: ["lfm2.5-350m-onnx-q4f16"] },
    tasks: ["pslm.chat"],
    writeBack: false,
  }, null, 2)}\n`);
}

// The acceptance page imports ./embed.js by name, so a host who opens it right after a deploy would test
// whatever their browser cached — up to ten minutes of the previous bundle, which is how a fixed bug stays
// visible. Stamp the import with the SDK revision; the chunks embed.js pulls in are already named by hash.
const version = existsSync(join(dist, "version.json")) ? JSON.parse(readFileSync(join(dist, "version.json"), "utf8")) : {};
const stamp = version.gitSha || version.version || String(version.builtAt || "");
if (stamp && existsSync(join(outDir, "host-check.html"))) {
  const page = join(outDir, "host-check.html");
  writeFileSync(page, readFileSync(page, "utf8").replace(/(from\s+["']\.\/embed\.js)(["'])/g, `$1?v=${stamp}$2`));
}

writeFileSync(join(outDir, "README.md"), `# portable-slm, packed for a host that serves it itself

Generated by \`npm run pack:site\` (runtimes: ${runtimes}). Do not edit; re-run the pack instead.
The manifest is yours — this pack will not overwrite an existing \`portable-slm.host.json\`.

## Mount it

\`\`\`html
<div data-pslm data-launcher="Ask this site" data-resize></div>
<script type="module" src="/portable-slm/embed.js"></script>
\`\`\`

The manifest is read from this directory, next to \`embed.js\`, so no \`data-manifest\` is needed.
Grounding text goes at the \`context.app.url\` the manifest declares (default \`/portable-slm/site.md\`).

## What a host still owns

Style \`[part=launcher]\` and \`#pslm-panel\` (geometry and palette are the host's, behaviour is the
bundle's). Write the grounding document. Keep the model allowlist honest: the visitor downloads every
entry in \`models.available\` that they install, from Hugging Face, once per browser origin.

## Constraints of a static host

- **No COOP/COEP headers means single-threaded WASM.** GitHub Pages and most static hosts cannot send
  them, so \`crossOriginIsolated\` is false and inference uses one thread. The panel says so. A service
  worker can inject the headers if threads are ever worth the moving parts.
- **Weights cannot live in the repository** (259 MB for the 350M ONNX, 1.55 GB for the 2.6B). Visitors
  download them from the pinned upstream URLs, SHA-256 verified, and only when they click Install.
- **One grounding document, not retrieval.** A static host cannot shape a page into context, so the
  assistant answers from the bounded document you give it. That is the honest ceiling, not a bug.
`, "utf8");

// Prune stale generated files only. The real case is a chunk from an earlier SDK build
// (`transformers-engine-OLDHASH.js`) surviving a deploy; a `dist/` that only ever grows is how a host ends
// up serving a bundle nobody can account for. A host's own files — a page, a grounding document, a
// manifest, anything that is not ours by shape — are left alone. Prune only after everything is written,
// so the write set is known in full.
for (const entry of readdirSync(outDir)) {
  const path = join(outDir, entry);
  if (GENERATED_DIRS.has(entry)) {
    for (const inner of readdirSync(path)) {
      if (!WANTED_ASSETS[runtimes].includes(inner)) rmSync(join(path, inner), { force: true });
    }
    continue;
  }
  // Names this pack ships are fixed, so they are never stale: pages, icon, version, the assets manifest.
  // Only hashed JS chunks are unpredictable, and only they (plus a regenerated README) can go stale.
  const staleChunk = /\.js$/.test(entry) && !WRITTEN.has(entry);
  const staleFile = (entry === "embed-assets.json" || entry === "README.md") && !WRITTEN.has(entry);
  if (staleChunk || staleFile) rmSync(path, { force: true });
}

const mb = (bytes / 1024 / 1024).toFixed(1);
console.log(`packed ${js.size} js, ${Object.keys(shipped).length} runtime assets -> ${outDir}`);
console.log(`total ${mb} MB (runtimes: ${runtimes}); manifest ${existsSync(manifestPath) ? "present" : "template written"}`);
console.log(`paste: <div data-pslm data-launcher="Ask this site" data-resize></div>`);
