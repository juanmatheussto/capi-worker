import { readFile } from "node:fs/promises";
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
  const sqlPath = join(here, "../sql/001_init.sql");
  const sql = await readFile(sqlPath, "utf8");
  await pool.query(sql);
  logger.info("schema ensured");
}
