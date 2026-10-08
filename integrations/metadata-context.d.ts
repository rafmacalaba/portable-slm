export interface NadaStudySnapshot {
  idno: string;
  title: string;
  abstract: string;
}
export interface EditorFieldSnapshot {
  id: string;
  path: string | undefined;
  value: unknown;
}
/** Context passed to a caller-supplied `params`/`unwrap` pair. */
export interface ContextRequest {
  id: string;
  pointer?: string;
}
/** The parts a host owns: its route, its query string, its response envelope. */
export interface ContextRoute {
  endpoint: (id: string) => string;
  params?: Record<string, string | number | boolean | null | undefined>
    | ((request: ContextRequest) => Record<string, string | number | boolean | null | undefined>);
  unwrap?: (data: unknown, request: ContextRequest) => unknown;
}
/**
 * The two first-party routes this module was written against, as defaults only. Not an allowlist:
 * any other application passes a `ContextRoute` and behaves identically.
 */
export declare const LEGACY_SOURCES: Record<string, Required<ContextRoute>>;

export function normalizeNadaStudy(data: unknown, id: string): NadaStudySnapshot;
export function loadPublicNadaDemoStudy(
  id?: string,
  options?: { fetch?: typeof fetch },
): Promise<NadaStudySnapshot>;

/** Preferred: the caller declares the route, so any host works and nothing checks its name. */
export function loadMetadataContext<T = unknown>(options: ContextRoute & {
  id: string;
  pointer?: string;
  apiBase?: string;
  credentials?: RequestCredentials;
  fetch?: typeof fetch;
}): Promise<T>;

/** Deprecated shape: picks a `LEGACY_SOURCES` default by name. `path` is an alias for `pointer`. */
export function loadMetadataContext(options: {
  source: string;
  id: string;
  pointer?: string;
  path?: string;
  apiBase?: string;
  credentials?: RequestCredentials;
  fetch?: typeof fetch;
}): Promise<unknown>;
