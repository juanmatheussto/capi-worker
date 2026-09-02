import { Worker, type Job } from "bullmq";
import { connection, CAPI_QUEUE } from "./queue.js";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { ensureSchema } from "./db.js";
import {
  getEvent,
  getTenant,
  markSent,
  markFailed,
  markSkipped,
  bumpAttempts,
  getLead,
  markLeadSent,
  markLeadFailed,
  bumpLeadAttempts,
} from "./repo.js";
import { buildCapiEvent, buildLeadEvent, sendToGraph } from "./core/capi.js";
import { findCtwaClid } from "./core/attribution.js";
import type { CapiJob, NormalizedEvent } from "./types.js";

await ensureSchema();

const MAX_AGE_MS = config.eventMaxAgeDays * 24 * 3600 * 1000;

async function processJoin(job: Job<CapiJob>) {
  const { eventDbId } = job.data as Extract<CapiJob, { kind: "join" }>;
  const row = await getEvent(eventDbId);
  if (!row) return { skipped: "row inexistente" };
  if (row.status !== "pending") return { skipped: `status=${row.status}` };

  const tenant = await getTenant(row.tenant_id);
  if (!tenant) {
    await markSkipped(row.id, "tenant inativo/inexistente");
    return { skipped: "tenant" };
  }

  const eventTime = new Date(row.event_time);
  if (Date.now() - eventTime.getTime() > MAX_AGE_MS) {
    await markSkipped(row.id, "evento passou da janela de 7 dias antes de enviar");
    return { skipped: "janela-7d" };
  }

  const ev: NormalizedEvent = {
    action: row.action,
    phoneE164: row.phone_e164 ?? undefined,
    displayName: row.display_name ?? undefined,
    groupJid: row.group_jid ?? undefined,
    groupName: row.group_name ?? undefined,
    addedBy: row.added_by ?? undefined,
    campaignLabel: row.campaign_label ?? undefined,
    eventTime,
  };

  const ctwaClid = await findCtwaClid(tenant.id, ev.phoneE164);
  const capiEvent = buildCapiEvent(tenant, ev, row.event_id, { ctwaClid });
  const result = await sendToGraph(tenant, [capiEvent]);

  if (result.ok) {
    await markSent(row.id, result.body, Boolean(ctwaClid));
    return { sent: true, matchedCtwa: Boolean(ctwaClid) };
  }

  const attemptsLeft = job.attemptsMade + 1 < (job.opts.attempts ?? 1);
  if (result.retryable && attemptsLeft) {
    await bumpAttempts(row.id);
    throw new Error(`graph ${result.status}: ${JSON.stringify(result.body).slice(0, 300)}`);
  }

  await markFailed(row.id, `graph ${result.status}`, result.body);
  return { failed: true, status: result.status };
}

async function processLead(job: Job<CapiJob>) {
  const { leadDbId } = job.data as Extract<CapiJob, { kind: "lead" }>;
  const row = await getLead(leadDbId);
  if (!row) return { skipped: "lead inexistente" };
  if (row.status !== "pending") return { skipped: `status=${row.status}` };

  const tenant = await getTenant(row.tenant_id);
  if (!tenant) {
    await markLeadFailed(row.id, "tenant inativo/inexistente");
    return { skipped: "tenant" };
  }

  const eventTime = new Date(row.event_time);
  if (Date.now() - eventTime.getTime() > MAX_AGE_MS) {
    await markLeadFailed(row.id, "lead passou da janela de 7 dias");
    return { skipped: "janela-7d" };
  }

  const evt = buildLeadEvent(
    tenant,
    {
      eventId: row.event_id,
      fbp: row.fbp ?? undefined,
      fbc: row.fbc ?? undefined,
      externalId: row.external_id ?? undefined,
      eventSourceUrl: row.event_source_url ?? undefined,
      eventTime,
    },
    { ip: row.client_ip ?? undefined, ua: row.client_ua ?? undefined },
  );
  const result = await sendToGraph(tenant, [evt]);

  if (result.ok) {
    await markLeadSent(row.id, result.body);
    return { sent: true, kind: "lead" };
  }

  const attemptsLeft = job.attemptsMade + 1 < (job.opts.attempts ?? 1);
  if (result.retryable && attemptsLeft) {
    await bumpLeadAttempts(row.id);
    throw new Error(`graph ${result.status}: ${JSON.stringify(result.body).slice(0, 300)}`);
  }

  await markLeadFailed(row.id, `graph ${result.status}`, result.body);
  return { failed: true, status: result.status };
}

const worker = new Worker<CapiJob>(
  CAPI_QUEUE,
  async (job) => (job.data.kind === "lead" ? processLead(job) : processJoin(job)),
  { connection, concurrency: config.workerConcurrency },
);

worker.on("completed", (job, res) => logger.info({ job: job.id, res }, "job ok"));
worker.on("failed", (job, err) => logger.warn({ job: job?.id, err: err.message }, "job falhou (vai retryar)"));

logger.info(`worker CAPI up (concorrencia ${config.workerConcurrency})`);
