import { config } from "./config.js";
import { buildEventId, sha1short } from "./core/normalize.js";
import { insertPendingEvent, insertPendingLead } from "./repo.js";
import { capiQueue } from "./queue.js";
import { logger } from "./logger.js";
import type { LeadInput, NormalizedEvent, Tenant } from "./types.js";

export interface IngestSummary {
  accepted: number;
  duplicates: number;
  discarded: number;
  reasons: Record<string, number>;
}

/**
 * Recebe joins normalizados, deduplica no banco e enfileira os novos.
 * So processa action === "entrada" (o pedido e sinal de quem ENTROU).
 */
export async function ingestEvents(
  tenant: Tenant,
  events: NormalizedEvent[],
): Promise<IngestSummary> {
  const summary: IngestSummary = { accepted: 0, duplicates: 0, discarded: 0, reasons: {} };
  const bump = (r: string) => (summary.reasons[r] = (summary.reasons[r] ?? 0) + 1);

  const maxAgeMs = config.eventMaxAgeDays * 24 * 3600 * 1000;
  const now = Date.now();
  const eventName = tenant.event_name || config.defaultEventName;

  for (const ev of events) {
    if (ev.action !== "entrada") {
      summary.discarded++;
      bump("nao-entrada");
      continue;
    }
    if (!ev.phoneE164 && !ev.displayName) {
      summary.discarded++;
      bump("sem-identificador");
      continue;
    }
    if (now - ev.eventTime.getTime() > maxAgeMs) {
      summary.discarded++;
      bump("fora-janela-7d");
      continue;
    }

    const eventId = buildEventId(tenant.id, ev);
    const { id, isNew } = await insertPendingEvent({ tenantId: tenant.id, eventId, eventName, ev });
    if (!isNew) {
      summary.duplicates++;
      continue;
    }
    await capiQueue.add("join", { kind: "join", eventDbId: id }, { jobId: `${tenant.id}:j:${id}` });
    summary.accepted++;
  }

  logger.info({ tenant: tenant.id, summary }, "ingest joins");
  return summary;
}

/** Recebe um Lead do clique do botao, deduplica por event_id e enfileira. */
export async function ingestLead(
  tenant: Tenant,
  input: LeadInput,
  ctx: { ip?: string; ua?: string },
): Promise<{ accepted: boolean; duplicate: boolean; eventId: string }> {
  const eventId =
    input.eventId ||
    `lead_${sha1short(`${tenant.id}|${input.fbc || input.fbp || input.fbclid || Math.random()}|${Date.now()}`)}`;

  const { id, isNew } = await insertPendingLead({
    tenantId: tenant.id,
    eventId,
    input,
    clientIp: ctx.ip,
    clientUa: ctx.ua,
  });

  if (isNew) {
    await capiQueue.add("lead", { kind: "lead", leadDbId: id }, { jobId: `${tenant.id}:l:${id}` });
  }
  logger.info({ tenant: tenant.id, eventId, isNew }, "ingest lead");
  return { accepted: isNew, duplicate: !isNew, eventId };
}
