# Laptop pilot: NADA and Metadata Editor

This pilot demonstrates two host examples; it does not define Portable SLM's full scope. The SDK
is reusable by other browser applications with their own context and task adapters. This pilot offers
two paths. **No extension is required** for the public-data trial. Do not bypass an organization's
browser-extension policy with an alternate Chrome build unless IT explicitly approves that test.

## Path A — browser demo, no extension

1. Open the [Portable SLM Space](https://huggingface.co/spaces/rafmacalaba/portable-slm) on laptop.
   Download/import 350M if missing. Wait for HF's embedded app to finish loading.
2. Click **NADA study Q&A** → **Load study from public NADA (online)**. This fetches published
   [Popstan Synthetic Household Survey 2023](https://nada-demo.ihsn.org/index.php/catalog/Test001_OD)
   with no credentials. Inspect the title and abstract. Ask **“What is this survey used for?”**
   and **“What is the study title?”**. The model runs locally and the app checks whether its
   evidence quote appears in the source; unverified answers must be checked by you.
3. Turn off network and reopen the same app origin. The saved public snapshot and cached model
   support questions offline; opening a new NADA webpage still needs NADA's server.
4. For Metadata Editor, obtain a **sanitized, non-sensitive** JSON field/project snapshot through
   your organization's approved export workflow. Choose Metadata Editor, paste only a bounded
   snapshot (for example `{"id":"...","path":"/identification/title","value":"..."}`),
   then request a local suggestion. Do not paste credentials, restricted metadata or personal data
   into an externally hosted page without organizational approval. This does **not** test live
   Editor authentication/API access.

“Suggestion + reason” is a **demo format** we chose. It isn't required by either application and
may contain unsupported claims. Nothing is saved or published automatically.

## Path B — Chrome side panel, only if organization approves

Build `npm run build:extension`, then ask IT to allowlist/install `dist-extension/` in managed
Chrome. Once authorized, import 350M into the extension (its storage is separate from the HF
Space), then click **Load locally**.

- **NADA:** open the [Popstan study](https://nada-demo.ihsn.org/index.php/catalog/Test001_OD),
  select its abstract, invoke the extension icon on that tab, click **Use selected text**, and ask:
  “From this text alone, summarize the survey's purpose, year and geography. Say unknown if not
  stated.” Compare with the source.
- **Metadata Editor:** open the authorized dev URL, sign in yourself, select one non-sensitive
  title/abstract field, invoke the extension icon, use selected text, and ask for clearer wording
  plus facts needing verification. No passwords/API tokens should be shared with this project.

If a live authenticated Editor API integration is desired later, mount
`integrations/metadata-widget.js` **within the Editor origin**. It reads one field through
`GET /index.php/api/editor/json_field/{id}?path=...` using app authentication; no write endpoint.
The extension and web demo alone cannot make NADA/Editor servers work offline.

## Verification and next input

The public NADA API returns `{status,dataset}`, with DDI abstract nested under
`dataset.metadata.study_desc.study_info`. The subsystem normalizes it. A real public-study
browser run produced a bounded local answer; some responses lacked usable evidence and were
flagged unverified. This is a read-only functionality test, not proof of answer quality. Automated Editor tests use fixtures; **no private Editor dev instance
has been exercised**.

For a live Editor pilot, provide its dev URL and one non-sensitive project ID/field path. Log in
locally yourself. The extension route additionally needs IT approval in managed Chrome.
