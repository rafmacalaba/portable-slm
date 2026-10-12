// The "no telemetry, no write path" guarantee, as an assertion instead of a paragraph.
//
// Two audits, both static, both cheap enough to run on every push:
//
//   1. Source. Every absolute URL in the SDK must be on the allowlist below, and the only mutating
//      request method allowed is the POST in logging.js, which posts to an endpoint a host declares
//      for itself. A new destination fails the build and has to be argued for here first.
//   2. The bundle a host serves. Same rules on the built entry points, so a dependency cannot
//      smuggle a destination into what ships.
//
// Usage: npm run audit:bundle          (needs `npm run build:embed` for the second audit)
//        node tools/audit-bundle.mjs [distDir]
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { basename, join } from "node:path";

// Where the SDK is allowed to send a request, and why it is there.
const ALLOWED = {
  "huggingface.co": "the default model host, replaced by a host's own mirror",
  "en.wikipedia.org": "wiki_search, the one tool flagged network: true, approved per call",
  "localhost": "test fixtures and synthetic same-origin keys",
  "portable-slm.invalid": "the synthetic origin store.js content-addresses model keys against",
};
// Method a request may use, and the only file allowed to use it. Matched on the file's own name, so
// the same rule holds for the source and for the built file it becomes.
const MUTATING = { POST: "logging.js" };

const files = (dir, filter) =>
  existsSync(dir) ? readdirSync(dir).filter(filter).map((f) => join(dir, f)) : [];
const sources = [...files("src", (f) => f.endsWith(".js")), ...files("integrations", (f) => f.endsWith(".js"))];

const problems = [];
const scan = (file, text, { allowHosts }) => {
  for (const m of text.matchAll(/https?:\/\/([a-zA-Z0-9.-]+)/g)) {
    if (!ALLOWED[m[1]]) problems.push(`${file}: unallowlisted destination "${m[1]}"`);
    else if (!allowHosts.has(m[1])) problems.push(`${file}: "${m[1]}" is not allowed in a shipped entry point (${ALLOWED[m[1]]})`);
  }
  for (const m of text.matchAll(/method:\s*["'`](\w+)["'`]/g)) {
    const method = m[1].toUpperCase();
    if (!(method in MUTATING)) continue;
    if (MUTATING[method] !== basename(file)) problems.push(`${file}: issues a ${method}; only ${MUTATING[method]} may`);
  }
};

for (const file of sources) scan(file, readFileSync(file, "utf8"), { allowHosts: new Set(Object.keys(ALLOWED)) });

// The entry points a host loads directly: bundles of our own code, which import runtime chunks by
// URL. Those chunks are third-party libraries (transformers.js, wllama, markdown-it) reached through
// a pinned, hash-verified install, so they are out of scope here: this gate audits what we write.
const dist = process.argv[2] ?? "dist";
const entries = ["embed.js", "chat.js", "logging.js"].map((f) => join(dist, f)).filter(existsSync);
let audited = 0;
if (entries.length === 3) {
  const entryHosts = new Set(["huggingface.co", "en.wikipedia.org", "localhost"]);
  for (const file of entries) {
    audited++;
    scan(file, readFileSync(file, "utf8"), { allowHosts: entryHosts });
  }
} else if (existsSync(dist)) {
  problems.push(`${dist}: entry points missing, run npm run build:embed before auditing the bundle`);
} else {
  console.log(`  ${dist}: not built, auditing source only`);
}

for (const problem of problems) console.log(`  ${problem}`);
console.log(`${sources.length} source files and ${audited} bundle files audited, ${problems.length} violation(s)`);
console.log(`  destinations allowed: ${Object.entries(ALLOWED).map(([h, why]) => `${h} (${why})`).join("; ")}`);
if (problems.length) process.exit(1);
console.log("bundle: no unallowlisted destination, and no mutating request outside the host's own log endpoint");
