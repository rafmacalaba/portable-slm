// Real Chrome extension: file import → local tool call → restart offline → local tool call.
// Requires Chrome for Testing when corporate policy blocks loading unpacked extensions.
// CHROME_PATH=... GGUF_FILE=... npm run e2e:extension
import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import puppeteer from "puppeteer-core";

const chrome = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const extension = resolve("dist-extension");
const profile = resolve(".cache/extension-e2e-profile");
const file = resolve(process.env.GGUF_FILE ?? ".cache/models/LFM2.5-350M-Q4_K_M.gguf");
if (!existsSync(file)) throw new Error(`Model file missing: ${file}. Run npm run e2e first or set GGUF_FILE.`);
mkdirSync(".cache", { recursive: true });
rmSync(profile, { recursive: true, force: true });

async function launch(offline = false) {
  const browser = await puppeteer.launch({
    executablePath: chrome, headless: true, enableExtensions: [extension], userDataDir: profile,
    protocolTimeout: 120_000, args: offline ? ["--host-resolver-rules=MAP * ~NOTFOUND"] : [],
  });
  const target = await browser.waitForTarget((t) => t.url().startsWith("chrome-extension://"), { timeout: 20_000 });
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.log("  [page exception]", e.message));
  await page.goto(`chrome-extension://${new URL(target.url()).hostname}/panel.html`);
  await page.waitForFunction(() => !document.querySelector("#status").textContent.includes("Starting"));
  return { browser, page };
}

async function askTime(page) {
  await page.type("#prompt", "What is the current date? You must use get_datetime.");
  await page.click("#ask");
  await page.waitForFunction(() => document.querySelector("#answer").textContent.length > 0 || document.querySelector("#status").classList.contains("error"), { timeout: 120_000 });
  assert.match(await page.$eval("#events", (el) => el.textContent), /call: get_datetime/);
  assert.match(await page.$eval("#answer", (el) => el.textContent), /\d{4}/);
}

console.log("[1/2] install extension and import model");
let { browser, page } = await launch();
try {
  await (await page.$("#import")).uploadFile(file);
  await page.waitForFunction(() => document.querySelector("#status").textContent.includes("Model installed"), { timeout: 120_000 });
  await page.click("#load");
  await page.waitForFunction(() => document.querySelector("#status").textContent.includes("Model ready"), { timeout: 120_000 });
  await askTime(page);
} finally { await browser.close(); }

console.log("[2/2] reopen extension with DNS blocked");
({ browser, page } = await launch(true));
try {
  assert.match(await page.$eval("#status", (el) => el.textContent), /Model installed/);
  await page.click("#load");
  await page.waitForFunction(() => document.querySelector("#status").textContent.includes("Model ready"), { timeout: 120_000 });
  await askTime(page);
} finally { await browser.close(); }
console.log("PASS: extension imports model and calls a local tool online and offline");
