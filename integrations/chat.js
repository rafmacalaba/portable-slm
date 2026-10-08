// <pslm-chat> — the vanilla chat surface. Framework-free custom element, no host knowledge:
// context arrives through `onContext`, inference stays on-device, and nothing writes to a host.
//
//   <pslm-chat model="lfm2.5-350m-q4km" tools="offline"></pslm-chat>
//   chat.onContext = async () => await myAuthorizedSnapshot();
//
// See docs/CHAT.md for attributes, events and theming.
import { createLocalSLM } from "../src/index.js";
import { MODELS } from "../src/models.js";
import { assessCompleteness, describeIncomplete } from "../src/completeness.js";
import { defaultTools } from "../src/tools.js";
import { buildMessages, composeContext, DIRECT_REPLY_NOTE, formatGrounding, lexicalGrounding, parseMarkdown, resolveTools, routesDirect, toolInstructions } from "./chat-core.js";

// Shared by the element's shadow styles and the host-facing panel template, so a formatted answer
// looks the same in the chat bubble and in the suggest output pane.
// Generation budgets, in tokens. Reasoning and the answer share this one pool (see send()): a
// single decode has one max_new_tokens, so there is no separate reasoning cap to set.
export const BUDGETS = { toolTurn: 4096, plainTurn: 2048 };

export const MD_CSS = `
.md{white-space:normal}
.md p{margin:0 0 .4rem;white-space:pre-wrap}
.md p:last-child{margin-bottom:0}
.md ul,.md ol{margin:.2rem 0 .5rem;padding-left:1.3rem}
.md li{margin:.15rem 0}
.md code{font:12.5px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;background:#eaeef2;
   padding:.05rem .25rem;border-radius:4px}
.md pre{margin:.3rem 0;padding:.5rem .6rem;background:#eaeef2;border-radius:6px;overflow:auto;
   white-space:pre}
.md pre code{background:none;padding:0}
.md table{border-collapse:collapse;margin:.3rem 0;font-size:12px;display:block;overflow-x:auto;max-width:100%}
.md th,.md td{border:1px solid #d7dee6;padding:.25rem .5rem;text-align:left;vertical-align:top}
.md th{background:#eef2f6;font-weight:600}
.md h4,.md h5,.md h6{margin:.45rem 0 .2rem;font-size:.94em}
.md li:last-child{margin-bottom:0}
`;

const CSS = `
:host{display:flex;flex-direction:column;gap:.5rem;font:14px/1.5 system-ui,sans-serif;color:#1c2b36;
      background:#f7f9fc;border:1px solid #d0d7de;border-radius:12px;padding:.75rem;
      box-sizing:border-box;max-width:100%;min-width:0;min-height:0;overflow:hidden}
[part=bar]{display:flex;gap:.5rem;align-items:center;flex-wrap:wrap;font-size:12px;color:#57606a}
[part=state]{font-weight:600}
[part=state][data-tone=ok]{color:#1a7f37}[part=state][data-tone=warn]{color:#9a6700}
[part=state][data-tone=err]{color:#cf222e}
/* min-height:0 is what makes this scroll at all: a flex item defaults to min-height:auto and
   would grow to its content instead of constraining it. content-visibility is deliberately
   absent — contained subtrees report a wrong scrollHeight, so the transcript cannot scroll. */
[part=log]{flex:1 1 auto;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:.6rem;padding:.25rem .1rem}
[part=bubble]{white-space:pre-wrap;word-break:break-word;padding:.55rem .75rem;border-radius:12px;
  background:#fff;border:1px solid #e3e9f0;align-self:flex-start;max-width:92%}
[part=bubble][data-role=assistant]{border-bottom-left-radius:4px;box-shadow:0 1px 2px rgba(27,31,36,.04)}
[part=bubble][data-role=user]{background:#0b5fff;border:1px solid #0b5fff;color:#fff;
  align-self:flex-end;border-bottom-right-radius:4px;max-width:85%}
/* Model output is formatted after it streams; user text never is. .md resets the bubble's pre-wrap
   because the parser turned structural newlines into blocks — leaving both would double every break.
   It is scoped to assistant bubbles: user text stays raw on its blue bubble. */
[part=bubble][data-role=assistant] .md p{margin:0 0 .4rem;white-space:pre-wrap}
[part=bubble][data-role=assistant] .md p:last-child{margin-bottom:0}
[part=bubble][data-role=assistant] .md ul,[part=bubble][data-role=assistant] .md ol{margin:.2rem 0 .5rem;padding-left:1.3rem}
[part=bubble][data-role=assistant] .md li{margin:.15rem 0}
[part=bubble][data-role=assistant] .md code{font:12.5px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;background:#eef2f6;
  padding:.05rem .25rem;border-radius:4px}
[part=bubble][data-role=assistant] .md pre{margin:.3rem 0;padding:.5rem .6rem;background:#eef2f6;border-radius:6px;overflow:auto;
  white-space:pre}
[part=bubble][data-role=assistant] .md pre code{background:none;padding:0}
[part=bubble][data-role=assistant] .md h4,[part=bubble][data-role=assistant] .md h5,[part=bubble][data-role=assistant] .md h6{margin:.45rem 0 .2rem;font-size:.94em}
[part=bubble][data-role=assistant] .md li:last-child{margin-bottom:0}
[part=thinking]{align-self:flex-start;font-size:12.5px;color:#57606a;background:#f6f8fa;
  border:1px dashed #d0d7de;border-radius:8px;padding:.3rem .65rem;max-width:85%}
[part=thinking] .dots::after{content:'…';display:inline-block;animation:pslm-dots 1.2s steps(4) infinite}
[part=think-details]{margin-top:.3rem;font-size:11.5px}
[part=think-details] summary{cursor:pointer;color:#57606a;user-select:none}
[part=think-details][open] summary{margin-bottom:.25rem}
[part=think-details] pre{margin:0;white-space:pre-wrap;word-break:break-word;max-height:10rem;
  overflow-y:auto;background:#eef2f6;border-radius:6px;padding:.4rem .5rem;font-size:11px;color:#3b4a5a}
@keyframes pslm-dots{0%{content:''}25%{content:'.'}50%{content:'..'}75%{content:'...'}}
@media (prefers-reduced-motion:reduce){[part=thinking] .dots::after{content:'';animation:none}}
[part=cap-note]{margin-top:.35rem;font-size:12px;color:#9a6700;background:#fff8c5;
  border:1px solid #bf8700;border-radius:8px;padding:.3rem .6rem}
[part=prov]{margin-top:.35rem;font-size:11px;color:#57606a;cursor:help}
[part=prov]:hover,[part=prov]:focus-visible{color:#1c2b36}
/* Inline expansion, not a floating popup: the transcript scrolls, and absolutely-positioned
   popups get clipped by its overflow at almost any panel size. */
[part=prov-pop]{display:none;margin-top:.3rem;padding:.45rem .6rem;background:#fff;
  border:1px solid #d0d7de;border-radius:8px;font-size:11.5px;color:#57606a;max-width:100%}
[part=prov]:hover [part=prov-pop],[part=prov]:focus [part=prov-pop],
[part=prov]:focus-visible [part=prov-pop],[part=prov]:focus-within [part=prov-pop]{display:block}
[part=prov-pop] div{margin:.15rem 0}
[part=sent]{font-size:12px;color:#57606a;flex:0 0 auto;max-width:100%}
[part=sent] pre{white-space:pre-wrap;word-break:break-word;max-height:14rem;overflow:auto;
      background:#f6f8fa;padding:.5rem;border-radius:6px;max-width:100%}
[part=composer]{display:flex;gap:.5rem;align-items:flex-end;flex:0 0 auto}
[part=input]{flex:1;min-width:0;resize:vertical;min-height:2.6rem;font:inherit;padding:.45rem .6rem;
      border:1px solid #d0d7de;border-radius:10px;box-sizing:border-box;background:#fbfcfe}
[part=input]:focus-visible{outline:2px solid #0b5fff;outline-offset:1px;background:#fff}
button{font:inherit;padding:.35rem .75rem;border-radius:999px;border:1px solid #d0d7de;background:#fff;cursor:pointer}
button:hover{background:#f0f5fc}
button:disabled{opacity:.55;cursor:default}
[part=send]{background:#0b5fff;border-color:#0b5fff;color:#fff;font-weight:600}
[part=send]:hover{background:#0a54e6}
[part=approve]{border:1px solid #bf8700;background:#fff8c5;border-radius:8px;padding:.6rem;display:grid;gap:.5rem;flex:0 0 auto}
[part=approve] pre{margin:0;white-space:pre-wrap;word-break:break-all;font-size:12px}
[part=approve] .row{display:flex;gap:.5rem;justify-content:flex-end}
[part=tools]{display:flex;flex-wrap:wrap;gap:.35rem;flex:0 0 auto}
[part=tools] .chip{font-size:12px;border-radius:999px;padding:.1rem .6rem;background:#eef2ff;
  border:1px solid #d7dcfb;color:#3730a3}
[part=tools] .chip[data-state=running]{background:#fff8c5;border-color:#bf8700;color:#7a5b00}
[part=tools] .chip[data-state=denied],[part=tools] .chip[data-state=error]{background:#ffebe9;
  border-color:#ff818266;color:#cf222e}
[part=tools] .chip[data-state=capped]{background:#fff8c5;border-color:#bf8700;color:#7a5b00}
/* Available-tools popup: hover or keyboard focus reveals the list; no click needed to know. */
[part=tools-info]{position:relative;font-size:12px;color:#57606a;cursor:help;border:1px solid #d0d7de;
  border-radius:999px;padding:.1rem .6rem;background:#f6f8fa}
[part=tools-info]:hover,[part=tools-info]:focus-visible{background:#eef2ff;border-color:#d7dcfb;color:#3730a3}
[part=tools-pop]{display:none;position:absolute;bottom:calc(100% + .4rem);right:0;z-index:20;
  width:22rem;max-width:80vw;max-height:16rem;overflow:auto;background:#fff;border:1px solid #d0d7de;
  border-radius:8px;box-shadow:0 4px 16px rgba(27,31,36,.18);padding:.5rem;text-align:left}
[part=tools-info]:hover [part=tools-pop],[part=tools-info]:focus-visible [part=tools-pop],
[part=tools-info]:focus-within [part=tools-pop]{display:block}
[part=tools-pop] .row{margin:.25rem 0}
[part=tools-pop] .row b{display:block;font-size:12px;color:#1c2b36}
[part=tools-pop] .row span{font-size:11.5px;color:#57606a}
[hidden]{display:none}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
`;


function runsToNodes(runs) {
  const frag = document.createDocumentFragment();
  for (const run of runs) {
    if (run.t === "text") { frag.append(document.createTextNode(run.v)); continue; }
    // textContent only, always: model output is untrusted and never reaches the DOM as markup.
    const el = document.createElement(run.t === "code" ? "code" : run.t === "strong" ? "strong" : "em");
    el.textContent = run.v;
    frag.append(el);
  }
  return frag;
}

/**
 * Format model output as DOM. Never innerHTML, never for user text (that is data, and formatting it
 * would let a pasted `**` look like the assistant's emphasis), and never for the "what was sent"
 * disclosure — the audit view shows exactly what went in, markers and all.
 */
export function renderMarkdown(text) {
  const box = document.createElement("div");
  box.className = "md";
  for (const block of parseMarkdown(text)) {
    if (block.type === "code") {
      const pre = document.createElement("pre");
      const code = document.createElement("code");
      code.textContent = block.text;
      pre.append(code);
      if (block.lang) pre.dataset.lang = block.lang;
      box.append(pre);
      continue;
    }
    if (block.type === "list") {
      const ul = document.createElement(block.ordered ? "ol" : "ul");
      for (const item of block.items) {
        const li = document.createElement("li");
        li.append(runsToNodes(item));
        ul.append(li);
      }
      box.append(ul);
      continue;
    }
    if (block.type === "table") {
      const table = document.createElement("table");
      if (block.header.length) {
        const thead = document.createElement("thead");
        const headRow = document.createElement("tr");
        for (const cell of block.header) { const th = document.createElement("th"); th.append(runsToNodes(cell)); headRow.append(th); }
        thead.append(headRow); table.append(thead);
      }
      const tbody = document.createElement("tbody");
      for (const row of block.rows) {
        const tr = document.createElement("tr");
        for (const cell of row) { const td = document.createElement("td"); td.append(runsToNodes(cell)); tr.append(td); }
        tbody.append(tr);
      }
      table.append(tbody);
      box.append(table);
      continue;
    }
    // A `#` from the model is a heading inside a bubble, not in the host document: cap it at h4–h6
    // so an embedded assistant cannot outrank the page it sits in.
    const el = document.createElement(block.type === "heading" ? `h${Math.min(6, block.level + 3)}` : "p");
    el.append(runsToNodes(block.runs));
    box.append(el);
  }
  return box;
}

async function assetsNextToBundle() {
  const here = new URL(".", import.meta.url);
  const res = await fetch(new URL("embed-assets.json", here), { credentials: "same-origin" });
  if (!res.ok) throw new Error(`embed-assets.json returned HTTP ${res.status}`);
  const map = await res.json();
  const assets = {};
  for (const [key, path] of Object.entries(map)) assets[key] = new URL(path, here).href;
  return assets;
}

export class PslmChat extends HTMLElement {
  static observedAttributes = ["model", "system", "tools", "allow-network", "placeholder", "no-model-bar"];

  #ai = null;
  #history = [];
  #abort = null;
  #contextProvider = null;
  #sentText = "";
  #stick = true;

  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    /** Host override for the approval UI; return true to allow an online tool call. */
    this.approveTool = null;
    /** Extra or replacement tool definitions. */
    this.tools = null;
  }

  /**
   * Host-supplied async () => context string. Attaching one makes the disclosure visible
   * immediately — a trust affordance you have to ask a question before you can find is not one.
   */
  get onContext() { return this.#contextProvider; }
  set onContext(fn) { this.#contextProvider = fn; this.#updateDisclosure(); }

  get model() { return this.getAttribute("model") || "lfm2.5-350m-q4km"; }
  set model(id) { this.setAttribute("model", id); }
  get system() { return this.getAttribute("system") ?? ""; }
  set system(text) { this.setAttribute("system", text ?? ""); }
  get maxHistory() { return Number(this.getAttribute("max-history") ?? 6); }
  set maxHistory(n) { this.setAttribute("max-history", String(n)); }
  get history() { return this.#history; }
  /** Reuse a host engine so several surfaces share one loaded model. */
  get ai() { return this.#ai; }
  set ai(instance) { this.#ai = instance; this.#refresh(); }

  connectedCallback() {
    this.#render();
    this.#refresh();
  }

  attributeChangedCallback() { this.#refresh(); }

  clear() {
    this.#history = [];
    this.$("[part=log]").replaceChildren();
    this.#stick = true;
    this.#setSent("");
  }

  $ = (sel) => this.shadowRoot?.querySelector(sel);

  /**
   * Follow the newest output only while the reader is already at the bottom. Forcing `scrollTop` on
   * every token is what makes a long answer unreadable: the view snaps back before you can move.
   * Scrolling up releases the follow; returning to the bottom, or sending, re-arms it.
   */
  #logTo(force = false) {
    const log = this.$("[part=log]");
    if (!log) return;
    if (force) this.#stick = true;
    if (this.#stick) log.scrollTop = log.scrollHeight;
  }

  #render() {
    this.shadowRoot.replaceChildren();
    const style = document.createElement("style");
    style.textContent = CSS;
    const shell = document.createElement("div");
    shell.setAttribute("style", "display:contents");
    shell.innerHTML = `
      <section part="bar">
        <span part="state"></span><span part="model"></span>
        <button part="install" type="button" hidden>Install model</button>
        <button part="unload" type="button" hidden>Unload from memory</button>
        <button part="remove" type="button" hidden>Delete cached files</button>
        <button part="import" type="button">Import from file</button>
        <button part="stop" type="button" hidden>Stop</button>
        <span part="tools-info" tabindex="0" hidden>🔧 <span part="tools-count"></span>
          <span part="tools-pop" role="tooltip"></span>
        </span>
        <input part="file" type="file" accept=".gguf" hidden>
      </section>
      <section part="log" role="log" aria-live="polite"></section>
      <details part="sent" hidden><summary>What was sent to the model</summary><pre></pre></details>
      <div part="approve" hidden>
        <strong part="approve-title"></strong><pre part="approve-args"></pre>
        <div class="row"><button part="approve-no" type="button">Deny</button>
        <button part="approve-yes" type="button">Allow once</button></div>
      </div>
      <form part="composer">
        <textarea part="input" rows="2" placeholder="${this.getAttribute("placeholder") ?? "Ask the model…"}"></textarea>
        <button part="send" type="submit">Send</button>
      </form>`;
    this.shadowRoot.append(style, shell);

    this.$("[part=install]").addEventListener("click", () => this.#install());
    this.$("[part=unload]").addEventListener("click", () => this.#unload());
    this.$("[part=remove]").addEventListener("click", () => this.#remove());
    this.$("[part=import]").addEventListener("click", () => this.$("[part=file]").click());
    this.$("[part=file]").addEventListener("change", (e) => this.#import(e.target.files[0]));
    this.$("[part=stop]").addEventListener("click", () => this.#abort?.abort());
    this.$("[part=composer]").addEventListener("submit", (e) => { e.preventDefault(); this.send(); });
    this.$("[part=input]").addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); this.send(); }
    });
    // A scroll event also fires for our own programmatic moves, which land at the bottom — so this
    // re-arms the follow exactly when the reader returns to the end, and releases it when they leave.
    const log = this.$("[part=log]");
    log.addEventListener("scroll", () => {
      this.#stick = log.scrollHeight - log.scrollTop - log.clientHeight < 32;
    }, { passive: true });
    this.#updateDisclosure(); // a host may have attached onContext before the element connected
  }

  // Attribute-driven chrome updates must not wipe the transcript.
  #refresh() {
    if (!this.$("[part=state]")) return;
    this.$("[part=bar]").hidden = this.hasAttribute("no-model-bar");
    if (!this.#ai) this.#boot();
    else this.#status();
    this.#updateToolsInfo();
  }

  #updateToolsInfo() {
    const info = this.$("[part=tools-info]");
    if (!info) return;
    const tools = resolveTools(this.getAttribute("tools") ?? "offline", {
      tools: this.tools ?? defaultTools(),
      allowNetwork: this.hasAttribute("allow-network"),
    });
    info.hidden = !tools.length;
    this.$("[part=tools-count]").textContent = `${tools.length} tool${tools.length === 1 ? "" : "s"}`;
    const pop = this.$("[part=tools-pop]");
    pop.replaceChildren(...tools.map((tool) => {
      const row = document.createElement("div");
      row.className = "row";
      const name = document.createElement("b");
      name.textContent = `${tool.network ? "🌐" : "🔧"} ${tool.name}`;
      const description = document.createElement("span");
      description.textContent = tool.description || "";
      row.append(name, description);
      return row;
    }));
    return tools;
  }

  async #boot() {
    try {
      const assets = await assetsNextToBundle();
      // A host can provide its shared engine while asset discovery is pending. Do not overwrite it
      // with a second engine: duplicate model loads waste GPU memory and can fail on the same tab.
      if (this.#ai) return;
      this.#ai = createLocalSLM({ assets, ctx: Number(this.getAttribute("ctx") ?? 32768) });
      await this.#status();
    } catch (err) { this.#state(err.message, "err"); }
  }

  #state(text, tone) {
    const el = this.$("[part=state]");
    if (el) { el.textContent = text; el.dataset.tone = tone ?? ""; }
    // Hosts that hide this element's own bar (the panel does) still need progress; the panel
    // mirrors it into its always-visible status line.
    this.dispatchEvent(new CustomEvent("pslm-state", { bubbles: true, detail: { text, tone: tone ?? "" } }));
  }

  async #status() {
    if (!this.#ai) return;
    const st = await this.#ai.status(this.model);
    const label = MODELS[this.model]?.label ?? this.model;
    this.$("[part=model]").textContent = st.state === "installed"
      ? `${label} · ${st.engine || "not loaded"}${st.crossOriginIsolated ? "" : " · single-thread"}`
      : `${label} · not installed on this device`;
    this.$("[part=install]").hidden = st.state === "installed";
    this.$("[part=unload]").hidden = !st.loaded;
    this.$("[part=remove]").hidden = st.state === "missing";
    this.#state(st.state === "installed" ? "ready" : "model needed", st.state === "installed" ? "ok" : "warn");
    return st;
  }

  async #install() {
    this.#state("installing…");
    try {
      await this.#ai.download(this.model, {
        sourceForFile: (file) => [file.url],
        onProgress: (p) => this.#state(`${p.phase} ${Math.round((p.done / (p.total || 1)) * 100)}% · ${p.file || "model"}`),
      });
      this.#state("loading model…");
      await this.#ai.load(this.model);
      await this.#status();
    } catch (err) {
      await this.#status().catch(() => {});
      this.#state(err.message, "err");
    }
  }

  async #unload() {
    try {
      this.#state("unloading model from memory…");
      await this.#ai.unload();
      await this.#status();
    } catch (err) { this.#state(err.message, "err"); }
  }

  async #remove() {
    if (!window.confirm(`Delete cached files for ${MODELS[this.model]?.label ?? this.model}? This browser must download them again before reuse.`)) return;
    try {
      this.#state("deleting cached files…");
      await this.#ai.remove(this.model);
      await this.#status();
    } catch (err) { this.#state(err.message, "err"); }
  }

  async #import(file) {
    if (!file) return;
    this.#state("importing…");
    try {
      this.model = await this.#ai.importModel(file, { onProgress: (p) => this.#state(`${p.phase} ${Math.round((p.done / (p.total || 1)) * 100)}%`) });
      await this.#status();
    } catch (err) { this.#state(err.message, "err"); }
  }

  #bubble(role, text) {
    const div = document.createElement("div");
    div.setAttribute("part", "bubble");
    div.dataset.role = role;
    div.textContent = text;
    this.$("[part=log]").append(div);
    this.#logTo(role === "user"); // a message the user just sent always brings the view with it
    return div;
  }

  #setSent(text) {
    this.#sentText = text ?? "";
    this.#updateDisclosure();
  }

  #updateDisclosure() {
    const details = this.$("[part=sent]");
    if (!details) return;
    details.hidden = !(this.#contextProvider || this.#sentText);
    details.querySelector("pre").textContent = this.#sentText
      || "Nothing sent yet — the host context is fetched when you ask.";
  }

  // Inline, explicit, one call at a time — a confirm() dialog inside a host page is easy to
  // click through without reading, and the exact arguments must be visible before approval.
  #askApproval(call) {
    if (this.approveTool) return this.approveTool(call);
    return new Promise((resolve) => {
      const panel = this.$("[part=approve]");
      this.$("[part=approve-title]").textContent = `Allow one request? ${call.name}`;
      this.$("[part=approve-args]").textContent = JSON.stringify(call.args, null, 2);
      panel.hidden = false;
      const done = (answer) => {
        panel.hidden = true;
        this.$("[part=approve-yes]").removeEventListener("click", yes);
        this.$("[part=approve-no]").removeEventListener("click", no);
        resolve(answer);
      };
      const yes = () => done(true);
      const no = () => done(false);
      this.$("[part=approve-yes]").addEventListener("click", yes);
      this.$("[part=approve-no]").addEventListener("click", no);
    });
  }

  #keepalive = null;

  #startProgress(label) {
    this.#state(label);
    const started = Date.now();
    this.#stopProgress();
    // Prefill on a long context can take many seconds with no token output; an elapsed counter is
    // the honest "working, not frozen" signal.
    this.#keepalive = setInterval(() => {
      this.#state(`${label} ${(Math.round((Date.now() - started) / 100) / 10).toFixed(1)}s`);
    }, 500);
  }

  #stopProgress() {
    if (this.#keepalive) { clearInterval(this.#keepalive); this.#keepalive = null; }
  }

  async send(question = this.$("[part=input]").value.trim()) {
    if (!question || !this.#ai) return;
    this.$("[part=input]").value = "";
    this.#bubble("user", question);
    this.#state("reading host context…");

    let hostContext = "";
    try {
      // The question is passed so a host can *retrieve* rather than dump a whole corpus: top-k
      // chunks for this question fit a byte cap that a manual could never fit. A provider that
      // ignores the argument behaves exactly as before, so existing hosts are unaffected.
      hostContext = (await this.#contextProvider?.(question)) ?? "";
    } catch (err) { return this.#state(err.message, "err"); }
    // Portable SLM's own description is always in the prompt, ahead of anything the host appends, so
    // "what are you?" and "did you read my screen?" are answered from a declared source instead of
    // guessed. A host can add context; it cannot replace or delete this one.
    const composed = composeContext(hostContext);

    const tools = resolveTools(this.getAttribute("tools") ?? "offline", {
      tools: this.tools ?? defaultTools(),
      allowNetwork: this.hasAttribute("allow-network"),
    });
    // Capability/identity/greeting turns bypass the tool loop entirely (routesDirect).
    const direct = routesDirect(question);
    const activeTools = direct ? [] : tools;
    const lfm = MODELS[this.model]?.runtime === "transformers";
    const system = [
      this.system,
      toolInstructions(activeTools, { lfm }),
      ...(direct ? [DIRECT_REPLY_NOTE] : []),
    ].filter(Boolean).join("\n\n");
    const messages = buildMessages({
      system,
      context: composed.text,
      history: this.#history,
      question,
      maxHistory: this.maxHistory,
    });
    // The disclosure shows everything the model receives, not just the context: the system
    // instructions are the part users are never shown elsewhere, so they are disclosed here.
    this.#setSent(`[Instructions to the model]
${system || "(none)"}

[Context]
${composed.text}`);
    const answer = this.#bubble("assistant", "");
    const prov = document.createElement("div");
    prov.setAttribute("part", "prov");
    answer.append(prov);
    // In-chat progress bubble: what is happening and for how long, right where the answer lands.
    const thinking = document.createElement("div");
    thinking.setAttribute("part", "thinking");
    const thinkingLabel = document.createElement("span");
    thinkingLabel.className = "label";
    const thinkingDots = document.createElement("span");
    thinkingDots.className = "dots";
    thinking.append(thinkingLabel, thinkingDots);
    // Collapsible reasoning trace (adopted from Liquid's 2.6B agent Space): reasoning streams into
    // a details block instead of being hidden entirely — transparent, collapsed by default.
    const thinkDetails = document.createElement("details");
    thinkDetails.setAttribute("part", "think-details");
    const thinkSummary = document.createElement("summary");
    thinkSummary.textContent = "Reasoning";
    const thinkText = document.createElement("pre");
    thinkDetails.append(thinkSummary, thinkText);
    thinking.append(thinkDetails);
    let reasoningChars = 0;
    // A new agent round starts a new think block; without a break the trace reads as one run-on
    // paragraph across tool calls.
    let reasoningBreak = false;
    const onReasonToken = (delta) => {
      if (reasoningBreak) { if (thinkText.textContent) thinkText.textContent += "\n\n"; reasoningBreak = false; }
      reasoningChars += delta.length;
      if (reasoningChars <= 4000) thinkText.textContent += delta;
      else if (reasoningChars - delta.length < 4000) thinkText.textContent += "\n… (truncated view)";
      if (thinkDetails.open) this.#logTo();
    };
    const onMetrics = (tokens) => {
      const secs = (Date.now() - thinkStart) / 1000;
      if (secs > 0.5) thinkTick(`${thinkStage} · ${tokens} tok · ${(tokens / secs).toFixed(1)} tok/s`);
    };
    this.$("[part=log]").insertBefore(thinking, answer);
    this.#logTo();
    const thinkStart = Date.now();
    const thinkTick = (label) => {
      thinkingLabel.textContent = `${label} ${(Math.round((Date.now() - thinkStart) / 100) / 10).toFixed(1)}s`;
      this.#logTo();
    };
    thinkTick("working");
    let thinkStage = "working";
    const onState = (event) => {
      const text = String(event.detail?.text || "");
      const m = /^(thinking|generating|loading model|reading host context)/.exec(text);
      if (m && thinkStage !== "done") { thinkStage = m[1]; thinkTick(m[1]); }
    };
    this.addEventListener("pslm-state", onState);
    const thinkTimer = setInterval(() => thinkTick(thinkStage), 500);
    let thinkEnded = false;
    const endThinking = (finalText) => {
      if (thinkEnded) return;
      thinkEnded = true;
      clearInterval(thinkTimer);
      this.removeEventListener("pslm-state", onState);
      if (finalText) { thinkingLabel.textContent = finalText; thinkingDots.remove(); }
      thinkDetails.open = false; // the trace stays as a collapsed part of the transcript
      this.#logTo(); // collapsing the trace changes the height above the answer
    };

    const onToken = (token) => { answer.insertBefore(document.createTextNode(token), prov); this.#logTo(); };
    // Live tool trail: one chip per tool call, from request through approval to result.
    const toolChips = new Map();
    const toolLog = document.createElement("div");
    toolLog.setAttribute("part", "tools");
    this.$("[part=log]").insertBefore(toolLog, answer);
    const chip = (name, state, text) => {
      let el = toolChips.get(name);
      if (!el) { el = document.createElement("span"); el.className = "chip"; toolChips.set(name, el); toolLog.append(el); }
      el.dataset.state = state;
      el.textContent = text;
      this.#logTo();
      return el;
    };
    this.#abort = new AbortController();
    this.$("[part=stop]").hidden = false;
    this.$("[part=send]").disabled = true;
    const usedTools = [];
    // One shared generation budget: a single decode has one max_new_tokens, so the reasoning block
    // and the answer draw from the same pool — the lever for "it thinks too long" is the prompt,
    // not a separate cap. Tool turns need room for a call plus a long table; plain turns less.
    // Hosts override per element with max-tokens.
    const maxTokensBudget = Number(this.getAttribute("max-tokens")
      ?? (activeTools.length && lfm ? BUDGETS.toolTurn : BUDGETS.plainTurn));
    const options = {
      signal: this.#abort.signal,
      onToken,
      onReasonToken,
      onMetrics,
      onTool: (event) => {
        // Every stage, as data, before the panel decides how to show it: a host that logs can then
        // explain a turn that stopped early (a refused call, a trimmed result, a digest) instead of
        // inferring it from the answer text.
        this.dispatchEvent(new CustomEvent("pslm-tool", { bubbles: true, detail: event }));
        if (event.stage === "call") {
          reasoningBreak = true;
          usedTools.push(event.name);
          if (!event.network) chip(event.name, "running", `🔧 ${event.name} — running…`);
        } else if (event.stage === "result") {
          chip(event.name, "done", `🔧 ${event.name} — done`);
        } else if (event.stage === "capped") {
          // Surplus calls are dropped, not fatal: say so instead of leaving the turn looking clean. The
          // model is told in its own transcript that they were not run, so it can re-ask next round.
          chip("#capped", "capped", `🔧 ${event.dropped} extra tool call${event.dropped === 1 ? "" : "s"} skipped — 4 per round is the limit; the turn continued`);
        } else if (event.stage === "refused") {
          // The turn was mid-plan when its budget ran out; the model is being asked to answer with what
          // it has. Visible, because the alternative is a reply that simply stops mid-thought.
          chip(event.name, "capped", `🔧 ${event.name} — not run, the turn had used its tool budget`);
        }
      },
      approveTool: async (call) => {
        chip(call.name, "pending", `🔧 ${call.name} — awaiting your approval`);
        const allowed = await this.#askApproval(call);
        chip(call.name, allowed ? "running" : "denied",
          allowed ? `🔧 ${call.name} — running…` : `🔧 ${call.name} — denied`);
        return allowed;
      },
      maxTokens: maxTokensBudget,      ...(activeTools.length && lfm ? { sampling: { temperature: 0, penalty_repeat: 1 } } : {}),
      tools: activeTools,
      allowNetwork: this.hasAttribute("allow-network"),
    };

    try {
      let st = await this.#status();
      if (!st.loaded) {
        this.#startProgress("loading model…");
        await this.#ai.load(this.model);
        st = await this.#status();
      }
      this.#state(activeTools.length ? "thinking…" : "generating…");
      const started = performance.now();
      const result = activeTools.length
        ? await this.#ai.runAgent(messages, options)
        : await this.#ai.generate(messages, options);
      if (!result.text?.trim() && !answer.textContent.trim()) this.#state("the model returned no text", "warn");
      // Streamed as plain text, because markup is not parseable until its pair closes mid-token;
      // formatted once, here, over the complete answer. #history and the disclosure keep the raw text.
      if (result.text?.trim()) { endThinking(`responded in ${((Date.now() - thinkStart) / 1000).toFixed(1)}s`); answer.replaceChildren(renderMarkdown(result.text), prov); }
      else {
        // The parse is authoritative. Anything still in the bubble was streamed before the parser
        // knew it was reasoning; drop it rather than leave analysis sitting under an answer label.
        answer.replaceChildren(prov);
        endThinking("no answer returned");
      }
      this.#logTo(); // the final markdown render changes the height; stay pinned if we were
      this.#history.push({ role: "user", content: question }, { role: "assistant", content: result.text });
      // Tool output is not part of the supplied context, so lexical grounding would mislabel it.
      const grounding = usedTools.length ? null : lexicalGrounding(result.text, composed.text);
      // runAgent() reports rounds, not engine/ms; generate() reports both. Take the engine from
      // the status we just read and time the call here so both paths report the same shape.
      const engine = result.engine ?? st?.engine ?? "unknown";
      const ms = result.ms ?? Math.round(performance.now() - started);
      // A tool turn reports per-round usage from the agent loop (src/agent.js), a plain turn reports a
      // single round from the engine. Both are normalised here so the panel can show what a turn
      // actually consumed instead of only how long it took.
      const usage = result.usage ?? {};
      const generated = usage.generatedTokens ?? usage.completion_tokens ?? 0;
      // The real pressure on the window is the largest prompt any round had to carry, not the sum:
      // every round re-sends the whole history, and the KV cache saves compute, never space.
      const peakPrompt = usage.peakPromptTokens ?? usage.prompt_tokens ?? 0;
      const windowSize = MODELS[this.model]?.ctx ?? null;
      const windowPct = windowSize && peakPrompt ? Math.round((peakPrompt / windowSize) * 100) : null;
      // A plain turn reports the trim on the result; a tool turn accumulates it in usage.
      const trimmed = result.trimmed ?? usage.trimmed ?? 0;
      const tps = generated && ms > 0 ? `${generated} tok · ${(generated / (ms / 1000)).toFixed(1)} tok/s` : null;
      // A cap cut is a per-round event now: any round that spent its whole generation budget.
      const hitCap = usage.rounds
        ? usage.rounds.some((r) => r.generatedTokens && r.generatedTokens >= maxTokensBudget)
        : Boolean(generated && generated >= maxTokensBudget);
      if (tps) endThinking(`responded in ${(ms / 1000).toFixed(1)}s · ${tps}${hitCap ? " · hit token cap" : ""}`);
      // Did the model finish? The cap is only one of the ways a reply stops short — a plan-shaped or
      // truncated one reads as an answer unless code says otherwise, which is what this decides. A tool
      // turn reports the verdict the agent loop already reached; a plain turn is judged here.
      const completeness = result.completeness ?? assessCompleteness(result.text);
      if (hitCap) {
        // A cap cut is a broken answer (mid-sentence, mid-table); say so instead of a silent stop.
        const capNote = document.createElement("div");
        capNote.setAttribute("part", "cap-note");
        capNote.textContent = `⚠ The reply stopped at the ${maxTokensBudget}-token cap. Say “continue” to get the rest.`;
        answer.append(capNote);
      }
      if (!completeness.ok) {
        // The reader must never be handed a fragment as an answer without being told. This is the rule
        // that makes "the turn finished" checkable at all.
        const note = document.createElement("div");
        note.setAttribute("part", "cap-note");
        note.textContent = describeIncomplete(completeness);
        answer.append(note);
      }
      // Provenance collapses to a hover badge: auditable on demand, not noise on every answer.
      // Inline expansion — the scrolling transcript clips floating popups at most panel sizes.
      const provPop = document.createElement("span");
      provPop.setAttribute("part", "prov-pop");
      provPop.setAttribute("role", "tooltip");
      for (const line of [`${MODELS[this.model]?.label ?? this.model} · ${engine}`,
        tps ?? `${ms} ms`,
        result.toolRounds ? `${result.toolRounds} tool round(s)` : null,
        usedTools.length ? `tools: ${usedTools.join(", ")}` : null,
        // Consumption, in the two numbers that explain a stalled or expensive turn: how full the
        // window got (what the whole history costs) and what the model actually produced.
        peakPrompt && windowSize ? `window: ${peakPrompt} of ${windowSize} tok${windowPct !== null ? ` · ${windowPct}%` : ""} (peak prompt)` : null,
        peakPrompt && !windowSize ? `peak prompt: ${peakPrompt} tok` : null,
        usage.generatedTokens ? `generated: ${usage.generatedTokens} tok` : null,
        usage.promptTokens && usage.rounds?.length > 1 ? `re-sent per round: ${usage.promptTokens} tok total` : null,
        trimmed ? `history trimmed: ${trimmed} oldest exchange(s) dropped` : null,        usedTools.length ? "grounding not checked (tool output)"
          : direct ? "direct answer — no tool use for capability/greeting questions"
          : composed.sources.length === 1
            ? "no host context — answered from Portable SLM's own description only"
            : `grounding: ${formatGrounding(grounding)}`].filter(Boolean)) {
        const row = document.createElement("div");
        row.textContent = line;
        provPop.append(row);
      }
      prov.replaceChildren(document.createTextNode("ⓘ response details"), provPop);
      prov.tabIndex = 0;
      this.#stopProgress();
      this.#state("ready", "ok");
      const detail = { question, text: result.text, context: composed.text, sources: composed.sources,
        engine, ms, grounding, tools: usedTools, completeness,
        // What the turn consumed, so a host can log or display it without parsing the provenance popup:
        // the peak prompt is the window pressure, the generated count is model output.
        usage: { peakPromptTokens: peakPrompt, generatedTokens: generated, windowSize, trimmed,
          rounds: usage.rounds ?? null, toolRounds: result.toolRounds ?? 0 } };
      this.dispatchEvent(new CustomEvent("pslm-answer", { bubbles: true, detail }));
      this.onAnswer?.(detail);
    } catch (err) {
      endThinking("failed");
      this.#stopProgress();
      for (const [name, el] of toolChips) {
        if (el.dataset.state === "running" || el.dataset.state === "pending") {
          el.dataset.state = "error";
          el.textContent = `🔧 ${name} — failed`;
        }
      }
      this.#state(err.message, "err");
      this.dispatchEvent(new CustomEvent("pslm-error", { bubbles: true, detail: { message: err.message } }));
    } finally {
      endThinking();
      this.#stopProgress();
      this.#abort = null;
      this.$("[part=stop]").hidden = true;
      this.$("[part=send]").disabled = false;
    }
  }
}

if (!customElements.get("pslm-chat")) customElements.define("pslm-chat", PslmChat);
