import { pool } from "./db.js";
import type { WaMessage, WaStatus } from "./core/whatsapp.js";
import type {
  CapiEventRow,
  LeadEventRow,
  LeadInput,
  NormalizedEvent,
  Tenant,
  TenantGroup,
} from "./types.js";

export async function upsertTenant(t: {
  id: string;
  name: string;
  pixelId: string;
  capiToken: string;
  webhookSecret: string;
  testEventCode?: string | null;
  eventName?: string | null;
  joinFilter?: string | null;
  lpOrigin?: string | null;
}): Promise<void> {
  await pool.query(
    `insert into tenants
       (id, name, pixel_id, capi_token, webhook_secret, test_event_code, event_name, join_filter, lp_origin)
     values ($1, $2, $3, $4, $5, $6, coalesce($7, 'JoinGroup'), coalesce($8, 'all'), $9)
     on conflict (id) do update set
       name            = excluded.name,
       pixel_id        = excluded.pixel_id,
       capi_token      = excluded.capi_token,
       webhook_secret  = excluded.webhook_secret,
       test_event_code = excluded.test_event_code,
       event_name      = excluded.event_name,
       join_filter     = excluded.join_filter,
       lp_origin       = excluded.lp_origin`,
    [
      t.id, t.name, t.pixelId, t.capiToken, t.webhookSecret,
      t.testEventCode ?? null, t.eventName ?? null, t.joinFilter ?? null, t.lpOrigin ?? null,
    ],
  );
}

export async function getTenant(id?: string): Promise<Tenant | undefined> {
  if (!id) return undefined;
  const { rows } = await pool.query<Tenant>(
    "select * from tenants where id = $1 and active = true",
    [id],
  );
  return rows[0];
}

export async function setTenantInstance(t: {
  id: string;
  baseUrl: string;
  apiKey: string;
  instance: string;
}): Promise<void> {
  await pool.query(
    "update tenants set evo_base_url = $2, evo_api_key = $3, evo_instance = $4 where id = $1",
    [t.id, t.baseUrl, t.apiKey, t.instance],
  );
}

export async function setTenantMeta(t: {
  id: string;
  pixelId: string;
  capiToken: string;
  testEventCode?: string | null;
  eventName?: string | null;
}): Promise<void> {
  await pool.query(
    `update tenants set
        pixel_id        = $2,
        capi_token      = $3,
        test_event_code = $4,
        event_name      = coalesce($5, event_name)
      where id = $1`,
    [t.id, t.pixelId, t.capiToken, t.testEventCode ?? null, t.eventName ?? null],
  );
}

export async function getTenantGroups(tenantId: string): Promise<TenantGroup[]> {
  const { rows } = await pool.query<TenantGroup>(
    `select tenant_id, group_jid, group_name, campaign_label, active
       from tenant_groups
      where tenant_id = $1 and active = true`,
    [tenantId],
  );
  return rows;
}

export async function untrackTenantGroup(tenantId: string, groupJid: string): Promise<void> {
  await pool.query(
    "update tenant_groups set active = false where tenant_id = $1 and group_jid = $2",
    [tenantId, groupJid],
  );
}

export async function upsertTenantGroup(t: {
  tenantId: string;
  groupJid: string;
  groupName?: string | null;
  campaignLabel?: string | null;
}): Promise<void> {
  await pool.query(
    `insert into tenant_groups (tenant_id, group_jid, group_name, campaign_label)
     values ($1, $2, $3, $4)
     on conflict (tenant_id, group_jid) do update set
       group_name     = excluded.group_name,
       campaign_label = excluded.campaign_label,
       active         = true`,
    [t.tenantId, t.groupJid, t.groupName ?? null, t.campaignLabel ?? null],
  );
}

/** Insere o evento como pending. Se ja existe (dedupe), retorna isNew=false. */
export async function insertPendingEvent(row: {
  tenantId: string;
  eventId: string;
  eventName: string;
  ev: NormalizedEvent;
}): Promise<{ id: string; isNew: boolean }> {
  const { ev } = row;
  const ins = await pool.query<{ id: string }>(
    `insert into capi_events
       (tenant_id, event_id, event_name, action, phone_e164, display_name,
        group_jid, group_name, added_by, campaign_label, event_time)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     on conflict (tenant_id, event_name, event_id) do nothing
     returning id`,
    [
      row.tenantId, row.eventId, row.eventName, ev.action,
      ev.phoneE164 ?? null, ev.displayName ?? null,
      ev.groupJid ?? null, ev.groupName ?? null, ev.addedBy ?? null,
      ev.campaignLabel ?? null, ev.eventTime.toISOString(),
    ],
  );
  if (ins.rows[0]) return { id: ins.rows[0].id, isNew: true };

  const existing = await pool.query<{ id: string }>(
    "select id from capi_events where tenant_id = $1 and event_name = $2 and event_id = $3",
    [row.tenantId, row.eventName, row.eventId],
  );
  return { id: existing.rows[0].id, isNew: false };
}

export async function getEvent(id: string): Promise<CapiEventRow | undefined> {
  const { rows } = await pool.query<CapiEventRow>("select * from capi_events where id = $1", [id]);
  return rows[0];
}

export async function markSent(id: string, graphResponse: unknown, matchedCtwa: boolean): Promise<void> {
  await pool.query(
    `update capi_events
        set status = 'sent', sent_at = now(), attempts = attempts + 1,
            graph_response = $2, matched_ctwa = $3, error = null
      where id = $1`,
    [id, JSON.stringify(graphResponse), matchedCtwa],
  );
}

export async function markFailed(id: string, error: string, graphResponse?: unknown): Promise<void> {
  await pool.query(
    `update capi_events
        set status = 'failed', attempts = attempts + 1, error = $2, graph_response = $3
      where id = $1`,
    [id, error, graphResponse ? JSON.stringify(graphResponse) : null],
  );
}

export async function markSkipped(id: string, reason: string): Promise<void> {
  await pool.query("update capi_events set status = 'skipped', error = $2 where id = $1", [id, reason]);
}

export async function bumpAttempts(id: string): Promise<void> {
  await pool.query("update capi_events set attempts = attempts + 1 where id = $1", [id]);
}

export async function recordCtwaLead(t: {
  tenantId: string;
  phoneE164: string;
  ctwaClid: string;
  sourceId?: string | null;
}): Promise<void> {
  await pool.query(
    "insert into ctwa_leads (tenant_id, phone_e164, ctwa_clid, source_id) values ($1,$2,$3,$4)",
    [t.tenantId, t.phoneE164, t.ctwaClid, t.sourceId ?? null],
  );
}

// ---------------------------------------------------- membros e log de grupo

export async function logMembership(m: {
  tenantId: string;
  groupJid: string;
  groupName?: string | null;
  campaignLabel?: string | null;
  action: "entrada" | "saida";
  phoneE164?: string | null;
  actor?: string | null;
  selfAction?: boolean | null;
  occurredAt?: Date;
}): Promise<void> {
  await pool.query(
    `insert into membership_log
       (tenant_id, group_jid, group_name, campaign_label, action, phone_e164, actor, self_action, occurred_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      m.tenantId, m.groupJid, m.groupName ?? null, m.campaignLabel ?? null, m.action,
      m.phoneE164 ?? null, m.actor ?? null, m.selfAction ?? null,
      (m.occurredAt ?? new Date()).toISOString(),
    ],
  );
}

export async function upsertGroupMember(g: {
  tenantId: string;
  groupJid: string;
  phoneE164: string;
  isAdmin?: boolean;
  source?: "backfill" | "live";
  present?: boolean;
}): Promise<void> {
  await pool.query(
    `insert into group_members (tenant_id, group_jid, phone_e164, is_admin, source, present)
     values ($1,$2,$3,$4,$5,$6)
     on conflict (tenant_id, group_jid, phone_e164) do update set
       is_admin  = excluded.is_admin,
       last_seen = now(),
       present   = excluded.present`,
    [
      g.tenantId, g.groupJid, g.phoneE164, g.isAdmin ?? false,
      g.source ?? "live", g.present ?? true,
    ],
  );
}

// --------------------------------------------------------------- links

export async function createLink(l: {
  tenantId: string;
  slug: string;
  destinationUrl: string;
  campaignLabel?: string | null;
  message?: string | null;
}): Promise<{ id: string }> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into links (tenant_id, slug, destination_url, campaign_label, message)
     values ($1,$2,$3,$4,$5)
     on conflict (slug) do update set
       destination_url = excluded.destination_url,
       campaign_label  = excluded.campaign_label,
       message         = excluded.message,
       active = true
     returning id`,
    [l.tenantId, l.slug, l.destinationUrl, l.campaignLabel ?? null, l.message ?? null],
  );
  return rows[0];
}

export async function deleteLink(tenantId: string, slug: string): Promise<void> {
  await pool.query("update links set active = false where tenant_id = $1 and slug = $2", [
    tenantId,
    slug,
  ]);
}

export async function importGroupMembers(t: {
  tenantId: string;
  groupJid: string;
  phones: string[];
}): Promise<number> {
  let n = 0;
  for (const phone of t.phones) {
    await pool.query(
      `insert into group_members (tenant_id, group_jid, phone_e164, source, present)
       values ($1, $2, $3, 'import', true)
       on conflict (tenant_id, group_jid, phone_e164)
       do update set last_seen = now(), present = true`,
      [t.tenantId, t.groupJid, phone],
    );
    n++;
  }
  return n;
}

export async function getLinkBySlug(slug: string): Promise<
  { id: string; destination_url: string; active: boolean } | undefined
> {
  const { rows } = await pool.query(
    "select id, destination_url, active from links where slug = $1",
    [slug],
  );
  return rows[0];
}

export async function logLinkClick(c: {
  linkId: string;
  campaign?: string | null;
  ip?: string | null;
  ua?: string | null;
  referer?: string | null;
  isBot: boolean;
}): Promise<void> {
  await pool.query(
    "insert into link_clicks (link_id, campaign, ip, ua, referer, is_bot) values ($1,$2,$3,$4,$5,$6)",
    [c.linkId, c.campaign ?? null, c.ip ?? null, c.ua ?? null, c.referer ?? null, c.isBot],
  );
}

// ------------------------------------------------------------- dashboard

export async function dashboardData(tenantId: string, days = 14): Promise<Record<string, unknown>> {
  const d = String(Math.min(Math.max(days, 1), 365));

  const groups = (
    await pool.query(
      "select group_jid, group_name, campaign_label from tenant_groups where tenant_id = $1 and active order by created_at",
      [tenantId],
    )
  ).rows as Array<{ group_jid: string; group_name: string | null; campaign_label: string | null }>;

  const members = (
    await pool.query<{ group_jid: string; n: number }>(
      "select group_jid, count(*)::int as n from group_members where tenant_id = $1 and present group by group_jid",
      [tenantId],
    )
  ).rows;

  const series = (
    await pool.query<{ group_jid: string; action: string; d: string; n: number }>(
      `select group_jid, action, to_char(date_trunc('day', occurred_at), 'YYYY-MM-DD') as d, count(*)::int as n
         from membership_log
        where tenant_id = $1 and occurred_at >= now() - ($2 || ' days')::interval
        group by 1, 2, 3`,
      [tenantId, d],
    )
  ).rows;

  // totais de todo o período (sem janela)
  const totals = (
    await pool.query<{ group_jid: string; action: string; n: number }>(
      "select group_jid, action, count(*)::int as n from membership_log where tenant_id = $1 group by 1, 2",
      [tenantId],
    )
  ).rows;
  const totalOf = (jid: string, action: string) =>
    Number(totals.find((t) => t.group_jid === jid && t.action === action)?.n ?? 0);

  const memberOf = new Map(members.map((m) => [m.group_jid, Number(m.n)]));
  const groupsOut = groups.map((g) => {
    const rows = series.filter((s) => s.group_jid === g.group_jid);
    const daily = (action: string) => {
      const m = new Map(rows.filter((r) => r.action === action).map((r) => [r.d, Number(r.n)]));
      return lastNDays(Number(d)).map((day) => ({ d: day, n: m.get(day) ?? 0 }));
    };
    const joins = daily("entrada");
    const leaves = daily("saida");
    return {
      group_jid: g.group_jid,
      group_name: g.group_name,
      campaign_label: g.campaign_label,
      members_present: memberOf.get(g.group_jid) ?? 0,
      joins_period: joins.reduce((a, x) => a + x.n, 0),
      leaves_period: leaves.reduce((a, x) => a + x.n, 0),
      joins_total: totalOf(g.group_jid, "entrada"),
      leaves_total: totalOf(g.group_jid, "saida"),
      joins_series: joins,
      leaves_series: leaves,
    };
  });

  const linkRows = (
    await pool.query<{
      id: string; slug: string; destination_url: string; campaign_label: string | null; message: string | null;
      clicks_total: number; clicks_7d: number;
    }>(
      `select l.id, l.slug, l.destination_url, l.campaign_label, l.message,
              count(c.*) filter (where not c.is_bot)::int as clicks_total,
              count(c.*) filter (where not c.is_bot and c.clicked_at >= now() - interval '7 days')::int as clicks_7d
         from links l
         left join link_clicks c on c.link_id = l.id
        where l.tenant_id = $1 and l.active
        group by l.id
        order by l.created_at desc`,
      [tenantId],
    )
  ).rows;

  const linkSeries = (
    await pool.query<{ link_id: string; d: string; n: number }>(
      `select c.link_id, to_char(date_trunc('day', c.clicked_at), 'YYYY-MM-DD') as d, count(*)::int as n
         from link_clicks c
         join links l on l.id = c.link_id
        where l.tenant_id = $1 and not c.is_bot
          and c.clicked_at >= now() - ($2 || ' days')::interval
        group by 1, 2`,
      [tenantId, d],
    )
  ).rows;

  // quebra por oferta (?c= na URL)
  const byCampaign = (
    await pool.query<{ link_id: string; campaign: string | null; total: number; window: number; last_at: string }>(
      `select c.link_id,
              coalesce(c.campaign, '(sem tag)') as campaign,
              count(*) filter (where not c.is_bot)::int as total,
              count(*) filter (where not c.is_bot and c.clicked_at >= now() - ($2 || ' days')::interval)::int as window,
              max(c.clicked_at) as last_at
         from link_clicks c
         join links l on l.id = c.link_id
        where l.tenant_id = $1
        group by 1, 2
        order by 3 desc`,
      [tenantId, d],
    )
  ).rows;

  const linksOut = linkRows.map((l) => {
    const m = new Map(linkSeries.filter((s) => s.link_id === l.id).map((s) => [s.d, Number(s.n)]));
    return {
      slug: l.slug,
      destination_url: l.destination_url,
      campaign_label: l.campaign_label,
      message: l.message,
      clicks_total: Number(l.clicks_total),
      clicks_7d: Number(l.clicks_7d),
      series: lastNDays(Number(d)).map((day) => ({ d: day, n: m.get(day) ?? 0 })),
      by_campaign: byCampaign
        .filter((r) => r.link_id === l.id)
        .map((r) => ({
          campaign: r.campaign,
          total: Number(r.total),
          window: Number(r.window),
          last_at: r.last_at,
        })),
    };
  });

  const [capiJoins, capiLeads, t, uniq] = await Promise.all([
    statusCounts(tenantId),
    leadStatusCounts(tenantId),
    getTenant(tenantId),
    pool.query<{ n: number }>(
      "select count(distinct phone_e164)::int as n from group_members where tenant_id = $1 and present",
      [tenantId],
    ),
  ]);
  const uniqueMembers = Number(uniq.rows[0]?.n ?? 0);

  return {
    days: Number(d),
    unique_members: uniqueMembers,
    groups: groupsOut,
    links: linksOut,
    capi: {
      joins: capiJoins,
      leads: capiLeads,
      meta_configured: Boolean(t?.pixel_id && t?.capi_token),
      pixel_id: t?.pixel_id ?? null,
      event_name: t?.event_name ?? null,
      test_mode: Boolean(t?.test_event_code),
    },
  };
}

function lastNDays(n: number): string[] {
  const out: string[] = [];
  const now = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const dt = new Date(now);
    dt.setUTCDate(dt.getUTCDate() - i);
    out.push(dt.toISOString().slice(0, 10));
  }
  return out;
}

// ------------------------------------------------------------- lead events

export async function insertPendingLead(row: {
  tenantId: string;
  eventId: string;
  input: LeadInput;
  clientIp?: string;
  clientUa?: string;
}): Promise<{ id: string; isNew: boolean }> {
  const { input } = row;
  const ins = await pool.query<{ id: string }>(
    `insert into lead_events
       (tenant_id, event_id, fbp, fbc, external_id, event_source_url,
        client_ip, client_ua, event_time)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     on conflict (tenant_id, event_id) do nothing
     returning id`,
    [
      row.tenantId, row.eventId,
      input.fbp ?? null,
      input.fbc ?? (input.fbclid ? `fb.1.${Date.now()}.${input.fbclid}` : null),
      input.externalId ?? null,
      input.eventSourceUrl ?? null,
      row.clientIp ?? null, row.clientUa ?? null,
      (input.eventTime ?? new Date()).toISOString(),
    ],
  );
  if (ins.rows[0]) return { id: ins.rows[0].id, isNew: true };

  const existing = await pool.query<{ id: string }>(
    "select id from lead_events where tenant_id = $1 and event_id = $2",
    [row.tenantId, row.eventId],
  );
  return { id: existing.rows[0].id, isNew: false };
}

export async function getLead(id: string): Promise<LeadEventRow | undefined> {
  const { rows } = await pool.query<LeadEventRow>("select * from lead_events where id = $1", [id]);
  return rows[0];
}

export async function markLeadSent(id: string, graphResponse: unknown): Promise<void> {
  await pool.query(
    `update lead_events
        set status = 'sent', sent_at = now(), attempts = attempts + 1,
            graph_response = $2, error = null
      where id = $1`,
    [id, JSON.stringify(graphResponse)],
  );
}

export async function markLeadFailed(id: string, error: string, graphResponse?: unknown): Promise<void> {
  await pool.query(
    `update lead_events
        set status = 'failed', attempts = attempts + 1, error = $2, graph_response = $3
      where id = $1`,
    [id, error, graphResponse ? JSON.stringify(graphResponse) : null],
  );
}

export async function bumpLeadAttempts(id: string): Promise<void> {
  await pool.query("update lead_events set attempts = attempts + 1 where id = $1", [id]);
}

export async function leadStatusCounts(tenantId: string): Promise<Record<string, number>> {
  const { rows } = await pool.query<{ status: string; n: number }>(
    "select status, count(*)::int as n from lead_events where tenant_id = $1 group by status",
    [tenantId],
  );
  return Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
}

// ------------------------------------------------------------------------

export async function listEvents(tenantId: string, limit = 100): Promise<Record<string, unknown>[]> {
  const { rows } = await pool.query(
    `select id, event_id, event_name, action, phone_e164, display_name, group_name,
            campaign_label, status, attempts, matched_ctwa, event_time, received_at, sent_at, error
       from capi_events
      where tenant_id = $1
      order by received_at desc
      limit $2`,
    [tenantId, Math.min(Math.max(limit, 1), 1000)],
  );
  return rows;
}

export async function statusCounts(tenantId: string): Promise<Record<string, number>> {
  const { rows } = await pool.query<{ status: string; n: number }>(
    "select status, count(*)::int as n from capi_events where tenant_id = $1 group by status",
    [tenantId],
  );
  return Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
}

/**
 * Proxy local de "prontidao para match" — NAO e o Event Match Quality do Meta
 * (esse so aparece no Gerenciador de Eventos), mas indica quanto dado util
 * estamos conseguindo anexar.
 */
export async function matchReadiness(tenantId: string): Promise<Record<string, number>> {
  const { rows } = await pool.query<{
    total: number; with_phone: number; with_name: number; sent: number; matched_ctwa: number;
  }>(
    `select
        count(*)::int                                   as total,
        count(phone_e164)::int                          as with_phone,
        count(display_name)::int                        as with_name,
        (count(*) filter (where status = 'sent'))::int  as sent,
        (count(*) filter (where matched_ctwa))::int     as matched_ctwa
       from capi_events
      where tenant_id = $1`,
    [tenantId],
  );
  const r = rows[0] ?? { total: 0, with_phone: 0, with_name: 0, sent: 0, matched_ctwa: 0 };
  const total = Number(r.total);
  return {
    total,
    with_phone: Number(r.with_phone),
    with_name: Number(r.with_name),
    sent: Number(r.sent),
    matched_ctwa: Number(r.matched_ctwa),
    pct_com_telefone: total ? Math.round((Number(r.with_phone) / total) * 100) : 0,
    pct_com_nome: total ? Math.round((Number(r.with_name) / total) * 100) : 0,
  };
}

// ------------------------------------------- mensagens do WhatsApp Cloud API

export async function saveWaRaw(tenantId: string, payload: unknown): Promise<void> {
  await pool.query("insert into wa_webhook_raw (tenant_id, payload) values ($1,$2)", [
    tenantId,
    JSON.stringify(payload),
  ]);
}

/** Idempotente por (tenant, wamid): a Meta reentrega o mesmo evento em caso de falha. */
export async function saveWaMessage(tenantId: string, m: WaMessage): Promise<void> {
  await pool.query(
    `insert into wa_messages
       (tenant_id, wamid, waba_id, phone_number_id, direction, contact_phone,
        contact_name, msg_type, body, ctwa_clid, referral, msg_ts, payload)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     on conflict (tenant_id, wamid) do nothing`,
    [
      tenantId,
      m.wamid,
      m.wabaId ?? null,
      m.phoneNumberId ?? null,
      m.direction,
      m.contactPhone ?? null,
      m.contactName ?? null,
      m.msgType ?? null,
      m.body ?? null,
      m.ctwaClid ?? null,
      m.referral ? JSON.stringify(m.referral) : null,
      m.msgTs,
      JSON.stringify(m.payload),
    ],
  );
}

/**
 * Registra a mensagem de saida a partir do status.
 *
 * A Cloud API nao entrega o conteudo do que o vendedor respondeu (quem envia e
 * a Kommo, por outro app), so o status. Mas o status carrega `recipient_id` e
 * `timestamp` — o suficiente para saber QUE houve resposta e QUANDO, que e o
 * que a regua de 60 minutos precisa. O texto fica indisponivel: `body` nulo.
 *
 * `msg_ts` fica com o menor timestamp visto (o `sent`), mesmo que um `read`
 * chegue antes por reentrega fora de ordem.
 */
export async function updateWaStatus(tenantId: string, s: WaStatus): Promise<void> {
  const rank = (st: string) => ({ sent: 1, delivered: 2, read: 3, failed: 4 }[st] ?? 0);
  await pool.query(
    `insert into wa_messages
       (tenant_id, wamid, phone_number_id, direction, contact_phone, msg_type,
        status, status_at, msg_ts, payload)
     values ($1,$2,$3,'out',$4,'outbound',$5,$6,$6,'{}'::jsonb)
     on conflict (tenant_id, wamid) do update
       set status    = case when $7 >= coalesce(
                                 (case wa_messages.status
                                    when 'sent' then 1 when 'delivered' then 2
                                    when 'read' then 3 when 'failed' then 4 else 0 end), 0)
                            then excluded.status else wa_messages.status end,
           status_at = greatest(coalesce(wa_messages.status_at, excluded.status_at),
                                excluded.status_at),
           msg_ts    = least(wa_messages.msg_ts, excluded.msg_ts)`,
    [tenantId, s.wamid, s.phoneNumberId ?? null, s.recipientPhone ?? null,
     s.status, s.statusAt, rank(s.status)],
  );
}

/** Reprocessa os payloads crus ja salvos. Idempotente. */
export async function waBackfill(tenantId: string): Promise<{ raws: number }> {
  const { rows } = await pool.query<{ payload: Record<string, unknown> }>(
    "select payload from wa_webhook_raw where tenant_id = $1 order by id",
    [tenantId],
  );
  const { parseWebhook } = await import("./core/whatsapp.js");
  for (const r of rows) {
    const { messages, statuses } = parseWebhook(r.payload as Record<string, unknown>);
    for (const m of messages) await saveWaMessage(tenantId, m);
    for (const s of statuses) await updateWaStatus(tenantId, s);
  }
  return { raws: rows.length };
}


/**
 * Base das metricas de atendimento.
 *
 * "Tempo de primeira resposta" so faz sentido quando a empresa responde DEPOIS
 * do cliente falar. Muita conversa comeca com disparo ativo (out antes de
 * qualquer in) — contar isso dava mediana negativa. Aqui `t_out` e sempre o
 * primeiro envio posterior a primeira mensagem recebida, e conversas em que o
 * cliente nunca falou ficam de fora da regua.
 */
const CONV_CTE = `
  with base as (
    select contact_phone, direction, msg_ts, ctwa_clid, body, contact_name
      from wa_messages
     where tenant_id = $1 and contact_phone is not null
  ),
  fin as (
    select contact_phone, min(msg_ts) as t_in
      from base where direction = 'in' group by contact_phone
  ),
  fout as (
    select b.contact_phone, min(b.msg_ts) as t_out
      from base b join fin f on f.contact_phone = b.contact_phone
     where b.direction = 'out' and b.msg_ts >= f.t_in
     group by b.contact_phone
  ),
  conv as (
    select f.contact_phone,
           max(b.contact_name)                                as contact_name,
           count(*)                                           as total,
           count(*) filter (where b.direction = 'in')         as recebidas,
           count(*) filter (where b.direction = 'out')        as enviadas,
           f.t_in                                             as primeira_recebida_em,
           o.t_out                                            as primeira_resposta_em,
           min(b.msg_ts)                                      as primeira_em,
           max(b.msg_ts)                                      as ultima_em,
           max(b.ctwa_clid)                                   as ctwa_clid,
           extract(epoch from (o.t_out - f.t_in))::int        as primeira_resposta_seg,
           (array_agg(b.direction order by b.msg_ts desc))[1] as ultima_direcao
      from fin f
      join base b on b.contact_phone = f.contact_phone
      left join fout o on o.contact_phone = f.contact_phone
     group by f.contact_phone, f.t_in, o.t_out
  )`;

/**
 * Lista conversas: um registro por contato, com a última mensagem e os dados
 * que interessam à auditoria de atendimento (quem falou por último, se houve
 * resposta da empresa, quanto tempo levou o primeiro retorno).
 */
export async function listWaConversations(
  tenantId: string,
  opts: { limit?: number; offset?: number; unanswered?: boolean } = {},
): Promise<Record<string, unknown>[]> {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 1000);
  const { rows } = await pool.query(
    `${CONV_CTE}
     select c.*,
            (select b.body from base b
              where b.contact_phone = c.contact_phone
              order by b.msg_ts desc limit 1) as ultima_mensagem
       from conv c
      where ($4::bool is not true or c.primeira_resposta_em is null)
      order by c.ultima_em desc
      limit $2 offset $3`,
    [tenantId, limit, Math.max(opts.offset ?? 0, 0), opts.unanswered ?? false],
  );
  return rows;
}

/** Mensagens cruas, com filtros. Sem `phone`, devolve a timeline da conta inteira. */
export async function listWaMessages(
  tenantId: string,
  opts: {
    phone?: string;
    q?: string;
    direction?: "in" | "out";
    from?: string;
    to?: string;
    limit?: number;
    offset?: number;
  } = {},
): Promise<Record<string, unknown>[]> {
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 2000);
  const { rows } = await pool.query(
    `select id, wamid, direction, contact_phone, contact_name, msg_type, body,
            ctwa_clid, status, status_at, msg_ts
       from wa_messages
      where tenant_id = $1
        and ($2::text is null or contact_phone = $2)
        and ($3::text is null or body ilike '%' || $3 || '%')
        and ($4::text is null or direction = $4)
        and ($5::timestamptz is null or msg_ts >= $5)
        and ($6::timestamptz is null or msg_ts <= $6)
      order by msg_ts desc
      limit $7 offset $8`,
    [
      tenantId,
      opts.phone ?? null,
      opts.q ?? null,
      opts.direction ?? null,
      opts.from ?? null,
      opts.to ?? null,
      limit,
      Math.max(opts.offset ?? 0, 0),
    ],
  );
  return rows;
}

/** Resumo para o topo da tela: volume, cobertura de resposta e tempo mediano. */
export async function waStats(tenantId: string): Promise<Record<string, unknown>> {
  const { rows } = await pool.query(
    `${CONV_CTE}
     select (select count(*) from wa_messages where tenant_id = $1)                          as mensagens,
            (select count(*) from wa_messages where tenant_id = $1 and direction = 'in')     as recebidas,
            (select count(*) from wa_messages where tenant_id = $1 and direction = 'out')    as enviadas,
            (select count(*) from wa_messages where tenant_id = $1 and ctwa_clid is not null) as de_anuncio,
            (select min(msg_ts) from wa_messages where tenant_id = $1)                       as desde,
            count(*)                                                    as conversas,
            count(*) filter (where primeira_resposta_em is null)         as sem_resposta,
            percentile_cont(0.5) within group (order by primeira_resposta_seg)
              filter (where primeira_resposta_seg is not null)::int      as primeira_resposta_mediana_seg
       from conv`,
    [tenantId],
  );
  return rows[0] ?? {};
}

export async function waResponseBuckets(tenantId: string): Promise<Record<string, unknown>> {
  const { rows } = await pool.query(
    `${CONV_CTE}
     select
       count(*) filter (where primeira_resposta_seg <= 900)                     as ate_15min,
       count(*) filter (where primeira_resposta_seg > 900
                          and primeira_resposta_seg <= 3600)                    as ate_60min,
       count(*) filter (where primeira_resposta_seg > 3600
                          and primeira_resposta_seg <= 86400)                   as acima_60min,
       count(*) filter (where primeira_resposta_seg > 86400)                    as acima_24h,
       count(*) filter (where primeira_resposta_em is null)                     as nunca_respondidas,
       count(*) filter (where ultima_direcao = 'in')                            as aguardando_agora,
       count(*) filter (where ultima_direcao = 'in'
                          and ultima_em < now() - interval '1 hour')            as aguardando_ha_mais_de_1h,
       count(*) filter (where ultima_direcao = 'in'
                          and ultima_em < now() - interval '1 day')             as aguardando_ha_mais_de_1d
       from conv`,
    [tenantId],
  );
  return rows[0] ?? {};
}
