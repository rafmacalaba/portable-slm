// The harness starting point: one command that emits a correct, verifiable host integration.
//
// Both real integrations were built by reading nine documents and reconstructing the same things by hand
// — which dist, which manifest, which attributes, which styles, plus the traps (origin-scoped storage,
// single-threaded WASM, absolute URLs under a subpath, a bundle that ships no Cache-Control). A host
// should start from something that is already right and then edit, not from prose.
//
//   npm run scaffold -- --out ../my-app/public/portable-slm --shape static --name "My Site"
//   npm run scaffold -- --out ../my-app/public/portable-slm --shape record --name "My App"
//
// `static` is a host with no API: one bounded document, app mode, chat only.
// `record` is a host with an API about one object: a record snapshot, one editable field, one declared
// read tool. It emits the *declaration*; the endpoints are yours to implement, and the checklist says so.
//
// Nothing is written over an existing file: a starter that clobbers your manifest on a second run is
// worse than no starter.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SHAPES = ["static", "record"];

/** The manifest for a shape. Exported so a test can assert it passes the real `validateManifest`. */
export function starterManifest(shape, { name = "Your application", url = "https://example.com" } = {}) {
  const base = {
    apiVersion: "pslm-host/1",
    model: "lfm2.5-350m-onnx-q4f16",
    app: { name, version: "1.0.0" },
    context: {},
    models: { available: ["lfm2.5-350m-onnx-q4f16", "lfm2.5-2.6b-onnx-q4f16"] },
    tasks: ["pslm.chat"],
    writeBack: false,
  };
  if (shape === "static") {
    // A host with no API declares one document it may answer from. The path is relative to this
    // manifest, so the pack works at "/", at "/portable-slm/" or under any subpath — and
    // `credentials: "none"` because a public page has no session to send.
    base.context = { app: { url: "app.md", maxBytes: 8192 }, credentials: "none" };
    return base;
  }
  // A host with an API declares the record, the one field a curator may edit, and one read tool. Every
  // endpoint is a same-origin GET that is already scoped to `{id}`; the manifest is the allowlist, so a
  // narrower declaration is a narrower assistant.
  base.context = {
    app: { url: "app.md", maxBytes: 8192 },
    record: { url: "/api/record/{id}", maxBytes: 12288 },
    field: {
      url: "/api/record/{id}/field?path={pointer}",
      maxBytes: 4096,
      pointers: [
        { pointer: "/title", label: "Title" },
        { pointer: "/description", label: "Description" },
      ],
    },
    credentials: "same-origin",
  };
  base.tasks = ["pslm.chat", "pslm.suggest-field"];
  base.tools = [{
    id: "read_record_field",
    label: "Read one declared field",
    description: "Read the exact saved value of one allowlisted field of the record currently open. Call it only when the user asks what a specific field contains; do not call it for general advice or greetings.",
    method: "GET",
    endpoint: "/api/record/{id}/field?path={pointer}",
    maxBytes: 4096,
    parameters: {
      type: "object",
      properties: { pointer: { type: "string", description: "JSON Pointer of the field to read", enum: "$declaredPointers" } },
      required: ["pointer"],
    },
  }];
  return base;
}

const APP_MD = `# What this application is

<!--
  The document the assistant may answer from when there is no record on screen. It is served over HTTP,
  so it has no access control: documentation only, never data. Keep it under the maxBytes in
  portable-slm.host.json — a server-side cut drops whatever happens to be last, silently.
-->

Describe the application, its vocabulary, and what the assistant may claim about it. Then state how it
should answer:

- Answer only from this document and the context supplied with the question. If something is not here,
  say so rather than guessing.
- Keep answers short and concrete. Name what you are drawing on.
- Do not invent dates, numbers, quotes, links, or field values.
`;

const HOST_HTML = (name) => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>${name} - host starter</title>
    <!--
      A working mount, kept small on purpose. Everything the assistant DOES comes from ./embed.js; this
      page only says where the panel goes and which manifest it reads. The manifest is looked up next to
      embed.js (./portable-slm.host.json), so no data-manifest attribute is needed here.
      Replace this page with your own - the assistant does not depend on it.
    -->
    <style>
      /* Geometry and palette are yours. Every rule the bundle injects is wrapped in :where(), so these
         win without !important. The bundle creates the launcher and the resize handles; they arrive as
         part="launcher", part="resize-left" and part="resize-corner". */
      body { font: 15px/1.5 system-ui, sans-serif; margin: 2rem; }
      #pslm-panel {
        position: fixed; right: 1rem; bottom: 5rem; z-index: 60;
        width: min(26rem, calc(100vw - 2rem)); height: min(36rem, 72vh);
        border: 1px solid #d0d7de; border-radius: 10px; background: #fff;
        box-shadow: 0 8px 24px rgba(15, 31, 61, 0.12);
      }
      #pslm-panel[hidden] { display: none; }
      #pslm-panel [part="resize-left"] { position: absolute; left: 0; top: 0; bottom: 0; width: 8px; cursor: ew-resize; touch-action: none; z-index: 5; }
      #pslm-panel [part="resize-corner"] { position: absolute; left: 0; bottom: 0; width: 16px; height: 16px; cursor: nesw-resize; touch-action: none; z-index: 5; }
      [part="launcher"] {
        position: fixed; right: 1rem; bottom: 1rem; z-index: 60;
        padding: 0.55rem 1.1rem; font: inherit; cursor: pointer;
        border: 1px solid #d0d7de; border-radius: 999px; background: #fff;
        box-shadow: 0 8px 24px rgba(15, 31, 61, 0.12);
      }
      [data-pslm-note] {
        position: fixed; right: 1rem; bottom: 5rem; z-index: 61; margin: 0;
        max-width: min(22rem, calc(100vw - 2rem)); padding: 0.4rem 0.6rem;
        font-size: 12px; border: 1px solid #bf8700; border-radius: 10px; background: #fff8c5;
      }
      [data-pslm-note][hidden] { display: none; }
    </style>
  </head>
  <body>
    <h1>${name}</h1>
    <p>This is the starter page. Delete it once your own layout mounts the assistant.</p>

    <!-- Two elements and one script tag. Both elements are optional: a bare <div data-pslm> mounts the
         panel with no launcher, and the note element is what a host-side bridge writes to. -->
    <div id="pslm-panel" class="pslm" data-pslm data-launcher="Ask ${name}" data-resize></div>
    <p data-pslm-note role="status" hidden></p>
    <script type="module" src="./embed.js"></script>
  </body>
</html>
`;

export function starterFiles(shape, options = {}) {
  const { name = "Your application", url = "https://example.com", out = "dist-host" } = options;
  return {
    "portable-slm.host.json": `${JSON.stringify(starterManifest(shape, { name, url }), null, 2)}\n`,
    "app.md": APP_MD,
    "host.html": HOST_HTML(name),
    "STARTER.md": starterChecklist(shape, { name, url, out }),
  };
}

/** The checklist. This is the part that makes it "quality from the start" rather than a file dump. */
export function starterChecklist(shape, { name = "Your application", url = "https://example.com", out = "dist-host" } = {}) {
  const recordSteps = shape === "record" ? `
## The endpoints this starter declares

It declares three same-origin GETs. Replace the paths with yours, and keep the shape: each is scoped to
\`{id}\` (the record on screen, never a value the model supplies) and returns JSON.

| Declared | Expected response |
|---|---|
| \`GET /api/record/{id}\` | the record snapshot, or \`{ dataset: … }\` / \`{ metadata: … }\` |
| \`GET /api/record/{id}/field?path={pointer}\` | \`{ "status": "success", "found": true, "value": … }\` |
| the declared tool endpoint | the same field endpoint, byte-capped |

Access control stays in those paths. The assistant reads only what the signed-in user may read, and only
the pointers you listed under \`context.field.pointers\`.
` : `
## Why this is app mode

No \`context.record\`, so the panel has no Suggest tab and no Fill button: there is no record to bind and
no form to write into. That is the correct shape for a host with no API. If your host grows a record, take
the \`record\` shape - it is the same command with \`--shape record\`.
`;

  return `# Starter: ${name}

Generated by \`npm run scaffold\`. Four files, all yours to edit. This page is the checklist; the
authoritative contracts are linked at the bottom.

| File | What it is |
|---|---|
| \`portable-slm.host.json\` | the manifest: what the assistant may read. Already valid - \`validateManifest()\` passes |
| \`app.md\` | the document it answers from when no record is on screen (documentation, never data) |
| \`host.html\` | a working mount, two elements and one script tag |
| \`STARTER.md\` | this page |

## Six steps

1. **Pack the bundle into this directory.** From a portable-slm checkout:
   \`\`\`sh
   npm ci && npm run build:embed
   npm run pack:site -- --out ${out} --runtimes onnx
   \`\`\`
   That writes \`embed.js\`, its chunks, \`embed-assets/\` and \`host-check.html\` here. Use
   \`--runtimes both\` only if you also offer GGUF models.
2. **Edit the manifest** - the \`app.name\`, and the endpoints if this is a \`record\` host. Leave
   \`writeBack: false\`: this contract has no write path, and a manifest that asks for one fails the mount.
3. **Write \`app.md\`.** This is the text the assistant may claim on your behalf. Measure it:
   \`wc -c app.md\` against \`maxBytes\`.
4. **Mount it** in your own layout - copy the two elements and the script tag out of \`host.html\`.
   Keep your own geometry and palette; the bundle only needs the elements to exist.
5. **Verify instead of trusting it:**
   \`\`\`sh
   open ${url.replace(/\/$/, "")}/portable-slm/host-check.html?manifest=/portable-slm/portable-slm.host.json${shape === "record" ? "&sid=<a test record id>" : ""}
   \`\`\`
   Signed in as a user with access. Every check it can make mechanically is listed there; a \`fail\` is a
   contract violation, a \`skip\` is something you have not declared yet. Paste the report into the ticket.
6. **Check the traps** below before you ship.
${recordSteps}
## Traps that cost real time

- **Model bytes are per browser origin and never leave it.** A model installed on \`localhost:8080\` is not
  visible to \`localhost:4321\`, or to your production host. Each origin pays once, per browser.
- **No COOP/COEP headers means single-threaded WASM.** Most static hosts cannot send them, so inference is
  one thread and the panel says \`single-thread\`. Slower, not broken.
- **Paths in the manifest resolve against the manifest, not the page.** \`"url": "app.md"\` therefore
  works whether the pack is served at \`/\`, at \`/portable-slm/\`, or under a nested base. Absolute paths are
  still absolute — use them only for your own API routes.
- **The bundle ships no Cache-Control.** Browsers cache it heuristically, so a deploy can serve a stale
  \`embed.js\`. Append a version query string — the pack writes \`version.json\`, and the panel shows the
  build stamp so staleness is visible in one glance.
- **Bundle the runtime yourself.** \`embed-assets/\` must be served from your origin; inference never
  downloads code at run time, and a CDN in that path is a remote-code risk.
- **Do not put model weights in a repository.** They are 250 MB to 1.5 GB per model. Visitors download
  from the pinned upstream URLs, SHA-256 verified, and only when they click Install.

## Non-negotiables

- \`writeBack: false\` — the assistant proposes; the host applies after a human approves.
- Every declared tool waits for a per-call approval by default. \`"toolApproval": "auto"\` removes the click
  for your own read-only tools; it never widens what they can reach.
- Context is a **snapshot you chose**, never automatic page scraping.
- The only write path is a user action in your own form, through your own validation.
- Model output is untrusted: render as text, never execute, never save unreviewed.

## Contracts

- [HOST_CONTRACT.md](https://github.com/rafmacalaba/portable-slm/blob/main/docs/HOST_CONTRACT.md) — the manifest, the tasks, the acceptance list
- [CHAT.md](https://github.com/rafmacalaba/portable-slm/blob/main/docs/CHAT.md) — attributes, events, the completeness verdict
- [GETTING_STARTED.md](https://github.com/rafmacalaba/portable-slm/blob/main/docs/GETTING_STARTED.md) — this path, in one page
`;
}

// --- CLI -----------------------------------------------------------------------------------------

function main() {
  const argv = process.argv.slice(2);
  const flag = (name, fallback) => {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
  };
  const shape = flag("shape", "static");
  if (!SHAPES.includes(shape)) {
    console.error(`--shape must be ${SHAPES.join(" or ")} (got "${shape}")`);
    process.exit(1);
  }
  const out = resolve(flag("out", "dist-host"));
  const name = flag("name", "Your application");
  const url = flag("url", "https://example.com");

  mkdirSync(out, { recursive: true });
  const written = [];
  const kept = [];
  for (const [file, body] of Object.entries(starterFiles(shape, { name, url, out }))) {
    const path = join(out, file);
    if (existsSync(path)) { kept.push(file); continue; }
    writeFileSync(path, body);
    written.push(file);
  }

  console.log(`${shape} starter -> ${out}`);
  if (written.length) console.log(`  wrote: ${written.join(", ")}`);
  if (kept.length) console.log(`  kept (already yours): ${kept.join(", ")}`);
  console.log(`\nnext: npm run pack:site -- --out ${out} --runtimes onnx`);
  console.log(`      then read ${join(out, "STARTER.md")}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
