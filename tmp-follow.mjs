import puppeteer from "puppeteer-core";
const browser = await puppeteer.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: "new", args: ["--no-sandbox"], defaultViewport: { width: 1280, height: 800 } });
try {
  const page = await browser.newPage();
  await page.setCacheEnabled(false);
  await page.goto("https://rafmacalaba.github.io/", { waitUntil: "networkidle2" });
  await page.waitForSelector('button[part="launcher"]');
  await page.click('button[part="launcher"]');
  await page.waitForTimeout ? null : null;
  await new Promise((r) => setTimeout(r, 2500));

  await page.evaluate(() => {
    const chat = document.querySelector("[data-pslm] pslm-chat");
    // Swap the engine for a stub that streams the way the real one does: token by token, with real pauses.
    chat.ai = {
      status: async () => ({ state: "installed", loaded: true }),
      load: async () => ({}),
      unload: async () => {},
      generate: async (messages, { onToken } = {}) => {
        const words = Array.from({ length: 500 }, (_, i) => `word${i}`);
        for (const w of words) { onToken?.(`${w} `); await new Promise((r) => setTimeout(r, 4)); }
        return { text: words.join(" "), engine: "stub", ms: 1 };
      },
      runAgent: async (messages, options = {}) => {
        const words = Array.from({ length: 600 }, (_, i) => `streamed${i}`);
        for (const w of words) { options.onToken?.(`${w} `); await new Promise((r) => setTimeout(r, 3)); }
        return { text: words.join(" "), engine: "stub", ms: 1 };
      },
    };
    window.__stub = true;
  });

  const measure = () => page.evaluate(() => {
    const chat = document.querySelector("[data-pslm] pslm-chat");
    const log = chat.shadowRoot.querySelector("[part=log]");
    const bubbles = [...chat.shadowRoot.querySelectorAll("[part=bubble]")];
    const last = bubbles[bubbles.length - 1];
    const lr = log.getBoundingClientRect(), br = last?.getBoundingClientRect();
    return {
      bubbles: bubbles.length,
      scrollHeight: log.scrollHeight, clientHeight: log.clientHeight,
      scrollTop: Math.round(log.scrollTop),
      distanceFromBottom: Math.round(log.scrollHeight - log.scrollTop - log.clientHeight),
      lastBottom: br ? Math.round(br.bottom) : null, logBottom: Math.round(lr.bottom),
      lastVisible: br ? br.bottom <= lr.bottom + 1 : null,
    };
  });

  await page.evaluate(() => {
    const chat = document.querySelector("[data-pslm] pslm-chat");
    chat.send("what did he build for agent orchestration, and how does it decide that a phase is finished");
  });
  const samples = [];
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 200));
    samples.push(await measure());
    const m = samples[samples.length - 1];
    if (m.bubbles >= 2 && m.distanceFromBottom > 0) break;
  }
  const last = samples[samples.length - 1];
  console.log("stub active:", await page.evaluate(() => window.__stub === true));
  console.log("mid-stream:", JSON.stringify(last));
  await new Promise((r) => setTimeout(r, 4000));
  console.log("settled:   ", JSON.stringify(await measure()));
  const bad = samples.filter((m) => m.bubbles >= 2 && m.distanceFromBottom > 0);
  console.log(`samples: ${samples.length} | samples off the bottom: ${bad.length}`);
  if (bad.length) console.log("first off-bottom:", JSON.stringify(bad[0]));
} finally { await browser.close(); }
