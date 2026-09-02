import { pool } from "../db.js";
import { config } from "../config.js";

/**
 * Procura um ctwa_clid registrado para esse telefone dentro da janela de atribuicao.
 * Alimentado pelo webhook do Evolution quando chega mensagem com clique de anuncio.
 */
export async function findCtwaClid(
  tenantId: string,
  phoneE164?: string,
): Promise<string | undefined> {
  if (!phoneE164) return undefined;
  const { rows } = await pool.query<{ ctwa_clid: string }>(
    `select ctwa_clid
       from ctwa_leads
      where tenant_id = $1
        and phone_e164 = $2
        and created_at >= now() - ($3 || ' hours')::interval
      order by created_at desc
      limit 1`,
    [tenantId, phoneE164, String(config.ctwaWindowHours)],
  );
  return rows[0]?.ctwa_clid;
}
