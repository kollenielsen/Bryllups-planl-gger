import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "../src/db/migrate.js";
import { useInMemoryDb } from "../src/db/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));

export function fixture(name: string): string {
  return fs.readFileSync(path.resolve(here, "fixtures/emails", name), "utf8");
}

export async function freshDb(): Promise<void> {
  await useInMemoryDb();
  await migrate();
}
