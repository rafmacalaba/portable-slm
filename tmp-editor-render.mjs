// The same answer through the bundle the editor serves, exercising the shapes a model actually emits.
import puppeteer from "puppeteer-core";
const ANSWER = [
  "### Fields already populated",
  "- **Title** - \"Household Income and Expenditure Survey 2025 (Sample)\"",
  "- **Abstract** - the survey collects information on household composition,",
  "  educational attainment, employment and monthly income.",
  "- **Universe** - available at `/index.php/editor/edit/123`.",
  "",
  "### Suggested improvements",
  "- **Abstract** - generic. It could be strengthened by:",
  "  - Adding methodology details",
  "  - Including the study purpose",
  "",
  "| Field | Current | Suggested |",
  "| --- | --- | --- |",
  "| Title | short | add version |",
  "| Abstract | generic | add method |",
  "",
  "---",
  "> Note: a synthetic demo record. See the [handbook](https://example.com/hb).",
  "",
  "```json",
  "{ \"idno\": \"HIES-2025\" }",
  "```",
].join("\n");
const browser = await puppeteer.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: "new", args: ["--no-sandbox"], defaultViewport: { width: 940, height: 1250 } });
try {
  const page = await browser.newPage();
  await page.setCacheEnabled(false);
  const fetched = [];
  page.on("request", (r) => { if (/markdown-it/.test(r.url())) fetched.push(r.url().split("/").pop()); });
  await page.goto("http://localhost:8080/portable-slm/chat.html", { waitUntil: "networkidle2" });
  await page.waitForSelector("pslm-chat");
  const beforeFetch = fetched.length;
  await page.evaluate((answer) => {
    const chat = document.querySelector("pslm-chat");
    chat.ai = {
      status: async () => ({ state: "installed", loaded: true }), load: async () => ({}), unload: async () => {},
      generate: async () => ({ text: answer, engine: "stub", ms: 1 }),
      runAgent: async (m, o = {}) => { for (const w of answer.split(" ")) { o.onToken?.(w + " "); await new Promise((r) => setTimeout(r, 0.5)); } return { text: answer, engine: "stub", ms: 1 }; },
    };
    chat.send("what fields are populated and what could be improved?");
  }, ANSWER);
  await page.waitForFunction(() => document.querySelector("pslm-chat").shadowRoot.querySelectorAll("[part=bubble]").length >= 2, { timeout: 30000 });
  await new Promise((r) => setTimeout(r, 2500));
  const dom = await page.evaluate(() => {
    const chat = document.querySelector("pslm-chat");
    const b = [...chat.shadowRoot.querySelectorAll("[part=bubble]")].pop();
    const q = (s) => b.querySelectorAll(s).length;
    return { h3: q("h3"), ul: q("ul"), li: q("li"), nested: q("li > ul"), table: q("table"), tr: q("tr"), hr: q("hr"), blockquote: q("blockquote"), pre: q("pre"), code: q("code"), strong: q("strong"), links: q("a"), literalRule: /^\s*---\s*$/m.test(b.innerText) };
  });
  console.log("rendered:", JSON.stringify(dom));
  console.log("parser chunk fetched before the answer:", beforeFetch, "| after:", fetched.length, fetched.join(","));
  await page.screenshot({ path: "/tmp/editor-render.png", fullPage: true });
  console.log("screenshot: /tmp/editor-render.png");
} finally { await browser.close(); }
