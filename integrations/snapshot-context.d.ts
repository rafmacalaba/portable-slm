/** The bounded summary fields picked out of a catalogue response. */
export interface StudySummary {
  idno: string;
  title: string;
  abstract: string;
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
 * Read one JSON snapshot from the host's own origin, for hosts that predate the manifest.
 *
 * The caller declares the route (`endpoint`, `params`, `unwrap`). This module owns the guards, because
 * those are the parts a host gets wrong: a bounded id, a bounded JSON Pointer, same-origin only, and an
 * error that names the cause instead of surfacing a JSON parse failure. `source` is a label for what was
 * read and never selects a route; a table of known routes is a table of known applications.
 */
export function loadContextSnapshot<T = unknown>(options: ContextRoute & {
  id: string;
  source?: string;
  pointer?: string;
  /** Deprecated alias for `pointer`. */
  path?: string;
  apiBase?: string;
  credentials?: RequestCredentials;
  fetch?: typeof fetch;
}): Promise<T>;

/** Pick the bounded summary out of a catalogue response, dropping every other field. */
export function pickStudySummary(data: unknown, id: string): StudySummary;
