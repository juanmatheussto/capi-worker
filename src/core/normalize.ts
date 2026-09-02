import { createHash } from "node:crypto";
import type { EventAction } from "../types.js";

/** SHA-256 do valor normalizado (trim + lowercase). Vazio -> undefined. */
export function sha256(v?: string | null): string | undefined {
  if (v === undefined || v === null) return undefined;
  const s = String(v).trim().toLowerCase();
  if (!s) return undefined;
  return createHash("sha256").update(s).digest("hex");
}

export function onlyDigits(v?: string | null): string {
  return String(v ?? "").replace(/\D/g, "");
}

/** Normaliza para E.164. Numero local BR (10/11 digitos) recebe +55. */
export function toE164(raw?: string | null, defaultDdi = "55"): string | undefined {
  let d = onlyDigits(raw).replace(/^0+/, "");
  if (!d) return undefined;
  if (d.length === 10 || d.length === 11) d = defaultDdi + d;
  if (d.length < 11 || d.length > 15) return undefined;
  return "+" + d;
}

/** Extrai telefone de um jid do WhatsApp: "5562...@s.whatsapp.net" ou "...:12@..." */
export function jidToE164(jid?: string | null): string | undefined {
  if (!jid) return undefined;
  const left = String(jid).split("@")[0].split(":")[0];
  return toE164(left);
}

export function firstName(name?: string | null): string | undefined {
  const n = String(name ?? "").trim();
  if (!n) return undefined;
  return n.split(/\s+/)[0];
}

export function lastName(name?: string | null): string | undefined {
  const parts = String(name ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return undefined;
  return parts.slice(1).join(" ");
}

export function sha1short(v: string, len = 20): string {
  return createHash("sha1").update(v).digest("hex").slice(0, len);
}

// DDD -> UF. Proxy fraco: é a região de habilitação do chip, não a residência.
const DDD_UF: Record<string, string> = {
  "11": "sp", "12": "sp", "13": "sp", "14": "sp", "15": "sp", "16": "sp", "17": "sp", "18": "sp", "19": "sp",
  "21": "rj", "22": "rj", "24": "rj",
  "27": "es", "28": "es",
  "31": "mg", "32": "mg", "33": "mg", "34": "mg", "35": "mg", "37": "mg", "38": "mg",
  "41": "pr", "42": "pr", "43": "pr", "44": "pr", "45": "pr", "46": "pr",
  "47": "sc", "48": "sc", "49": "sc",
  "51": "rs", "53": "rs", "54": "rs", "55": "rs",
  "61": "df", "62": "go", "64": "go", "63": "to", "65": "mt", "66": "mt", "67": "ms",
  "68": "ac", "69": "ro",
  "71": "ba", "73": "ba", "74": "ba", "75": "ba", "77": "ba", "79": "se",
  "81": "pe", "87": "pe", "82": "al", "83": "pb", "84": "rn", "85": "ce", "88": "ce", "86": "pi", "89": "pi",
  "91": "pa", "93": "pa", "94": "pa", "92": "am", "97": "am", "98": "ma", "99": "ma", "95": "rr", "96": "ap",
};

/** UF estimada a partir do DDD de um telefone BR (+55). undefined se não-BR ou DDD inválido. */
export function ufFromPhone(phoneE164?: string | null): string | undefined {
  const d = onlyDigits(phoneE164);
  if (!d.startsWith("55") || d.length < 4) return undefined;
  return DDD_UF[d.slice(2, 4)];
}

/**
 * event_id deterministico por (tenant, acao, pessoa, dia).
 * Reprocessar o mesmo join gera o mesmo id -> dedupe no banco e no Meta.
 */
export function buildEventId(
  tenantId: string,
  ev: { action: EventAction | string; phoneE164?: string; displayName?: string; eventTime: Date },
): string {
  const day = ev.eventTime.toISOString().slice(0, 10);
  const who = ev.phoneE164 || (ev.displayName ?? "").trim().toLowerCase();
  return "wajoin_" + sha1short(`${tenantId}|${ev.action}|${who}|${day}`);
}
