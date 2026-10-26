/**
 * What the main thread and the highlight worker say to each other. The one
 * place both ends read, so neither can drift from the other's shape; the
 * guards are how each end proves what arrived, since a message crosses as
 * `unknown`.
 */
import { isJsonRecord } from "@keepdeck/plugin-api";
import type { LineTokens, Token } from "./tokens";

/** Main thread → worker. `id` pairs a tokenize with its reply; a warm-up
 * expects none. */
export type HighlightRequest =
  | { kind: "tokenize"; id: number; text: string; lang: string }
  | { kind: "warm"; lang: string | null };

/** Worker → main thread: one reply per tokenize. `lines` is null for a
 * language the kit didn't load; `error` is an engine failure, as text. */
export type HighlightReply =
  | { id: number; lines: LineTokens[] | null }
  | { id: number; error: string };

export function isHighlightRequest(value: unknown): value is HighlightRequest {
  if (!isJsonRecord(value)) return false;
  if (value.kind === "warm") return value.lang === null || typeof value.lang === "string";
  return (
    value.kind === "tokenize" &&
    typeof value.id === "number" &&
    typeof value.text === "string" &&
    typeof value.lang === "string"
  );
}

function isToken(value: unknown): value is Token {
  return (
    isJsonRecord(value) &&
    typeof value.text === "string" &&
    (value.color === undefined || typeof value.color === "string") &&
    (value.italic === undefined || typeof value.italic === "boolean")
  );
}

function isLines(value: unknown): value is LineTokens[] {
  return Array.isArray(value) && value.every((line) => Array.isArray(line) && line.every(isToken));
}

export function isHighlightReply(value: unknown): value is HighlightReply {
  if (!isJsonRecord(value) || typeof value.id !== "number") return false;
  if ("error" in value) return typeof value.error === "string";
  return value.lines === null || isLines(value.lines);
}
