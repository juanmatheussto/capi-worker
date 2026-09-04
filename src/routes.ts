import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { config } from "./config.js";
import { logger } from "./logger.js";
import {
  getTenant,
  upsertTenant,
  setTenantInstance,
  setTenantMeta,
  getTenantGroups,
  upsertTenantGroup,
  untrackTenantGroup,
  recordCtwaLead,
  saveWaRaw,
  listWaConversations,
  listWaMessages,
  waStats,
  waResponseBuckets,
  waBackfill,
  saveWaMessage,
  updateWaStatus,
  listEvents,
  statusCounts,
  matchReadiness,
  leadStatusCounts,
  logMembership,
  upsertGroupMember,
  importGroupMembers,
  createLink,
  deleteLink,
  getLinkBySlug,
  logLinkClick,
  dashboardData,
} from "./repo.js";
import { ingestEvents, ingestLead } from "./pipeline.js";
import { jidToE164, onlyDigits, toE164 } from "./core/normalize.js";
import {
  evoConfig,
  connectionState,
  connectQr,
  fetchAllGroups,
  fetchParticipants,
  createInstance,
  setWebhook,
  getWebhook,
} from "./core/evolution.js";
import { parseWebhook, verifySignature } from "./core/whatsapp.js";
import type { LeadInput, NormalizedEvent } from "./types.js";

const here = dirname(fileURLToPath(import.meta.url));
const BOT_RE =
  /bot|crawler|spider|facebookexternalhit|whatsapp|telegram|slack|discord|preview|embedly|curl|wget|python-requests|Go-http|HeadlessChrome/i;

function requireAdmin(req: FastifyRequest, reply: FastifyReply): boolean {
  if (req.headers["x-api-key"] !== config.adminApiKey) {
    reply.code(401).send({ error: "unauthorized" });
    return false;
  }
  return true;
}

function withSecret(url: string, secret: string): string {
  if (/[?&]secret=/.test(url)) return url;
  return url + (url.includes("?") ? "&" : "?") + "secret=" + encodeURIComponent(secret);
}

function clientIp(req: FastifyRequest): string {
  const xff = String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim();
  return xff || req.ip;
}

function sameJid(a?: string | null, b?: string | null): boolean {
  const da = onlyDigits(String(a ?? "").split("@")[0].split(":")[0]);
  const db = onlyDigits(String(b ?? "").split("@")[0].split(":")[0]);
  return da.length > 0 && da === db;
}

function setCors(req: FastifyRequest, reply: FastifyReply): void {
  reply.header("access-control-allow-origin", String(req.headers.origin ?? "*"));
  reply.header("access-control-allow-methods", "POST, OPTIONS");
  reply.header("access-control-allow-headers", "content-type");
  reply.header("access-control-max-age", "86400");
}

function mapJoins(body: Record<string, unknown>): NormalizedEvent[] {
  const joins = Array.isArray(body?.joins) ? (body.joins as Record<string, unknown>[]) : [];
  return joins.map((j) => ({
    action: "entrada" as const,
    phoneE164: toE164(j.phone as string),
    displayName: (j.name ?? j.displayName) as string | undefined,
    groupName: (j.group ?? body.group) as string | undefined,
    addedBy: j.added_by as string | undefined,
    campaignLabel: (j.campaign_label ?? body.campaign_label) as string | undefined,
    eventTime: j.joined_date ? new Date(`${String(j.joined_date)}T12:00:00Z`) : new Date(),
  }));
}

function eqConst(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  // Basic Auth opcional no dashboard + rotas admin (público: /r /lead /webhooks /healthz)
  const [bUser, bPass] = config.dashBasicAuth.split(":");
  if (bUser && bPass) {
    const expected = "Basic " + Buffer.from(`${bUser}:${bPass}`).toString("base64");
    app.addHook("onRequest", async (req, reply) => {
      const p = (req.url.split("?")[0] || "/").replace(/\/+$/, "") || "/";
      const guarded =
        p === "/" || p === "/dashboard" || p === "/conversas" ||
        p === "/tenants" || p.startsWith("/tenants/");
      if (!guarded) return;
      if (!eqConst(String(req.headers.authorization ?? ""), expected)) {
        reply.header("www-authenticate", 'Basic realm="capi-worker"').code(401).send("auth necessária");
      }
    });
  }

  app.get("/healthz", async () => ({ ok: true, ts: new Date().toISOString() }));

  // ---- dashboard estatico ----------------------------------------
  const serveDash = async (_req: FastifyRequest, reply: FastifyReply) => {
    const html = await readFile(join(here, "../public/dashboard.html"), "utf8");
    reply.header("content-type", "text/html; charset=utf-8").send(html);
  };
  app.get("/", serveDash);
  app.get("/dashboard", serveDash);

  // painel de analise de conversas (so mensagens)
  app.get("/conversas", async (_req, reply) => {
    const html = await readFile(join(here, "../public/conversas.html"), "utf8");
    reply.header("content-type", "text/html; charset=utf-8").send(html);
  });

  // ---- redirect + contagem de cliques do link da oferta ---------
  app.get("/r/:slug", async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const link = await getLinkBySlug(slug);
    if (!link || !link.active) return reply.code(404).send("link nao encontrado");
    const ua = String(req.headers["user-agent"] ?? "");
    const q = (req.query ?? {}) as Record<string, string>;
    const campaign = String(q.c ?? q.o ?? q.oferta ?? "").trim().slice(0, 80) || null;
    await logLinkClick({
      linkId: link.id,
      campaign,
      ip: clientIp(req),
      ua,
      referer: String(req.headers.referer ?? ""),
      isBot: BOT_RE.test(ua) || req.method === "HEAD",
    });
    return reply.code(302).header("location", link.destination_url).send();
  });

  // ---------------------------------------------------------------- admin
  app.post("/tenants", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const b = (req.body ?? {}) as Record<string, string>;
    if (!b.id || !b.pixelId || !b.capiToken || !b.webhookSecret) {
      return reply.code(400).send({ error: "id, pixelId, capiToken, webhookSecret sao obrigatorios" });
    }
    await upsertTenant({
      id: b.id,
      name: b.name ?? b.id,
      pixelId: b.pixelId,
      capiToken: b.capiToken,
      webhookSecret: b.webhookSecret,
      testEventCode: b.testEventCode ?? null,
      eventName: b.eventName ?? null,
      joinFilter: b.joinFilter ?? null,
      lpOrigin: b.lpOrigin ?? null,
    });
    return { ok: true };
  });

  // configura as credenciais do Meta (Conversions API) do tenant
  app.post("/tenants/:id/meta", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as Record<string, string>;
    if (!b.pixelId || !b.capiToken) {
      return reply.code(400).send({ error: "pixelId e capiToken obrigatorios" });
    }
    if (!(await getTenant(id))) return reply.code(404).send({ error: "tenant nao encontrado" });
    await setTenantMeta({
      id,
      pixelId: b.pixelId,
      capiToken: b.capiToken,
      testEventCode: b.testEventCode ? b.testEventCode : null,
      eventName: b.eventName ?? null,
    });
    return { ok: true };
  });

  // usa uma instancia JA existente no Evolution
  app.post("/tenants/:id/instance", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as Record<string, string>;
    if (!b.baseUrl || !b.apiKey || !b.instance) {
      return reply.code(400).send({ error: "baseUrl, apiKey, instance obrigatorios" });
    }
    if (!(await getTenant(id))) return reply.code(404).send({ error: "tenant nao encontrado" });
    await setTenantInstance({ id, baseUrl: b.baseUrl, apiKey: b.apiKey, instance: b.instance });
    return { ok: true };
  });

  // cria uma instancia NOVA no Evolution (precisa da apikey global) e ja aponta o webhook
  app.post("/tenants/:id/instance/create", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as Record<string, string>;
    if (!b.baseUrl || !b.globalApiKey || !b.instance) {
      return reply.code(400).send({ error: "baseUrl, globalApiKey, instance obrigatorios" });
    }
    const tenant = await getTenant(id);
    if (!tenant) return reply.code(404).send({ error: "tenant nao encontrado" });

    const created = await createInstance(b.baseUrl, b.globalApiKey, b.instance);
    if (!created.ok) {
      return reply.code(502).send({ error: "falha ao criar instancia no Evolution", detail: created.raw });
    }
    await setTenantInstance({ id, baseUrl: b.baseUrl, apiKey: created.instanceToken, instance: b.instance });

    let webhook: unknown = "PUBLIC_BASE_URL nao configurado — configure o webhook manualmente";
    if (config.publicBaseUrl) {
      const w = await setWebhook(
        b.baseUrl,
        created.instanceToken,
        b.instance,
        withSecret(`${config.publicBaseUrl.replace(/\/+$/, "")}/webhooks/evolution/${id}`, tenant.webhook_secret),
        tenant.webhook_secret,
      );
      webhook = w.ok ? "configurado" : w.raw;
    }
    return { ok: true, qr: created.qr, webhook };
  });

  // devolve a URL exata do webhook (com o secret REAL do banco) p/ colar na Evolution
  app.get("/tenants/:id/webhook-url", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { id } = req.params as { id: string };
    const tenant = await getTenant(id);
    if (!tenant) return reply.code(404).send({ error: "tenant nao encontrado" });
    const path = `/webhooks/evolution/${id}?secret=${encodeURIComponent(tenant.webhook_secret)}`;
    return {
      publica: `${config.publicBaseUrl.replace(/\/+$/, "")}${path}`,
      interna: `http://<projeto>_capi-api:8080${path}`,
      secret: tenant.webhook_secret,
      hint: "Evolution no mesmo host -> use a interna (troque <projeto> pelo nome do projeto Easypanel).",
    };
  });

  // ver o webhook configurado na Evolution (debug)
  app.get("/tenants/:id/webhook", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const tenant = await getTenant((req.params as { id: string }).id);
    if (!tenant) return reply.code(404).send({ error: "tenant nao encontrado" });
    return getWebhook(tenant);
  });

  // (re)configura o webhook da Evolution para uma URL (default = interna se informada)
  app.post("/tenants/:id/webhook", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { id } = req.params as { id: string };
    const tenant = await getTenant(id);
    if (!tenant) return reply.code(404).send({ error: "tenant nao encontrado" });
    const cfg = evoConfig(tenant);
    if (!cfg) return reply.code(400).send({ error: "instancia do Evolution nao configurada" });
    const b = (req.body ?? {}) as Record<string, string>;
    const url = withSecret(
      b.url?.trim() || `${config.publicBaseUrl.replace(/\/+$/, "")}/webhooks/evolution/${id}`,
      tenant.webhook_secret,
    );
    const w = await setWebhook(cfg.baseUrl, cfg.apiKey, cfg.instance, url, tenant.webhook_secret);
    return { ok: w.ok, url, result: w.raw };
  });

  // estado da conexao + QR (quando ainda nao conectado)
  app.get("/tenants/:id/connection", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const tenant = await getTenant((req.params as { id: string }).id);
    if (!tenant) return reply.code(404).send({ error: "tenant nao encontrado" });
    const state = await connectionState(tenant);
    if (!state.configured) return { configured: false };
    if (state.state === "open") return { configured: true, state: "open" };
    const qr = await connectQr(tenant);
    return { configured: true, state: state.state, qr: qr.base64, pairing_code: qr.pairingCode };
  });

  // lista todos os grupos da instancia, marcando os ja rastreados
  app.post("/tenants/:id/discover-groups", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const tenant = await getTenant((req.params as { id: string }).id);
    if (!tenant) return reply.code(404).send({ error: "tenant nao encontrado" });
    const [all, tracked] = await Promise.all([fetchAllGroups(tenant), getTenantGroups(tenant.id)]);
    if (!all.configured) return reply.code(400).send({ error: "instancia do Evolution nao configurada" });
    const trackedSet = new Set(tracked.map((g) => g.group_jid));
    // dedup por jid (a Evolution às vezes devolve o mesmo grupo repetido durante o sync)
    const uniq = [...new Map(all.groups.filter((g) => g.jid).map((g) => [g.jid, g])).values()];
    uniq.sort((a, b) => (a.name || "").localeCompare(b.name || "", "pt"));
    return {
      ok: all.ok,
      groups: uniq.map((g) => ({ ...g, tracked: trackedSet.has(g.jid) })),
    };
  });

  // registra um grupo na allowlist (+ rotulo) e opcionalmente faz backfill de membros
  app.post("/tenants/:id/groups", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (!b.groupJid) return reply.code(400).send({ error: "groupJid obrigatorio" });
    const tenant = await getTenant(id);
    if (!tenant) return reply.code(404).send({ error: "tenant nao encontrado" });

    if (b.untrack) {
      await untrackTenantGroup(id, b.groupJid as string);
      return { ok: true, untracked: true };
    }

    await upsertTenantGroup({
      tenantId: id,
      groupJid: b.groupJid as string,
      groupName: (b.groupName as string) ?? null,
      campaignLabel: (b.campaignLabel as string) ?? null,
    });

    let backfilled = 0;
    let fetched = 0;
    if (b.backfill || b.sync) {
      const p = await fetchParticipants(tenant, b.groupJid as string);
      fetched = p.participants.length;
      for (const part of p.participants) {
        const phone = jidToE164(part.jid);
        if (!phone) continue;
        await upsertGroupMember({
          tenantId: id,
          groupJid: b.groupJid as string,
          phoneE164: phone,
          isAdmin: part.admin,
          source: "backfill",
          present: true,
        });
        backfilled++;
      }
    }
    return { ok: true, backfilled, fetched };
  });

  // cria / remove um link encurtado
  app.post("/tenants/:id/links", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as Record<string, string>;
    const slug = String(b.slug ?? "").split(/[/\s]+/).filter(Boolean).pop()?.toLowerCase() ?? "";
    if (!/^[a-z0-9._-]{1,60}$/.test(slug)) {
      return reply.code(400).send({ error: "slug inválido (use só letras, números, - ou _)" });
    }
    if (!(await getTenant(id))) return reply.code(404).send({ error: "tenant nao encontrado" });

    if (b.remove) {
      await deleteLink(id, slug);
      return { ok: true, removed: true };
    }

    let dest = String(b.destinationUrl ?? "").trim();
    if (!dest) return reply.code(400).send({ error: "destino obrigatório" });
    if (!/^https?:\/\//i.test(dest) && !dest.startsWith("/")) dest = "https://" + dest;

    await createLink({
      tenantId: id,
      slug,
      destinationUrl: dest,
      campaignLabel: b.campaignLabel ?? null,
      message: b.message ?? null,
    });
    return { ok: true, slug, path: `/r/${slug}`, destination: dest };
  });

  // importa membros em massa para um grupo (da extensão / CSV). NÃO gera evento CAPI.
  app.post("/tenants/:id/members/import", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { id } = req.params as { id: string };
    if (!(await getTenant(id))) return reply.code(404).send({ error: "tenant nao encontrado" });
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (!b.groupJid) return reply.code(400).send({ error: "groupJid obrigatorio" });
    const raw = Array.isArray(b.phones)
      ? (b.phones as string[])
      : String(b.phones ?? "").split(/[\s,;]+/);
    const phones = [...new Set(raw.map((x) => toE164(x)).filter((x): x is string => Boolean(x)))];
    if (!phones.length) return reply.code(400).send({ error: "nenhum telefone válido" });
    if (b.groupName) {
      await upsertTenantGroup({
        tenantId: id,
        groupJid: b.groupJid as string,
        groupName: b.groupName as string,
        campaignLabel: null,
      });
    }
    const imported = await importGroupMembers({ tenantId: id, groupJid: b.groupJid as string, phones });
    return { ok: true, imported };
  });

  app.get("/tenants/:id/dashboard", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { id } = req.params as { id: string };
    if (!(await getTenant(id))) return reply.code(404).send({ error: "tenant nao encontrado" });
    const days = Number((req.query as { days?: string })?.days ?? 14);
    return dashboardData(id, days);
  });

  app.get("/tenants/:id/events", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { id } = req.params as { id: string };
    const limit = Number((req.query as { limit?: string })?.limit ?? 100);
    return {
      status: await statusCounts(id),
      lead_status: await leadStatusCounts(id),
      match_readiness: await matchReadiness(id),
      events: await listEvents(id, limit),
    };
  });

  // ---- Lead do clique do botao da landing page --------------------
  app.options("/lead/:tenantId", async (req, reply) => {
    setCors(req, reply);
    reply.code(204).send();
  });

  app.post("/lead/:tenantId", async (req, reply) => {
    setCors(req, reply);
    const { tenantId } = req.params as { tenantId: string };
    const tenant = await getTenant(tenantId);
    if (!tenant) return reply.code(404).send({ error: "tenant nao encontrado" });

    const origin = String(req.headers.origin ?? "");
    if (tenant.lp_origin && origin && !origin.startsWith(tenant.lp_origin)) {
      return reply.code(403).send({ error: "origin nao autorizada" });
    }

    const b = (req.body ?? {}) as Record<string, unknown>;
    const input: LeadInput = {
      eventId: (b.event_id ?? b.eventId) as string | undefined,
      fbp: b.fbp as string | undefined,
      fbc: b.fbc as string | undefined,
      fbclid: b.fbclid as string | undefined,
      externalId: (b.external_id ?? b.externalId) as string | undefined,
      eventSourceUrl: (b.event_source_url ?? b.eventSourceUrl) as string | undefined,
    };
    const res = await ingestLead(tenant, input, {
      ip: clientIp(req),
      ua: String(req.headers["user-agent"] ?? "") || undefined,
    });
    return { ok: true, ...res };
  });

  // ---- ingest generico ---------------------------------------------
  app.post("/events", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const b = (req.body ?? {}) as Record<string, unknown>;
    const tenant = await getTenant(b.tenantId as string);
    if (!tenant) return reply.code(404).send({ error: "tenant nao encontrado" });
    const summary = await ingestEvents(tenant, mapJoins(b));
    return { ok: true, summary };
  });

  app.post("/webhooks/ingest/:tenantId", async (req, reply) => {
    const { tenantId } = req.params as { tenantId: string };
    const tenant = await getTenant(tenantId);
    if (!tenant) return reply.code(404).send({ error: "tenant nao encontrado" });
    if (req.headers["x-webhook-secret"] !== tenant.webhook_secret) {
      return reply.code(401).send({ error: "assinatura invalida" });
    }
    const summary = await ingestEvents(tenant, mapJoins((req.body ?? {}) as Record<string, unknown>));
    return { ok: true, summary };
  });



  // ---- leitura das mensagens do WhatsApp (auditoria) --------------
  // Protegidas pelo Basic Auth do dashboard (hook em /tenants/*).

  app.get("/tenants/:id/wa/stats", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { id } = req.params as { id: string };
    return { ...(await waStats(id)), buckets: await waResponseBuckets(id) };
  });

  app.get("/tenants/:id/wa/conversations", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { id } = req.params as { id: string };
    const q = req.query as Record<string, string>;
    return {
      conversations: await listWaConversations(id, {
        limit: q.limit ? Number(q.limit) : undefined,
        offset: q.offset ? Number(q.offset) : undefined,
        unanswered: q.unanswered === "1" || q.unanswered === "true",
      }),
    };
  });

  app.get("/tenants/:id/wa/messages", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { id } = req.params as { id: string };
    const q = req.query as Record<string, string>;
    const direction = q.direction === "in" || q.direction === "out" ? q.direction : undefined;
    return {
      messages: await listWaMessages(id, {
        phone: q.phone ? toE164(q.phone) : undefined,
        q: q.q,
        direction,
        from: q.from,
        to: q.to,
        limit: q.limit ? Number(q.limit) : undefined,
        offset: q.offset ? Number(q.offset) : undefined,
      }),
    };
  });

  app.post("/tenants/:id/wa/backfill", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { id } = req.params as { id: string };
    return await waBackfill(id);
  });

  // ---- webhook do WhatsApp Cloud API (Meta) -----------------------
  // Recebe em paralelo ao BSP (Kommo), que segue inscrito na mesma WABA.

  // handshake: a Meta chama uma vez ao salvar a callback URL
  app.get("/webhooks/whatsapp/:tenantId", async (req, reply) => {
    const q = req.query as Record<string, string>;
    if (q["hub.mode"] === "subscribe" && q["hub.verify_token"] === config.wa.verifyToken) {
      return reply.type("text/plain").send(q["hub.challenge"] ?? "");
    }
    return reply.code(403).send({ error: "verify token invalido" });
  });

  app.post("/webhooks/whatsapp/:tenantId", async (req, reply) => {
    const { tenantId } = req.params as { tenantId: string };
    const tenant = await getTenant(tenantId);
    if (!tenant) return reply.code(404).send({ error: "tenant nao encontrado" });

    const raw = (req as unknown as { rawBody?: Buffer }).rawBody ?? Buffer.from("");
    const sig = String(req.headers["x-hub-signature-256"] ?? "");
    if (!verifySignature(raw, sig, config.wa.appSecret)) {
      return reply.code(401).send({ error: "assinatura invalida" });
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    await saveWaRaw(tenant.id, body);

    const { messages, statuses } = parseWebhook(body);

    for (const m of messages) {
      await saveWaMessage(tenant.id, m);
      // clique de anuncio: alimenta a mesma tabela que o Evolution ja usa
      if (m.ctwaClid && m.contactPhone) {
        await recordCtwaLead({
          tenantId: tenant.id,
          phoneE164: m.contactPhone,
          ctwaClid: m.ctwaClid,
          sourceId: m.phoneNumberId ?? null,
        });
      }
    }
    for (const s of statuses) await updateWaStatus(tenant.id, s);

    logger.info(
      { tenant: tenant.id, messages: messages.length, statuses: statuses.length },
      "whatsapp webhook in",
    );

    // 200 rapido: a Meta reentrega (e degrada o app) se demorar ou falhar
    return { ok: true };
  });

  // ---- webhook do Evolution API (fonte principal) -----------------
  app.post("/webhooks/evolution/:tenantId", async (req, reply) => {
    const { tenantId } = req.params as { tenantId: string };
    const tenant = await getTenant(tenantId);
    if (!tenant) return reply.code(404).send({ error: "tenant nao encontrado" });
    const provided =
      (req.headers["x-webhook-secret"] as string | undefined) ??
      (req.query as { secret?: string })?.secret ??
      "";
    if (provided !== tenant.webhook_secret) {
      return reply.code(401).send({ error: "assinatura invalida" });
    }

    const body = (req.body ?? {}) as Record<string, any>;
    const data = body.data ?? {};
    const evName = String(body.event ?? "").toLowerCase().replace(/[_-]/g, "");
    const action = String(data.action ?? "").toLowerCase();
    const isParticipants =
      evName.includes("groupparticipants") || action === "add" || action === "remove";

    logger.info(
      {
        tenant: tenant.id,
        event: body.event,
        action: data.action,
        groupJid: data.id ?? data.groupJid ?? data.remoteJid,
        participants: Array.isArray(data.participants) ? data.participants.length : undefined,
      },
      "evolution webhook in",
    );

    if (isParticipants) {
      if (action !== "add" && action !== "remove") {
        return { ok: true, ignored: `action=${action || "?"}` };
      }

      const groupJid: string | undefined = data.id ?? data.groupJid ?? data.remoteJid;
      const groups = await getTenantGroups(tenant.id);
      let campaignLabel: string | undefined;
      let groupName: string | undefined = data.subject ?? data.groupName;
      if (groups.length > 0) {
        const hit = groups.find((g) => g.group_jid === groupJid);
        if (!hit) {
          logger.warn(
            { groupJid, tracked: groups.map((g) => g.group_jid) },
            "webhook: grupo fora da allowlist",
          );
          return { ok: true, ignored: "grupo fora da allowlist" };
        }
        campaignLabel = hit.campaign_label ?? undefined;
        groupName = groupName ?? hit.group_name ?? undefined;
      }

      const author: string | undefined = data.author;
      const rawParticipants: Array<string | Record<string, any>> = Array.isArray(data.participants)
        ? data.participants
        : [];
      const membershipAction = action === "add" ? "entrada" : "saida";

      const joinEvents: NormalizedEvent[] = [];
      for (const p of rawParticipants) {
        const jid = typeof p === "string" ? p : (p.id ?? p.jid);
        if (!jid) continue;
        const phone = jidToE164(jid);
        const selfAction = !author || sameJid(author, jid);

        // 1) log para o dashboard (sempre, entrada e saida)
        await logMembership({
          tenantId: tenant.id,
          groupJid: groupJid ?? "",
          groupName,
          campaignLabel,
          action: membershipAction,
          phoneE164: phone,
          actor: selfAction ? null : jidToE164(author),
          selfAction,
        });

        // 2) snapshot de membros
        if (phone && groupJid) {
          await upsertGroupMember({
            tenantId: tenant.id,
            groupJid,
            phoneE164: phone,
            source: "live",
            present: action === "add",
          });
        }

        // 3) CAPI so para entrada (respeitando join_filter)
        if (action === "add" && !(tenant.join_filter === "self_only" && !selfAction)) {
          joinEvents.push({
            action: "entrada",
            phoneE164: phone,
            displayName:
              typeof p === "object" ? (p.pushName ?? p.name ?? p.notify ?? undefined) : undefined,
            groupJid,
            groupName,
            addedBy: selfAction ? undefined : jidToE164(author),
            campaignLabel,
            eventTime: new Date(),
          });
        }
      }

      const summary = joinEvents.length ? await ingestEvents(tenant, joinEvents) : null;
      return { ok: true, action: membershipAction, logged: rawParticipants.length, capi: summary };
    }

    const clid = extractCtwaClid(data);
    if (clid) {
      const phone = jidToE164(data?.key?.remoteJid ?? data?.remoteJid ?? data?.from);
      if (phone) {
        await recordCtwaLead({
          tenantId: tenant.id,
          phoneE164: phone,
          ctwaClid: clid,
          sourceId: extractSourceId(data),
        });
        return { ok: true, ctwa: "registrado" };
      }
    }

    return { ok: true, ignored: evName || "evento sem mapeamento" };
  });
}

function extractCtwaClid(data: Record<string, any>): string | undefined {
  const ctx =
    data?.message?.extendedTextMessage?.contextInfo ??
    data?.message?.contextInfo ??
    data?.contextInfo;
  return ctx?.externalAdReply?.ctwaClid ?? ctx?.ctwaClid ?? data?.ctwaClid ?? undefined;
}

function extractSourceId(data: Record<string, any>): string | undefined {
  const ctx = data?.message?.extendedTextMessage?.contextInfo ?? data?.contextInfo;
  return ctx?.externalAdReply?.sourceId ?? ctx?.externalAdReply?.sourceUrl ?? undefined;
}
