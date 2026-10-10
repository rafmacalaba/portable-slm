// Render a realistic model answer through the bundle the editor serves, and inspect the DOM.
import puppeteer from "puppeteer-core";
const ANSWER = [
  "Based on the metadata I can access, here are the fields that are populated and how they could improve:",
  "",
  "### Fields already populated",
  "- **Title** - \"Household Income and Expenditure Survey 2025 (Sample)\"",
  "- **Abstract** - the survey collects information on household composition, educational attainment,",
  "  employment and monthly income. This record is a synthetic demo.",
  "- **Universe** - \"All private households resident in the country for at least six months.\"",
  "",
  "### Suggested improvements",
  "- **Abstract** - generic and self-referential. It could be strengthened by:",
  "  - Adding specific methodology details",
  "  - Including the study purpose",
  "- **Document description** - overly generic. It could include the version and release date.",
  "",
  "---",
  "> Note: I cannot see the variables, which may also benefit from improvement.",
].join("\n");
const browser = await puppeteer.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: "new", args: ["--no-sandbox"], defaultViewport: { width: 900, height: 1100 } });
try {
  const page = await browser.newPage();
  await page.setCacheEnabled(false);
  await page.goto("http://localhost:8080/portable-slm/chat.html", { waitUntil: "networkidle2" });
  await page.waitForSelector("pslm-chat", { timeout: 15000 });
  await page.evaluate((answer) => {
    const chat = document.querySelector("pslm-chat");
    chat.ai = {
      status: async () => ({ state: "installed", loaded: true }),
      load: async () => ({}), unload: async () => {},
      generate: async () => ({ text: answer, engine: "stub", ms: 1 }),
      runAgent: async (m, options = {}) => {
        for (const word of answer.split(" ")) { options.onToken?.(word + " "); await new Promise((r) => setTimeout(r, 1)); }
        return { text: answer, engine: "stub", ms: 1 };
      },
    };
    chat.send("what fields are populated and what could be improved?");
  }, ANSWER);
  await page.waitForFunction(() => {
    const chat = document.querySelector("pslm-chat");
    return chat.shadowRoot.querySelectorAll("[part=bubble]").length >= 2;
  }, { timeout: 30000 });
  await new Promise((r) => setTimeout(r, 3000));
  const dom = await page.evaluate(() => {
    const chat = document.querySelector("pslm-chat");
    const bubble = [...chat.shadowRoot.querySelectorAll("[part=bubble]")].pop();
    const q = (sel) => bubble.querySelectorAll(sel).length;
    return { ul: q("ul"), ol: q("ol"), li: q("li"), nestedUl: q("li > ul"), hr: q("hr"), blockquote: q("blockquote"), strong: q("strong"), strayRule: /(^|\s)---(\s|$)/.test(bubble.innerText) };
  });
  console.log("rendered DOM:", JSON.stringify(dom));
  const text = await page.evaluate(() => {
    const chat = document.querySelector("pslm-chat");
    return [...chat.shadowRoot.querySelectorAll("[part=bubble]")].pop().innerText.split("\n").slice(0, 14).join("\n");
  });
  console.log("\nvisible text:\n" + text);
  await page.screenshot({ path: "/tmp/rendered.png", fullPage: true });
  console.log("\nscreenshot: /tmp/rendered.png");
} finally { await browser.close(); }
