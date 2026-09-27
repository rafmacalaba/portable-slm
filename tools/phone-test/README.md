---
title: Portable SLM phone test
emoji: 📱
colorFrom: indigo
colorTo: green
sdk: static
pinned: false
license: mit
custom_headers:
  cross-origin-embedder-policy: require-corp
  cross-origin-opener-policy: same-origin
  cross-origin-resource-policy: cross-origin
---

# Portable SLM — phone test

Checks whether a small language model (Liquid AI LFM2.5, GGUF) can run **inside this browser tab**
on your phone, and how fast. Everything runs on the device via [wllama](https://github.com/ngxson/wllama)
(llama.cpp compiled to WebAssembly, WebGPU or CPU). No server does inference.

1. Pick model / engine / context, tap **Run test** (first run downloads the model once).
2. If the tab reloads or crashes, reopen the page: it reports which step was running.
3. Tap **Copy results** and share them.

Models: LFM Open License v1.0 (Liquid AI). wllama: MIT.
