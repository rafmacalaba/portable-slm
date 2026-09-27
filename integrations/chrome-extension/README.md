# Chrome desktop side panel (MVP)

An **Ask-Gemini-like interaction**, but model inference runs on your computer. User opens the
extension panel, chooses selected text or explicitly reads up to 4,000 characters of the current
page, then asks the local model. Offline date and calculator tools work; online Wikipedia search
requires enabling it **and approving the exact query** in a confirmation dialog.

## Build and install

```sh
npm install
npm run build:extension
```

Open `chrome://extensions` on **desktop Chrome**, enable Developer mode and click **Load unpacked**;
choose this repo's `dist-extension/` directory. Click **Portable SLM** toolbar icon to open its side
panel. **If managed Chrome blocks unpacked extensions, stop and ask your administrator for an
approved install or allowlist. Do not switch browser builds to evade that policy.** Chrome for
Testing is used only for isolated developer tests where permitted. Standard mobile Chrome does
not support the same extension APIs—use web chat there.

1. Import a pinned GGUF from Files or download a model. Model and extension runtime assets are
   stored locally (model cache under the extension origin).
2. Click **Load locally**. The model is held in the side panel while it is open. Closing the panel
   unloads runtime memory; reopen and load from cached bytes without reimporting.
3. On any normal webpage (including NADA or Metadata Editor), click the extension toolbar icon to
   grant temporary `activeTab` access. Click **Use selected text** or **Use page text**. Inspect the
   context preview, then ask. On navigation to another origin, grant access again.
4. Turn off network, reopen panel, click Load and ask with offline tools. The page being inspected
   must itself be available; this extension cannot make server-backed pages work offline.

Test local inference + offline tool after restarting browser:

```sh
npm run e2e               # prepares .cache/models/LFM2.5-350M-Q4_K_M.gguf
CHROME_PATH=/path/to/chrome-for-testing npm run e2e:extension
```

## Implementation

`panel.js` uses the same `src/index.js` SDK as web chat. MV3 `background.js` opens the side panel
only—never keep a model in an extension service worker (Chrome suspends idle workers).
`activeTab` + `scripting` read only the page after a user gesture. JavaScript and both WASM builds
are bundled with the extension; MV3 CSP disallows remote code. Model files are data, can be imported
from disk, and are SHA-256 verified. `manifest.json` grants Hugging Face/CDN and Wikipedia host
permissions for optional online operations. It does **not** grant blanket page access.

This is an MVP: generic DOM selection/page text, not a privileged API integration with NADA or
Metadata Editor. It never edits those applications, and should not be used to feed private page
content to an online tool without inspecting the confirmation prompt.

Google's [Build extensions with coding agents](https://developer.chrome.com/docs/extensions/ai/build-with-ai)
guide describes Modern Web Guidance and Chrome DevTools for debugging extension actions and
side panels. Those tools can aid approved development/testing; they **do not bypass enterprise
installation policy** or provide a deployment mechanism for this extension.
