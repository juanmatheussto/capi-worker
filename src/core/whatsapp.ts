import { createHmac, timingSafeEqual } from "node:crypto";
import { toE164 } from "./normalize.js";

/** Mensagem já normalizada a partir do payload da Cloud API. */
export type WaMessage = {
  wamid: string;
  wabaId?: string;
  phoneNumberId?: string;
  direction: "in" | "out";
  contactPhone?: string;
  contactName?: string;
  msgType?: string;
  body?: string;
  ctwaClid?: string;
  referral?: Record<string, unknown>;
  msgTs: Date;
  payload: Record<string, unknown>;
};

export type WaStatus = {
  wamid: string;
  status: string;
  statusAt: Date;
  /** telefone do cliente que recebeu — e a unica pista de que houve resposta */
  recipientPhone?: string;
  phoneNumberId?: string;
};

/**
 * Confere o X-Hub-Signature-256 sobre o corpo cru.
 * A Meta assina com o App Secret, não com um segredo por tenant.
 */
export function verifySignature(raw: Buffer | string, header: string, appSecret: string): boolean {
  if (!appSecret) return false;
  const expected = "sha256=" + createHmac("sha256", appSecret).update(raw).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(header ?? "");
  return a.length === b.length && timingSafeEqual(a, b);
}

function tsToDate(ts: unknown): Date {
  const n = Number(ts);
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000) : new Date();
}

/** Extrai o texto legível de qualquer tipo de mensagem que carregue um. */
function extractBody(m: Record<string, any>): string | undefined {
  const t = String(m.type ?? "");
  switch (t) {
    case "text":
      return m.text?.body;
    case "button":
      return m.button?.text;
    case "interactive":
      return m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title;
    case "image":
    case "video":
    case "document":
    case "audio":
      return m[t]?.caption;
    case "reaction":
      return m.reaction?.emoji;
    case "location":
      return m.location?.name ?? m.location?.address;
    default:
      return undefined;
  }
}

/**
 * Achata o envelope do webhook (entry[].changes[].value) em mensagens e status.
 * Mensagens recebidas trazem `messages[]`; confirmações de entrega vêm em `statuses[]`.
 */
export function parseWebhook(body: Record<string, any>): {
  messages: WaMessage[];
  statuses: WaStatus[];
} {
  const messages: WaMessage[] = [];
  const statuses: WaStatus[] = [];

  for (const entry of body?.entry ?? []) {
    const wabaId: string | undefined = entry?.id;

    for (const change of entry?.changes ?? []) {
      if (change?.field !== "messages") continue;
      const value = change?.value ?? {};
      const phoneNumberId: string | undefined = value?.metadata?.phone_number_id;
      const businessPhone: string | undefined = value?.metadata?.display_phone_number;

      const names = new Map<string, string>();
      for (const c of value?.contacts ?? []) {
        if (c?.wa_id) names.set(String(c.wa_id), c?.profile?.name ?? "");
      }

      for (const m of value?.messages ?? []) {
        // `from` é o cliente em mensagens recebidas; em ecos de envio é o número da empresa
        const from = String(m?.from ?? "");
        const outgoing = Boolean(businessPhone) && toE164(from) === toE164(businessPhone!);
        const counterpart = outgoing ? String(m?.to ?? "") : from;

        messages.push({
          wamid: String(m?.id ?? ""),
          wabaId,
          phoneNumberId,
          direction: outgoing ? "out" : "in",
          contactPhone: toE164(counterpart),
          contactName: names.get(counterpart) || undefined,
          msgType: m?.type,
          body: extractBody(m),
          ctwaClid: m?.referral?.ctwa_clid,
          referral: m?.referral,
          msgTs: tsToDate(m?.timestamp),
          payload: m,
        });
      }

      // A Cloud API nao faz eco de mensagens enviadas: o que a Kommo responde
      // nunca chega como `messages`. So o status chega — e e dele que sai a
      // prova de que houve resposta, e quando.
      for (const s of value?.statuses ?? []) {
        statuses.push({
          wamid: String(s?.id ?? ""),
          status: String(s?.status ?? ""),
          statusAt: tsToDate(s?.timestamp),
          recipientPhone: s?.recipient_id ? toE164(String(s.recipient_id)) : undefined,
          phoneNumberId,
        });
      }
    }
  }

  return {
    messages: messages.filter((m) => m.wamid),
    statuses: statuses.filter((s) => s.wamid),
  };
}
