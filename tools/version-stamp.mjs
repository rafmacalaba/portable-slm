// Writes dist/version.json so a host can see which build it is actually serving, instead of being
// told to "keep files synchronized". embed.js shows it in the panel bar; host-check.html prints it.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const { version } = JSON.parse(readFileSync("package.json", "utf8"));
let gitSha = "";
try {
  // Empty in a release tarball or a checkout without git; the key stays present so hosts parse
  // one shape rather than guarding on it.
  gitSha = execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
} catch {
  /* not a git checkout */
}

const stamp = { version, gitSha, builtAt: new Date().toISOString() };
writeFileSync("dist/version.json", `${JSON.stringify(stamp, null, 2)}\n`);
console.log(`version.json -> ${version}${gitSha ? `+${gitSha}` : ""}`);
