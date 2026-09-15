import crypto from "node:crypto";
import { exec, many, one } from "../db/index.js";

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
}

export async function logEvent(input: {
  weddingId?: string | null;
  vendorId?: string | null;
  threadId?: string | null;
  type: string;
  payload?: Record<string, unknown>;
}): Promise<void> {
  await exec(
    `INSERT INTO events (wedding_id, vendor_id, thread_id, type, payload)
     VALUES ($1,$2,$3,$4,$5)`,
    [
      input.weddingId ?? null,
      input.vendorId ?? null,
      input.threadId ?? null,
      input.type,
      JSON.stringify(input.payload ?? {}),
    ],
  );
}

/** Datofelter kommer tilbage som Date fra begge drivere; API'et skal have ISO-dato. */
export function toIsoDate(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v);
  return s.length >= 10 ? s.slice(0, 10) : s;
}

export function toIsoTimestamp(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

export { exec, many, one };
