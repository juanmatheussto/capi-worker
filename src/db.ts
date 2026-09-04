import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";
import { config } from "./config.js";
import { logger } from "./logger.js";

const { Pool } = pg;

export const pool = new Pool({ connectionString: config.databaseUrl });

pool.on("error", (err) => logger.error({ err }, "pg pool error"));

const here = dirname(fileURLToPath(import.meta.url));

/** Aplica sql/001_init.sql (idempotente). Chamado no boot da API e do worker. */
export async function ensureSchema(): Promise<void> {
  const dir = join(here, "../sql");
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) {
    await pool.query(await readFile(join(dir, f), "utf8"));
  }
  logger.info({ migrations: files }, "schema ensured");
}
