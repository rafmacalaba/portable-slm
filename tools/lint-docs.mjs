// Documentation gate. Three guarantees, one pass over the docs, non-zero exit on any break.
//
//   1. Every relative link resolves: to a file, and to a heading when it names one.
//      Same-page `#anchors` are checked too, which is the class that broke silently once before,
//      when a rewrite dropped the `Logging` heading that a link still pointed at.
//   2. The core documentation names no host application, no personal detail and no retired
//      deployment. Host-specific detail belongs in examples/, so it is checked for links only.
//   3. Nothing here is advisory: CI runs this file, and a break fails the build.
//
// Usage: node tools/lint-docs.mjs [root]
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join, normalize } from "node:path";

const root = process.argv[2] ?? ".";
const at = (...parts) => join(root, ...parts);

// Core documentation must stay host-agnostic. examples/ is where a host is allowed to appear.
const core = ["README.md", "AGENTS.md", ...readdirSync(at("docs")).filter((f) => f.endsWith(".md")).map((f) => join("docs", f))];
const linkable = [...core, "examples/README.md"];

const forbidden = {
  "host application": /\bnada\b|NADA|metadata[- ]editor|Metadata Editor/g,
  "personal detail": /rafmacalaba|github\.io|hf\.space|worldbank/g,
  "retired deployment": /hf wrapper|HF-embedded|huggingface\.co\/spaces/g,
};

// GitHub's own anchor spelling, as far as headings in these files need it.
const anchorOf = (heading) => heading.toLowerCase().replace(/`/g, "").replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-");

const anchors = new Map();
const bodies = new Map();
for (const file of linkable) {
  const text = readFileSync(at(file), "utf8");
  bodies.set(file, text);
  const set = new Set();
  // Fenced code blocks can contain lines that look like headings; skip them.
  let fenced = false;
  for (const line of text.split("\n")) {
    if (/^```/.test(line)) { fenced = !fenced; continue; }
    if (fenced) continue;
    const m = /^#{1,6}\s+(.*)$/.exec(line);
    if (m) set.add(anchorOf(m[1]));
  }
  anchors.set(file, set);
}

const external = (target) => /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(target);
// Only prose holds links. `](url)` inside a code span or a fenced example is an illustration, not a
// target, and docs about a markdown renderer are full of them.
const prose = (text) => text.replace(/^```[\s\S]*?^```$/gm, "").replace(/`[^`\n]*`/g, "");
const problems = [];
let links = 0;

for (const file of linkable) {
  for (const m of prose(bodies.get(file)).matchAll(/\]\(([^)\s]+?)\)/g)) {
    const target = m[1];
    if (external(target)) continue;
    const [path, fragment] = target.split("#");
    links++;
    const resolved = path ? normalize(join(dirname(file), path)) : file;
    if (!anchors.has(resolved) && !existsSync(at(resolved))) {
      problems.push(`${file}: link target missing -> ${target}`);
      continue;
    }
    if (fragment && anchors.has(resolved) && !anchors.get(resolved).has(fragment.toLowerCase())) {
      problems.push(`${file}: no heading "${fragment}" in ${resolved} -> ${target}`);
    }
  }
}

for (const file of core) {
  for (const [label, pattern] of Object.entries(forbidden)) {
    const hits = [...bodies.get(file).matchAll(pattern)];
    for (const hit of hits) {
      const line = bodies.get(file).slice(0, hit.index).split("\n").length;
      problems.push(`${file}:${line}: ${label} "${hit[0]}" in core documentation`);
    }
  }
}

for (const problem of problems) console.log(`  ${problem}`);
const named = problems.filter((p) => !p.includes("core documentation")).length;
console.log(`${links} relative links checked across ${linkable.length} files, ${named} broken`);
console.log(`${core.length} core docs audited, ${problems.length - named} host-name or personal-detail leftovers`);
if (problems.length) process.exit(1);
console.log("docs: links resolve, anchors resolve, core documentation names no host");
