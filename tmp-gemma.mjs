// Does the 181 MB tier work in a browser at all? Isolated from the page's indexing loop.
import puppeteer from "puppeteer-core";
const browser = await puppeteer.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: "new", args: ["--no-sandbox"] });
try {
  const page = await browser.newPage();
  await page.setCacheEnabled(false);
  page.on("console", (m) => { const t = m.text(); if (/gemma|embed|download|progress|error|fail/i.test(t)) console.log("  console:", t.slice(0, 150)); });
  page.on("pageerror", (e) => console.log("  pageerror:", e.message.slice(0, 200)));
  await page.goto("https://rafmacalaba.github.io/", { waitUntil: "networkidle2" });
  const result = await page.evaluate(async () => {
    const stamp = await (await fetch("/portable-slm/version.json")).json();
    const mod = await import(`/portable-slm/embed.js?v=${stamp.gitSha}`);
    const embedder = mod.createEmbedder({});
    const id = "embeddinggemma-2-text-q4f16";
    const steps = [];
    const t0 = performance.now();
    const status = await embedder.status(id);
    steps.push(`status: ${JSON.stringify(status)} at ${((performance.now() - t0) / 1000).toFixed(0)}s`);
    let last = 0;
    await embedder.download(id, { onProgress: (p) => {
      const pct = p.total ? Math.round((p.received / p.total) * 100) : -1;
      if (pct >= last + 20) { last = pct; steps.push(`download ${pct}% at ${((performance.now() - t0) / 1000).toFixed(0)}s`); }
    } });
    steps.push(`downloaded at ${((performance.now() - t0) / 1000).toFixed(0)}s`);
    await embedder.load(id);
    steps.push(`loaded at ${((performance.now() - t0) / 1000).toFixed(0)}s`);
    const [v] = await embedder.embed(["did he publish anything about global warming"], { kind: "query", dims: 256 });
    steps.push(`embedded: ${v.length} dims, norm ${Math.sqrt([...v].reduce((s, x) => s + x * x, 0)).toFixed(4)} at ${((performance.now() - t0) / 1000).toFixed(0)}s`);
    return steps;
  });
  result.forEach((s) => console.log("  " + s));
} finally { await browser.close(); }
