// End-to-end in real Chrome:
//  1. online: install the app, DOWNLOAD one model (resumable path), IMPORT another from a local
//     file (the USB / SD card path), chat once;
//  2. offline (server stopped, all DNS blocked): chat with both models, on WebGPU and on CPU.
// Usage: npm run e2e   (CHROME_PATH=..., KEEP_PROFILE=1 to reuse stored models)
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { cpSync, createReadStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import puppeteer from "puppeteer-core";
import { MODELS } from "../src/models.js";

const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 4173;
const URL = `http://localhost:${PORT}/`;
const PROFILE = ".cache/e2e-profile";
const DOWNLOAD_ID = "lfm2.5-230m-q4km";
const IMPORT_ID = "lfm2.5-350m-q4km";
const IMPORT_FILE = `.cache/models/${MODELS[IMPORT_ID].file}`;
const MIRROR_FILE = `.cache/models/${MODELS[DOWNLOAD_ID].file}`;
const MIRROR_URL = "http://localhost:4180/model.gguf";

if (!process.env.KEEP_PROFILE) rmSync(PROFILE, { recursive: true, force: true });
for (const [file, model] of [[IMPORT_FILE, MODELS[IMPORT_ID]], [MIRROR_FILE, MODELS[DOWNLOAD_ID]]]) {
  if (!existsSync(file)) {
    mkdirSync(".cache/models", { recursive: true });
    console.log(`fetching ${file} for the local file/mirror test…`);
    execFileSync("curl", ["-sfL", "-o", file, model.url]);
  }
}

const mirror = createServer((req, res) => {
  const total = statSync(MIRROR_FILE).size;
  const match = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? "");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Accept-Ranges", "bytes");
  if (!match) { res.writeHead(400); res.end("Range required"); return; }
  const from = Number(match[1]), to = Math.min(Number(match[2]), total - 1);
  res.writeHead(206, { "Content-Range": `bytes ${from}-${to}/${total}`, "Content-Length": to - from + 1 });
  createReadStream(MIRROR_FILE, { start: from, end: to }).pipe(res);
});
await new Promise((resolve) => mirror.listen(4180, resolve));

async function startServer() {
  // Stage the built PWA under a host application's own path to verify same-origin bundling.
  const hostBundle = ".cache/portable-slm-host-bundle";
  rmSync(hostBundle, { recursive: true, force: true });
  cpSync("dist", hostBundle, { recursive: true });
  mkdirSync("dist/portable-slm", { recursive: true });
  cpSync(hostBundle, "dist/portable-slm", { recursive: true });
  writeFileSync("dist/host-fixture.html", `<!doctype html><meta charset="utf-8"><title>Host fixture</title>
    <a id="host-nada" href="./portable-slm/catalogue-qa.html#source=nada&amp;id=Test002_OD&amp;apiBase=%2Findex.php%2Fapi%2F&amp;catalogBase=%2Findex.php%2Fcatalog%2F">Ask about this NADA study</a>
    <a id="host-editor" href="./portable-slm/field-suggest.html#source=metadata-editor&amp;id=TEST-EDITOR-1&amp;apiBase=%2Findex.php%2Fapi%2F">Review this Editor field</a>`);
  const server = spawn("node_modules/.bin/vite", ["preview", "--port", String(PORT), "--strictPort"], { stdio: "pipe", env: { ...process.env, NO_COLOR: "1" } });
  await new Promise((resolve, reject) => {
    server.stdout.on("data", (d) => /Local/.test(String(d)) && resolve());
    server.on("exit", (code) => reject(new Error(`preview server exited (${code})`)));
  });
  return server;
}

const launch = (extraArgs = []) =>
  puppeteer.launch({ executablePath: CHROME, headless: true, userDataDir: PROFILE, protocolTimeout: 600_000, args: ["--enable-unsafe-webgpu", ...extraArgs] });

async function openApp(browser) {
  const page = await browser.newPage();
  page.on("console", (m) => m.type() === "error" && console.log("  [page error]", m.text()));
  page.on("pageerror", (e) => console.log("  [page exception]", e.message));
  await page.goto(URL);
  await page.waitForFunction(() => document.querySelector("#status").textContent !== "Starting…");
  return page;
}

const status = (page) => page.$eval("#status", (el) => el.textContent);
async function waitStatus(page, re, timeout = 600_000) {
  try {
    await page.waitForFunction((src) => new RegExp(src).test(document.querySelector("#status").textContent), { timeout, polling: 500 }, re.source);
  } catch (err) {
    throw new Error(`status never matched ${re}; last status: "${await status(page)}"`, { cause: err });
  }
}
const INSTALLED = /is on this device/;

async function selectModel(page, id, engine = "auto") {
  await page.select("#model", id);
  await page.select("#engine", engine);
  await page.waitForFunction(() => !document.querySelector("#model").disabled);
}

async function loadAndAsk(page, id, engine) {
  await selectModel(page, id, engine);
  await waitStatus(page, /is on this device|Ready/, 30_000);
  const t0 = Date.now();
  await page.click("#load");
  await waitStatus(page, /^(Ready|Could not)/);
  const s = await status(page);
  console.log(`  ${s} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  assert.match(s, /^Ready/);
  if (engine !== "auto") assert.match(s, new RegExp(`on ${engine}$`));
  const before = await page.$$eval("#log .assistant", (els) => els.length);
  await page.type("#prompt", "What is the capital of France? Answer in one word.");
  await page.click("#send");
  await page.waitForFunction((n) => document.querySelectorAll("#log .assistant .meta, #log .assistant.error").length > n, { timeout: 300_000 }, before);
  const answer = await page.$$eval("#log .assistant", (els) => els.at(-1).textContent);
  console.log("  answer:", answer);
  assert.match(answer, /paris/i);
}

console.log("[1/2] online: install app, download one model, import another from a file");
let server = await startServer();
let browser = await launch();
try {
  const page = await openApp(browser);
  await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready;
    await reg.update();
    while (reg.installing || reg.waiting) await new Promise((r) => setTimeout(r, 200));
  });
  await page.click("#offline-check");
  await page.waitForFunction(() => document.querySelector("#offline-status").textContent.includes("app cached"), { timeout: 20_000 });
  await page.reload();
  await page.waitForSelector("#use-tools");
  await page.waitForFunction(() => document.querySelector("#status").textContent !== "Starting…");

  await selectModel(page, DOWNLOAD_ID);
  if (!INSTALLED.test(await status(page))) {
    const t0 = Date.now();
    const requests = [];
    page.on("request", (request) => { if (request.url().endsWith(".gguf")) requests.push(request.url()); });
    await page.type("#mirror", MIRROR_URL);
    await page.click("#download");
    await waitStatus(page, /is on this device|failed/i);
    console.log(`  mirror download: ${await status(page)} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    assert.ok(requests.length && requests.every((url) => url === MIRROR_URL), `unexpected model source: ${requests.join(", ")}`);
  }
  assert.match(await status(page), INSTALLED);

  await selectModel(page, IMPORT_ID);
  if (!INSTALLED.test(await status(page))) {
    const t0 = Date.now();
    const input = await page.$("#import");
    await input.uploadFile(IMPORT_FILE);
    await waitStatus(page, /is on this device|failed/i);
    console.log(`  import: ${await status(page)} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  }
  assert.match(await status(page), INSTALLED);
  await page.click("#offline-check");
  await page.waitForFunction(() => document.querySelector("#offline-status").textContent.startsWith("Ready offline"), { timeout: 20_000 });
  console.log("  app shell and verified model report ready offline");
  await loadAndAsk(page, IMPORT_ID, "auto");
  await page.close();
  const integration = await browser.newPage();
  await integration.setRequestInterception(true);
  integration.on("request", (request) => {
    if (request.url().includes("/index.php/api/editor/json-field/")) {
      request.respond({ status: 200, contentType: "application/json", body: JSON.stringify({ status: "success", found: true, value: "Household Survey from API" }) });
    } else if (request.url().includes("/index.php/api/catalog/")) {
      request.respond({ status: 200, contentType: "application/json", body: JSON.stringify({ idno: "TEST-2030", study_desc: { title_statement: { title: "Study from API" }, study_info: { abstract: "Authorized catalog abstract" } } }) });
    } else request.continue();
  });
  await integration.goto(`${URL}field-suggest.html`);
  await integration.select("#source", "metadata-editor");
  await integration.click("#read-api");
  await integration.waitForFunction(() => document.querySelector("#snapshot").value.includes("Household Survey from API"), { timeout: 20_000 });
  await integration.click("#suggest");
  await integration.waitForFunction(() => /Suggestion ready|Could not create/.test(document.querySelector("#status").textContent), { timeout: 120_000 });
  assert.match(await integration.$eval("#status", (el) => el.textContent), /Suggestion ready/);
  await integration.select("#source", "nada");
  await integration.click("#read-api");
  await integration.waitForFunction(() => document.querySelector("#snapshot").value.includes("Study from API"), { timeout: 20_000 });
  console.log("  Editor and NADA API adapters read authorized field/study fixtures; suggestion remained read-only");
  await integration.close();
  const nada = await browser.newPage();
  const studyFixture = readFileSync("test/fixtures/nada-popstan.json", "utf8");
  await nada.setRequestInterception(true);
  nada.on("request", (request) => request.url().includes("nada-demo.ihsn.org/index.php/api/catalog/Test001_OD")
    ? request.respond({ status: 200, contentType: "application/json", headers: { "Access-Control-Allow-Origin": "*" }, body: studyFixture })
    : request.continue());
  await nada.goto(`${URL}catalogue-qa.html`);
  await nada.waitForSelector("#nada-fetch");
  await nada.click("#nada-fetch");
  await nada.waitForFunction(() => document.querySelector("#nada-status").textContent.includes("Study saved"), { timeout: 20_000 });
  assert.match(await nada.$eval("#nada-source", (el) => el.textContent), /Popstan Synthetic Household Survey 2023/);
  console.log("  public NADA study saved for offline questions");
  await nada.close();

  const hostNada = await browser.newPage();
  hostNada.on("pageerror", (err) => console.log("  [host NADA page error]", err.message));
  const hostStudy = JSON.parse(studyFixture);
  hostStudy.dataset.idno = "Test002_OD";
  await hostNada.setRequestInterception(true);
  hostNada.on("request", (request) => request.url().includes("/index.php/api/catalog/Test002_OD")
    ? request.respond({ status: 200, contentType: "application/json", body: JSON.stringify(hostStudy) })
    : request.continue());
  await hostNada.goto(`${URL}host-fixture.html`);
  await hostNada.click("#host-nada");
  await hostNada.waitForSelector("#nada-fetch");
  await hostNada.waitForFunction(() => document.querySelector("#nada-model") && document.querySelector("#nada-model").value === "lfm2.5-350m-q4km");
  assert.equal(await hostNada.$eval("#nada-id", (el) => el.value), "Test002_OD");
  assert.match(await hostNada.$eval("#nada-source", (el) => el.textContent), /No saved study/);
  await hostNada.click("#nada-fetch");
  await hostNada.waitForFunction(() => document.querySelector("#nada-status").textContent.includes("Study saved"), { timeout: 20_000 });
  await hostNada.type("#nada-question", "What is the survey used for?");
  await hostNada.click("#nada-ask");
  await hostNada.waitForFunction(() => /Evidence quote|Answer text|Evidence was not found|Model answered|Cannot verify/.test(document.querySelector("#nada-status").textContent), { timeout: 120_000 });
  assert.ok((await hostNada.$eval("#nada-answer", (el) => el.textContent)).length > 0);
  console.log("  NADA host bundle read same-origin API and answered with cached local model");
  await hostNada.close();

  const hostEditor = await browser.newPage();
  hostEditor.on("pageerror", (err) => console.log("  [host Editor page error]", err.message));
  const editorWrites = [];
  await hostEditor.setRequestInterception(true);
  hostEditor.on("request", (request) => {
    if (request.url().includes("/index.php/api/editor/json-field/TEST-EDITOR-1")) {
      return request.respond({ status: 200, contentType: "application/json", body: JSON.stringify({ status: "success", found: true, value: "Household survey" }) });
    }
    if (request.url().includes("/index.php/api/editor/") && request.method() !== "GET") editorWrites.push(request.url());
    return request.continue();
  });
  await hostEditor.goto(`${URL}host-fixture.html`);
  await hostEditor.click("#host-editor");
  await hostEditor.waitForFunction(() => document.querySelector("#source")?.value === "metadata-editor");
  assert.equal(await hostEditor.$eval("#record-id", (el) => el.value), "TEST-EDITOR-1");
  await hostEditor.click("#read-api");
  await hostEditor.waitForFunction(() => document.querySelector("#snapshot").value.includes("Household survey"), { timeout: 20_000 });
  await hostEditor.click("#suggest");
  await hostEditor.waitForFunction(() => /Suggestion ready|Could not create/.test(document.querySelector("#status").textContent), { timeout: 120_000 });
  assert.match(await hostEditor.$eval("#status", (el) => el.textContent), /Suggestion ready/);
  assert.deepEqual(editorWrites, []);
  console.log("  Metadata Editor host bundle read one authorized field and returned draft without writes");
  await hostEditor.close();

  const host = await browser.newPage();
  await host.goto(URL);
  await host.evaluate(() => {
    const frame = document.createElement("iframe");
    frame.id = "embedded-app";
    frame.src = "./";
    document.body.append(frame);
  });
  const embedded = await (await host.waitForSelector("#embedded-app")).contentFrame();
  await embedded.waitForFunction(() => !document.querySelector('button[data-view="field-suggest"]').hidden);
  await embedded.click('button[data-view="field-suggest"]');
  await embedded.waitForFunction(() => document.querySelector("#embedded-view:not([hidden]) #metadata-widget #status")?.textContent.includes("Model ready"), { timeout: 20_000 });
  assert.match(embedded.url(), /localhost:4173\/$/); // outer app must not navigate
  await embedded.click("#back-to-chat");
  await embedded.click('button[data-view="benchmark"]');
  await embedded.waitForSelector("#embedded-view:not([hidden]) #compare");
  await embedded.click("#back-to-chat");
  await embedded.click('button[data-view="catalogue-qa"]');
  await embedded.waitForFunction(() => document.querySelector("#embedded-view:not([hidden]) #nada-source")?.textContent.includes("Popstan"));
  assert.match(embedded.url(), /localhost:4173\/$/);
  console.log("  embedded links mount consumers in the same document and share model storage");
  await host.close();
} finally {
  await browser.close();
  server.kill();
  mirror.close();
}

console.log("[2/2] offline: server stopped, all DNS blocked");
browser = await launch(["--host-resolver-rules=MAP * ~NOTFOUND"]);
try {
  const page = await openApp(browser);
  console.log("  env:", await page.$eval("#env", (el) => el.textContent));
  await page.click("#offline-check");
  await page.waitForFunction(() => document.querySelector("#offline-status").textContent.startsWith("Ready offline"), { timeout: 20_000 });
  await loadAndAsk(page, IMPORT_ID, "webgpu");
  await page.click("#use-tools");
  await page.type("#prompt", "Use get_datetime to tell me today's date. You must call the tool.");
  await page.click("#send");
  await page.waitForFunction(() => document.querySelector("#log .tool") || /Generation failed/.test(document.querySelector("#status").textContent), { timeout: 120_000 });
  assert.match(await page.$eval("#log .tool", (el) => el.textContent), /get_datetime/);
  await page.waitForFunction(() => !document.querySelector("#send").disabled, { timeout: 120_000 });
  console.log("  offline model called get_datetime and completed a tool round");
  await page.click("#use-tools");
  await loadAndAsk(page, DOWNLOAD_ID, "cpu");
  await page.select("#max-tokens", "256");
  for (let turn = 1; turn <= 4; turn++) {
    const before = await page.$$eval("#log .assistant .meta", (els) => els.length);
    await page.type("#prompt", `Explain a practical use for a small language model in field work. Example ${turn}.`);
    await page.click("#send");
    await page.waitForFunction((count) =>
      document.querySelectorAll("#log .assistant .meta").length > count || /Generation failed/.test(document.querySelector("#status").textContent),
    { timeout: 120_000 }, before);
    assert.match(await status(page), /^Ready/);
  }
  console.log("  4 consecutive chat turns completed; diagnostics persisted");
  await page.close();
  const review = await browser.newPage();
  await review.goto(`${URL}field-suggest.html`);
  await review.waitForFunction(() => document.querySelector("#status").textContent.includes("Model ready"), { timeout: 20_000 });
  await review.click("#suggest");
  await review.waitForFunction(() => /Suggestion ready|Could not create/.test(document.querySelector("#status").textContent), { timeout: 120_000 });
  assert.match(await review.$eval("#status", (el) => el.textContent), /Suggestion ready/);
  console.log("  second UI used same cached model offline for a metadata suggestion");
  await review.close();
  const nada = await browser.newPage();
  await nada.goto(`${URL}catalogue-qa.html`);
  await nada.waitForFunction(() => document.querySelector("#nada-source")?.textContent.includes("Popstan"), { timeout: 20_000 });
  await nada.waitForFunction(() => !document.querySelector("#nada-ask").disabled, { timeout: 20_000 });
  await nada.type("#nada-question", "What is the study title?");
  await nada.click("#nada-ask");
  await nada.waitForFunction(() => /Evidence quote|Answer text|Evidence was not found|Model answered|Cannot verify/.test(document.querySelector("#nada-status").textContent), { timeout: 120_000 });
  assert.match(await nada.$eval("#nada-answer", (el) => el.textContent), /Popstan/);
  console.log("  saved public NADA snapshot answered locally with server and DNS blocked");
  await nada.close();
  const bench = await browser.newPage();
  await bench.goto(`${URL}benchmark.html`);
  await bench.waitForFunction(() => document.querySelector("#status").textContent.includes("Model installed"), { timeout: 20_000 });
  await bench.click("#run");
  await bench.waitForFunction(() => /Done:|Benchmark stopped/.test(document.querySelector("#status").textContent), { timeout: 300_000 });
  assert.match(await bench.$eval("#status", (el) => el.textContent), /Done: 12 cases/);
  await bench.select("#model", DOWNLOAD_ID);
  await bench.select("#engine", "cpu");
  await bench.waitForFunction(() => document.querySelector("#status").textContent.includes("Model installed") && !document.querySelector("#run").disabled);
  await bench.click("#run");
  await bench.waitForFunction(() => /Done:|Benchmark stopped/.test(document.querySelector("#status").textContent), { timeout: 300_000 });
  assert.match(await bench.$eval("#status", (el) => el.textContent), /Done: 12 cases/);
  assert.ok((await bench.$$eval("#compare tr", (rows) => rows.length)) >= 2);
  console.log("  third UI compared 230M and 350M across 12 general-task cases entirely offline");
  await bench.close();
  const phone = await browser.newPage();
  await phone.setUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 Version/26.0 Mobile/15E148 Safari/604.1");
  await phone.goto(URL);
  await waitStatus(phone, /is on this device/);
  assert.equal(await phone.$eval("#max-tokens", (el) => el.value), "256");
  await selectModel(phone, IMPORT_ID, "auto");
  await phone.click("#load");
  await waitStatus(phone, /^(Ready|Could not)/);
  assert.match(await status(phone), / on cpu$/);
  console.log("  simulated iPhone auto: CPU, 256-token replies");
} finally {
  await browser.close();
}
console.log("PASS: download + file import online, then both models on WebGPU and CPU fully offline");
