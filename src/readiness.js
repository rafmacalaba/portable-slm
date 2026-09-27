// Web-host readiness: independent of navigator.onLine, which can report "online" with DNS blocked.
// The service worker knows the exact app files it precached; the model store checks every chunk.
export async function checkOfflineReadiness(ai, modelId, serviceWorker = globalThis.navigator?.serviceWorker) {
  const model = await ai.status(modelId);
  let worker = serviceWorker?.controller ?? null;
  // On first visit, an active worker can cache the shell before it controls this page.
  if (!worker && serviceWorker?.getRegistration) {
    try { worker = (await serviceWorker.getRegistration())?.active ?? null; } catch { /* report unavailable below */ }
  }
  let shell = { ready: false, missing: ["service worker is not active yet"] };
  if (worker) {
    const channel = new MessageChannel();
    shell = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ ready: false, missing: ["service worker did not respond"] }), 5000);
      channel.port1.onmessage = ({ data }) => { clearTimeout(timer); resolve(data); };
      worker.postMessage({ type: "PORTABLE_SLM_READINESS" }, [channel.port2]);
    });
    channel.port1.close();
  }
  return { ready: shell.ready && model.state === "installed", app: shell, model: model.state };
}
