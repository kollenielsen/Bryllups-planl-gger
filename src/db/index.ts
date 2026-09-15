import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";

export interface QueryResult<T> {
  rows: T[];
}

export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
  close(): Promise<void>;
  kind: "postgres" | "pglite";
}

let instance: Db | null = null;

/**
 * Én SQL-dialekt, to drivere. DATABASE_URL sat => rigtig Postgres (Supabase).
 * Ellers PGlite (Postgres kompileret til WASM) med fil-persistens, så MVP'en
 * kan køres og testes uden at der skal provisioneres noget.
 */
export async function getDb(): Promise<Db> {
  if (instance) return instance;

  if (config.db.url) {
    const { default: pg } = await import("pg");
    const pool = new pg.Pool({
      connectionString: config.db.url,
      ssl: config.db.url.includes("localhost") ? undefined : { rejectUnauthorized: false },
      max: 5,
    });
    instance = {
      kind: "postgres",
      async query<T>(sql: string, params: unknown[] = []) {
        const res = await pool.query(sql, params as never[]);
        return { rows: res.rows as T[] };
      },
      async close() {
        await pool.end();
      },
    };
    return instance;
  }

  const dir = path.resolve(config.db.pgliteDir);
  fs.mkdirSync(dir, { recursive: true });
  const { PGlite } = await import("@electric-sql/pglite");
  const lite = await PGlite.create(dir);
  instance = {
    kind: "pglite",
    async query<T>(sql: string, params: unknown[] = []) {
      const res = await lite.query<T>(sql, params as never[]);
      return { rows: res.rows };
    },
    async close() {
      await lite.close();
    },
  };
  return instance;
}

/** Til tests: skift til en in-memory database og nulstil singleton'en. */
export async function useInMemoryDb(): Promise<Db> {
  if (instance) await instance.close().catch(() => undefined);
  const { PGlite } = await import("@electric-sql/pglite");
  const lite = new PGlite();
  await lite.waitReady;
  instance = {
    kind: "pglite",
    async query<T>(sql: string, params: unknown[] = []) {
      const res = await lite.query<T>(sql, params as never[]);
      return { rows: res.rows };
    },
    async close() {
      await lite.close();
    },
  };
  return instance;
}

export async function resetDbSingleton(): Promise<void> {
  if (instance) await instance.close().catch(() => undefined);
  instance = null;
}

export async function one<T>(sql: string, params: unknown[] = []): Promise<T | null> {
  const db = await getDb();
  const res = await db.query<T>(sql, params);
  return res.rows[0] ?? null;
}

export async function many<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  const db = await getDb();
  const res = await db.query<T>(sql, params);
  return res.rows;
}

export async function exec(sql: string, params: unknown[] = []): Promise<void> {
  const db = await getDb();
  await db.query(sql, params);
}
