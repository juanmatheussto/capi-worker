import type { Tenant } from "../types.js";

interface EvoCfg {
  baseUrl: string;
  apiKey: string;
  instance: string;
}

export function evoConfig(t: Tenant): EvoCfg | undefined {
  if (!t.evo_base_url || !t.evo_api_key || !t.evo_instance) return undefined;
  return {
    baseUrl: t.evo_base_url.replace(/\/+$/, ""),
    apiKey: t.evo_api_key,
    instance: t.evo_instance,
  };
}

async function evoRaw(
  baseUrl: string,
  apiKey: string,
  path: string,
  init?: RequestInit,
): Promise<{ ok: boolean; status: number; body: any }> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, "")}${path}`, {
      ...init,
      headers: { apikey: apiKey, "content-type": "application/json", ...(init?.headers ?? {}) },
    });
    const body = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, body };
  } catch (err) {
    return { ok: false, status: 0, body: { error: String(err) } };
  }
}

const evo = (c: EvoCfg, path: string, init?: RequestInit) =>
  evoRaw(c.baseUrl, c.apiKey, path, init);

/** Cria uma instância nova na Evolution. Precisa da apikey GLOBAL do servidor Evolution. */
export async function createInstance(baseUrl: string, globalApiKey: string, instanceName: string) {
  const r = await evoRaw(baseUrl, globalApiKey, "/instance/create", {
    method: "POST",
    body: JSON.stringify({ instanceName, integration: "WHATSAPP-BAILEYS", qrcode: true }),
  });
  const b = r.body ?? {};
  const instanceToken: string =
    b.hash?.apikey ??
    (typeof b.hash === "string" ? b.hash : undefined) ??
    b.instance?.apikey ??
    globalApiKey;
  const qr: string | null = b.qrcode?.base64 ?? b.base64 ?? null;
  return { ok: r.ok, status: r.status, instanceToken, qr, raw: b };
}

/** Lê o webhook configurado na instância. */
export async function getWebhook(t: Tenant) {
  const c = evoConfig(t);
  if (!c) return { configured: false as const };
  const r = await evo(c, `/webhook/find/${c.instance}`);
  return { configured: true as const, ok: r.ok, status: r.status, webhook: r.body };
}

/** Configura o webhook da instância (tenta formato v2 aninhado, cai pro flat). */
export async function setWebhook(
  baseUrl: string,
  apiKey: string,
  instanceName: string,
  url: string,
  secret: string,
  events: string[] = ["GROUP_PARTICIPANTS_UPDATE", "MESSAGES_UPSERT"],
) {
  let r = await evoRaw(baseUrl, apiKey, `/webhook/set/${instanceName}`, {
    method: "POST",
    body: JSON.stringify({
      webhook: {
        enabled: true,
        url,
        headers: { "x-webhook-secret": secret },
        byEvents: false,
        base64: false,
        events,
      },
    }),
  });
  if (!r.ok) {
    r = await evoRaw(baseUrl, apiKey, `/webhook/set/${instanceName}`, {
      method: "POST",
      body: JSON.stringify({ enabled: true, url, events, webhook_by_events: false }),
    });
  }
  return { ok: r.ok, status: r.status, raw: r.body };
}

export async function connectionState(t: Tenant) {
  const c = evoConfig(t);
  if (!c) return { configured: false as const };
  const r = await evo(c, `/instance/connectionState/${c.instance}`);
  const state = r.body?.instance?.state ?? r.body?.state ?? "unknown";
  return { configured: true as const, ok: r.ok, state };
}

/** Retorna o QR (base64 data-uri) enquanto a instancia nao esta conectada. */
export async function connectQr(t: Tenant) {
  const c = evoConfig(t);
  if (!c) return { configured: false as const };
  const r = await evo(c, `/instance/connect/${c.instance}`);
  const b = r.body ?? {};
  return {
    configured: true as const,
    ok: r.ok,
    base64: b.base64 ?? b.qrcode?.base64 ?? null,
    code: b.code ?? b.qrcode?.code ?? null,
    pairingCode: b.pairingCode ?? null,
  };
}

export async function fetchAllGroups(t: Tenant) {
  const c = evoConfig(t);
  if (!c) return { configured: false as const, groups: [] as GroupInfo[] };
  const r = await evo(c, `/group/fetchAllGroups/${c.instance}?getParticipants=false`);
  const arr: any[] = Array.isArray(r.body) ? r.body : (r.body?.groups ?? []);
  const groups: GroupInfo[] = arr.map((g) => ({
    jid: g.id ?? g.jid,
    name: g.subject ?? g.name ?? "",
    size: g.size ?? g.participants?.length ?? null,
  }));
  return { configured: true as const, ok: r.ok, groups };
}

export async function fetchParticipants(t: Tenant, groupJid: string) {
  const c = evoConfig(t);
  if (!c) return { configured: false as const, participants: [] as ParticipantInfo[] };

  // 1) endpoint dedicado
  const r = await evo(
    c,
    `/group/participants/${c.instance}?groupJid=${encodeURIComponent(groupJid)}`,
  );
  let arr: any[] = r.body?.participants ?? (Array.isArray(r.body) ? r.body : []);

  // 2) fallback: metadata completo (quando o dedicado devolve só admins/parcial)
  if (arr.length < 6) {
    const g = await evo(c, `/group/fetchAllGroups/${c.instance}?getParticipants=true`);
    const list: any[] = Array.isArray(g.body) ? g.body : (g.body?.groups ?? []);
    const hit = list.find((x) => (x.id ?? x.jid) === groupJid);
    if (Array.isArray(hit?.participants) && hit.participants.length > arr.length) {
      arr = hit.participants;
    }
  }

  const participants: ParticipantInfo[] = arr
    .map((p) => ({
      jid: p.id ?? p.jid,
      admin: Boolean(p.admin || p.isAdmin || p.isSuperAdmin),
    }))
    .filter((p) => p.jid);
  return { configured: true as const, ok: r.ok, participants };
}

export interface GroupInfo {
  jid: string;
  name: string;
  size: number | null;
}
export interface ParticipantInfo {
  jid: string;
  admin: boolean;
}
