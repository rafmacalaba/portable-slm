export interface NadaStudySnapshot {
  idno: string;
  title: string;
  abstract: string;
}
export interface EditorFieldSnapshot {
  id: string;
  path: string;
  value: unknown;
}
export function normalizeNadaStudy(data: unknown, id: string): NadaStudySnapshot;
export function loadPublicNadaDemoStudy(
  id?: string,
  options?: { fetch?: typeof fetch },
): Promise<NadaStudySnapshot>;
export function loadMetadataContext(options: {
  source: "nada";
  id: string;
  apiBase?: string;
  fetch?: typeof fetch;
}): Promise<NadaStudySnapshot>;
export function loadMetadataContext(options: {
  source: "metadata-editor";
  id: string;
  path?: string;
  apiBase?: string;
  fetch?: typeof fetch;
}): Promise<EditorFieldSnapshot>;
