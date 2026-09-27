import type { LocalSLM } from "./index.js";

export interface NadaStudySnapshot {
  idno: string;
  title: string;
  abstract: string;
}

export type StudyAnswerStatus = "quoted" | "answer-in-source" | "not-stated" | "unverified";
export type StudyAnswerResult =
  | { modelId: string; engine: "cpu" | "webgpu"; answer: string; evidence: string; status: StudyAnswerStatus }
  | { modelId: string; engine: "cpu" | "webgpu"; answer: ""; evidence: ""; status: "invalid"; error: string; raw: string };

export const NADA_SNAPSHOT_KEY: string;
export const answerFormat: { type: "json_schema"; json_schema: { name: string; strict: true; schema: unknown } };
export function validateStudy(study: unknown): NadaStudySnapshot;
export function savePublicStudy(study: NadaStudySnapshot, storage?: Pick<Storage, "setItem">): void;
export function loadPublicStudy(storage?: Pick<Storage, "getItem">): NadaStudySnapshot | null;
export function questionMessages(study: NadaStudySnapshot, question: string): Array<{ role: "system" | "user"; content: string }>;
export function assessAnswer(raw: string, study: NadaStudySnapshot): Omit<Extract<StudyAnswerResult, { status: StudyAnswerStatus }>, "modelId" | "engine">;
export function answerStudyQuestion(
  ai: Pick<LocalSLM, "load" | "generate">,
  study: NadaStudySnapshot,
  question: string,
  options?: { modelId?: string; signal?: AbortSignal },
): Promise<StudyAnswerResult>;
