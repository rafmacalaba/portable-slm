// Is the ONNX embedder runnable on WebGPU from the deployed site, and what does it buy over CPU?
import puppeteer from "puppeteer-core";
const browser = await puppeteer.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: "new",
  args: ["--no-sandbox", "--enable-unsafe-webgpu"],
});
try {
  const page = await browser.newPage();
  await page.setCacheEnabled(false);
  page.on("pageerror", (e) => console.log("  pageerror:", e.message.slice(0, 160)));
  await page.goto("https://rafmacalaba.github.io/", { waitUntil: "networkidle2" });
  const out = await page.evaluate(async () => {
    const report = {};
    report.hasGpu = Boolean(navigator.gpu);
    if (navigator.gpu) {
      const adapter = await navigator.gpu.requestAdapter().catch(() => null);
      report.adapter = adapter ? (adapter.info ? `${adapter.info.vendor} ${adapter.info.architecture}` : "adapter present") : "none";
      report.f16 = adapter ? adapter.features.has("shader-f16") : false;
    }
    const stamp = await (await fetch("/portable-slm/version.json")).json();
    const mod = await import(`/portable-slm/embed.js?v=${stamp.gitSha}`);
    const { assets } = await mod.loadConfig("/portable-slm/quality.host.json");
    report.assetsPresent = Boolean(assets?.onnxWasm && assets?.onnxMjs);
    if (!report.assetsPresent || !navigator.gpu) return report;

    const id = "embeddinggemma-2-text-q4f16";
    const embedder = mod.createEmbedder({ assets });
    const state = await embedder.status(id);
    if (state.state !== "installed") {
      const t0 = performance.now();
      await embedder.download(id, { onProgress: (p) => { if (p.total) report.downloadPct = Math.round((p.received / p.total) * 100); } });
      report.downloadSeconds = Math.round((performance.now() - t0) / 1000);
    } else report.downloadSeconds = 0;

    for (const device of ["webgpu", "cpu"]) {
      try {
        const t0 = performance.now();
        await embedder.load(id, { device });
        const loadMs = performance.now() - t0;
        const [v] = await embedder.embed(["did he publish anything about global warming"], { kind: "query", dims: 256 });
        const t1 = performance.now();
        for (let i = 0; i < 10; i++) await embedder.embed([`sample query number ${i} about the site`], { kind: "query", dims: 256 });
        report[device] = {
          loadSeconds: +(loadMs / 1000).toFixed(1),
          dims: v.length,
          norm: +Math.sqrt([...v].reduce((s, x) => s + x * x, 0)).toFixed(4),
          msPerEmbed: +((performance.now() - t1) / 10).toFixed(1),
        };
      } catch (err) {
        report[device] = { error: err.message.slice(0, 120) };
      }
      await embedder.unload().catch(() => {});
    }
    return report;
  });
  console.log(JSON.stringify(out, null, 2));
} finally { await browser.close(); }
