// Example: read one study from a catalogue's public demo API.
//
// Example material, not SDK surface, and the difference matters: this file names a specific public host,
// which a library must never do. The SDK takes the route from the caller (`loadContextSnapshot`), and this
// is what a caller looks like when the route belongs to someone else.
import { pickStudySummary } from "../../integrations/snapshot-context.js";

const validId = (id) => typeof id === "string" && /^[\w.:-]{1,100}$/.test(id);

/** The public demo this example reads. Any catalogue with a similar route works the same way. */
export const PUBLIC_CATALOGUE = "https://nada-demo.ihsn.org";

/**
 * Fetch one public study and return a bounded snapshot: id, title, abstract. Read-only, no credentials,
 * and the host is a parameter so the example can be pointed at another catalogue.
 */
export async function loadPublicDemoStudy(id = "Test001_OD", { fetch: request = globalThis.fetch, host = PUBLIC_CATALOGUE } = {}) {
  if (!validId(id)) throw new Error("Use a short study id, such as Test001_OD");
  const url = `${host}/index.php/api/catalog/${encodeURIComponent(id)}`;
  const res = await request(url, { credentials: "omit", mode: "cors" });
  if (!res.ok) throw new Error(`Public catalogue demo returned HTTP ${res.status}`);
  return pickStudySummary(await res.json(), id);
}
