import { config } from "../config.js";
import { sha256, sha1short, onlyDigits, firstName, lastName, ufFromPhone } from "./normalize.js";
import type { LeadInput, NormalizedEvent, Tenant } from "../types.js";

export interface GraphResult {
  ok: boolean;
  status: number;
  body: unknown;
  retryable: boolean;
}

/** Monta um evento no formato da Conversions API a partir de um join normalizado. */
export function buildCapiEvent(
  tenant: Tenant,
  ev: NormalizedEvent,
  eventId: string,
  opts: { ctwaClid?: string } = {},
): Record<string, unknown> {
  const userData: Record<string, unknown> = { country: sha256("br") };

  if (ev.phoneE164) {
    const ph = onlyDigits(ev.phoneE164);
    userData.ph = sha256(ph);
    userData.external_id = sha256(ph);
    const uf = ufFromPhone(ev.phoneE164);
    if (uf) userData.st = sha256(uf);
  }
  const fn = firstName(ev.displayName);
  if (fn) userData.fn = sha256(fn);
  const ln = lastName(ev.displayName);
  if (ln) userData.ln = sha256(ln);

  let actionSource = "system_generated";
  if (opts.ctwaClid) {
    // Join veio de um clique em anuncio Click-to-WhatsApp -> atribuicao real.
    actionSource = "business_messaging";
    userData.fbc = `fb.1.${ev.eventTime.getTime()}.${opts.ctwaClid}`;
  }

  return {
    event_name: tenant.event_name || config.defaultEventName,
    event_time: Math.floor(ev.eventTime.getTime() / 1000),
    action_source: actionSource,
    event_id: eventId,
    user_data: userData,
    custom_data: {
      group_name: ev.groupName ?? "",
      group_jid: ev.groupJid ?? "",
      added_by: ev.addedBy ?? "",
      campaign_label: ev.campaignLabel ?? "",
      membership_action: ev.action,
      channel: "whatsapp_community",
    },
  };
}

/**
 * Evento Lead do clique no botao da landing page.
 * action_source: website, com fbc/fbp/ip/ua -> EMQ alta e atribuicao deterministica.
 * O event_id deve ser o MESMO usado no fbq('track','Lead',{},{eventID}) do Pixel.
 */
export function buildLeadEvent(
  tenant: Tenant,
  input: LeadInput,
  ctx: { ip?: string; ua?: string },
): Record<string, unknown> {
  const now = input.eventTime ?? new Date();
  const fbc =
    input.fbc || (input.fbclid ? `fb.1.${now.getTime()}.${input.fbclid}` : undefined);

  const userData: Record<string, unknown> = { country: sha256("br") };
  if (input.fbp) userData.fbp = input.fbp;
  if (fbc) userData.fbc = fbc;
  if (ctx.ip) userData.client_ip_address = ctx.ip;
  if (ctx.ua) userData.client_user_agent = ctx.ua;
  if (input.externalId) userData.external_id = sha256(input.externalId);

  const eventId =
    input.eventId ||
    `lead_${sha1short(`${tenant.id}|${fbc || input.fbp || Math.random()}|${now.getTime()}`)}`;

  return {
    event_name: "Lead",
    event_time: Math.floor(now.getTime() / 1000),
    action_source: "website",
    event_id: eventId,
    ...(input.eventSourceUrl ? { event_source_url: input.eventSourceUrl } : {}),
    user_data: userData,
    custom_data: { channel: "landing_page", target: "whatsapp_group" },
  };
}

/** POST para graph.facebook.com/{v}/{pixel}/events. Nunca lanca: retorna GraphResult. */
export async function sendToGraph(
  tenant: Tenant,
  events: unknown[],
  testCode?: string | null,
): Promise<GraphResult> {
  const pixelId = tenant.pixel_id || config.graph.fallbackPixelId;
  const token = tenant.capi_token || config.graph.fallbackToken;

  if (!pixelId || !token) {
    return { ok: false, status: 0, body: { error: "tenant sem pixel_id/capi_token" }, retryable: false };
  }

  const url =
    `https://graph.facebook.com/${config.graph.version}/${pixelId}/events` +
    `?access_token=${encodeURIComponent(token)}`;

  const payload: Record<string, unknown> = { data: events };
  const tc = testCode ?? tenant.test_event_code ?? config.graph.fallbackTestCode;
  if (tc) payload.test_event_code = tc;

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    return { ok: false, status: 0, body: { error: String(err) }, retryable: true };
  }

  const body = await res.json().catch(() => ({}));
  if (res.ok) return { ok: true, status: res.status, body, retryable: false };

  const code = Number((body as { error?: { code?: number } })?.error?.code);
  const permanent = [100, 190, 200, 803].includes(code); // token/param invalidos: nao adianta repetir
  const retryable = res.status >= 500 || res.status === 429 || (!permanent && res.status !== 400);
  return { ok: false, status: res.status, body, retryable };
}
