import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getDb } from "./index.js";

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Skemaet er idempotent (CREATE TABLE IF NOT EXISTS), så det køres ved hver
 * opstart. Statements køres enkeltvis, fordi PGlite ikke håndterer
 * multi-statement strenge ens med pg-driveren.
 */
export async function migrate(): Promise<void> {
  const schemaPath = path.resolve(here, "../../db/schema.sql");
  const sql = fs.readFileSync(schemaPath, "utf8");
  const db = await getDb();
  for (const stmt of splitStatements(sql)) {
    await db.query(stmt);
  }
}

function splitStatements(sql: string): string[] {
  const withoutComments = sql
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");
  return withoutComments
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
