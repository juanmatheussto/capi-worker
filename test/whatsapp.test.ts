import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { parseWebhook, verifySignature } from "../src/core/whatsapp.js";

const inbound = {
  object: "whatsapp_business_account",
  entry: [
    {
      id: "822574027520702",
      changes: [
        {
          field: "messages",
          value: {
            messaging_product: "whatsapp",
            metadata: { display_phone_number: "5511913387523", phone_number_id: "968454583025984" },
            contacts: [{ profile: { name: "Maria" }, wa_id: "5551995667447" }],
            messages: [
              {
                from: "5551995667447",
                id: "wamid.AAA",
                timestamp: "1788350000",
                type: "text",
                text: { body: "Quero a oferta de Lisboa" },
                referral: { ctwa_clid: "CLID123", source_id: "6543210" },
              },
            ],
          },
        },
      ],
    },
  ],
};

describe("parseWebhook", () => {
  it("normaliza mensagem recebida e extrai o ctwa_clid", () => {
    const { messages, statuses } = parseWebhook(inbound);
    expect(statuses).toHaveLength(0);
    expect(messages).toHaveLength(1);
    const m = messages[0];
    expect(m.direction).toBe("in");
    expect(m.contactPhone).toBe("+5551995667447");
    expect(m.contactName).toBe("Maria");
    expect(m.body).toBe("Quero a oferta de Lisboa");
    expect(m.ctwaClid).toBe("CLID123");
    expect(m.wabaId).toBe("822574027520702");
  });

  it("marca como saida quando o remetente e o proprio numero da empresa", () => {
    const echo = structuredClone(inbound) as any;
    const v = echo.entry[0].changes[0].value;
    v.messages[0].from = "5511913387523";
    v.messages[0].to = "5551995667447";
    const { messages } = parseWebhook(echo);
    expect(messages[0].direction).toBe("out");
    expect(messages[0].contactPhone).toBe("+5551995667447");
  });

  it("extrai recipient_id do status — e dele que sai a prova de resposta", () => {
    const st = {
      entry: [{ id: "822574027520702", changes: [{ field: "messages", value: {
        metadata: { display_phone_number: "5511913387523", phone_number_id: "968454583025984" },
        statuses: [{ id: "wamid.OUT", status: "sent", timestamp: "1788350200",
                     recipient_id: "5511964191406" }],
      } }] }],
    };
    const { statuses } = parseWebhook(st);
    expect(statuses[0].recipientPhone).toBe("+5511964191406");
    expect(statuses[0].phoneNumberId).toBe("968454583025984");
    expect(statuses[0].statusAt.getTime()).toBe(1788350200 * 1000);
  });

  it("le confirmacoes de entrega", () => {
    const st = {
      entry: [
        {
          id: "822574027520702",
          changes: [
            {
              field: "messages",
              value: { statuses: [{ id: "wamid.AAA", status: "read", timestamp: "1788350100" }] },
            },
          ],
        },
      ],
    };
    const { messages, statuses } = parseWebhook(st);
    expect(messages).toHaveLength(0);
    expect(statuses[0]).toMatchObject({ wamid: "wamid.AAA", status: "read" });
  });

  it("ignora envelope vazio ou de outro campo", () => {
    expect(parseWebhook({}).messages).toHaveLength(0);
    expect(
      parseWebhook({ entry: [{ changes: [{ field: "account_update", value: {} }] }] }).messages,
    ).toHaveLength(0);
  });
});

describe("verifySignature", () => {
  const secret = "appsecret";
  const raw = Buffer.from(JSON.stringify(inbound));
  const good = "sha256=" + createHmac("sha256", secret).update(raw).digest("hex");

  it("aceita assinatura correta", () => {
    expect(verifySignature(raw, good, secret)).toBe(true);
  });

  it("rejeita assinatura errada, vazia ou sem app secret", () => {
    expect(verifySignature(raw, "sha256=deadbeef", secret)).toBe(false);
    expect(verifySignature(raw, "", secret)).toBe(false);
    expect(verifySignature(raw, good, "")).toBe(false);
  });

  it("rejeita corpo alterado", () => {
    expect(verifySignature(Buffer.from(raw.toString() + " "), good, secret)).toBe(false);
  });
});
