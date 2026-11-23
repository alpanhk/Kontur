import fs from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzleNodePg, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { drizzle as drizzlePglite, type PgliteDatabase } from "drizzle-orm/pglite";
import { Pool } from "pg";
import * as schema from "./schema";

export type AppDatabase = NodePgDatabase<typeof schema>;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS "surveys" (
  "id" serial PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "provider" text NOT NULL,
  "spacing_m" double precision NOT NULL,
  "corridor_m" double precision DEFAULT 0 NOT NULL,
  "zone" integer NOT NULL,
  "south" boolean DEFAULT false NOT NULL,
  "epsg" text NOT NULL,
  "features" jsonb NOT NULL,
  "grid" jsonb,
  "stats" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "elevation_points" (
  "id" serial PRIMARY KEY NOT NULL,
  "survey_id" integer NOT NULL REFERENCES "surveys"("id") ON DELETE CASCADE,
  "seq" integer NOT NULL,
  "kind" text NOT NULL,
  "feature" text NOT NULL,
  "col" integer,
  "row" integer,
  "distance" double precision,
  "lat" double precision NOT NULL,
  "lon" double precision NOT NULL,
  "easting" double precision NOT NULL,
  "northing" double precision NOT NULL,
  "elevation" double precision
);

CREATE INDEX IF NOT EXISTS "elevation_points_survey_seq_idx"
  ON "elevation_points" ("survey_id", "seq");
`;

interface DbHolder {
  promise?: Promise<AppDatabase>;
  pool?: Pool;
  pglite?: PGlite;
}

const globalForDb = globalThis as typeof globalThis & {
  __topoKonturDb?: DbHolder;
};

function isExternalPostgresUrl(url: string): boolean {
  const trimmed = url.trim().toLowerCase();
  return trimmed.startsWith("postgres://") || trimmed.startsWith("postgresql://");
}

async function initDatabase(): Promise<AppDatabase> {
  const holder = (globalForDb.__topoKonturDb ??= {});
  const databaseUrl = process.env.DATABASE_URL?.trim();

  if (databaseUrl && isExternalPostgresUrl(databaseUrl)) {
    const pool = holder.pool ?? new Pool({ connectionString: databaseUrl });
    holder.pool = pool;
    await pool.query(SCHEMA_SQL);
    return drizzleNodePg(pool, { schema });
  }

  const rawDir =
    databaseUrl && !databaseUrl.startsWith("memory://")
      ? databaseUrl.replace(/^pglite:\/\//i, "").replace(/^file:/i, "")
      : process.env.PGLITE_DATA_DIR?.trim() || "./data/pglite";

  const client =
    holder.pglite ??
    (databaseUrl === "memory://"
      ? new PGlite()
      : (() => {
          const resolvedDir = path.resolve(/*turbopackIgnore: true*/ process.cwd(), rawDir);
          fs.mkdirSync(resolvedDir, { recursive: true });
          return new PGlite(resolvedDir);
        })());

  holder.pglite = client;
  await client.waitReady;
  await client.exec(SCHEMA_SQL);
  const pgDb: PgliteDatabase<typeof schema> = drizzlePglite(client, { schema });
  return pgDb as unknown as AppDatabase;
}

/** Mengembalikan instance Drizzle ORM (PostgreSQL eksternal atau PGlite lokal) yang sudah siap skemanya. */
export function getDb(): Promise<AppDatabase> {
  const holder = (globalForDb.__topoKonturDb ??= {});
  if (!holder.promise) {
    holder.promise = initDatabase().catch((err) => {
      holder.promise = undefined;
      throw err;
    });
  }
  return holder.promise;
}
