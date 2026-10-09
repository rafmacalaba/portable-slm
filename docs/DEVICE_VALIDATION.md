# Device validation: offline harness

Use this checklist after deploying the build under test. Validate the **direct app origin**, not
HF's embedded iframe; browser storage is origin/partition-specific. Record exact URL and build so
results can be reproduced. Use public or synthetic data only.

## Before testing

Record device/model, OS version, browser/version, install method (tab or home-screen app), app URL,
model ID, free storage estimate and whether network is enabled. Download the app shell and one model
while online. Wait for **Ready offline**; do not infer readiness from the browser's online icon.
Keep source GGUF available for recovery. Do not record credentials or private data in screenshots.

## Offline/restart checklist

1. Enable airplane mode and disable Wi-Fi/cellular. Confirm no network is available.
2. Close the app/browser completely; reopen the same app origin.
3. Check that app shell and chosen model both report ready. Load the model.
4. Run three short, representative not sensitive tasks. Confirm generated text arrives and no task
   attempts external access. Stop a longer generation once to verify cancel remains responsive.
5. Close/reopen once more and repeat a task. Record completion, reload/crash, error and recovery.
6. If storage was cleared or evicted, confirm UI reports missing model; restore from the local GGUF
   file without internet. Do not clear storage on a device with the only copy of a needed model.

## Device matrix

| Platform | Path to test | Current status |
|---|---|---|
| Laptop | Current Chrome or organization-approved browser; direct HTTPS app origin | Chrome offline E2E passes; managed extension not required |
| iPhone/iPad | Safari tab, then optionally Add to Home Screen; same direct HTTPS origin | User reports 230M/350M stable; repeat offline/restart checklist |
| Android | Chrome tab, then optionally install PWA; same direct HTTPS origin | Not yet tested; run full checklist before claiming support |

## Result record

For each run, capture only not sensitive observations: setup time, model import/download success,
ready-offline result, chosen engine, task completion, approximate response time, storage/quota errors,
crashes/reloads and whether local-file recovery worked. This phase is about reliable setup and
recovery, not comparative model speed or answer-quality claims.
