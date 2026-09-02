import { describe, it, expect } from "vitest";
import { toE164, jidToE164, firstName, lastName, ufFromPhone, buildEventId, sha256 } from "../src/core/normalize.js";

describe("toE164", () => {
  it("assume +55 em numero local BR de 11 digitos", () => {
    expect(toE164("(62) 98888-7777")).toBe("+5562988887777");
  });
  it("mantem numero que ja tem DDI", () => {
    expect(toE164("+55 62 98888 7777")).toBe("+5562988887777");
  });
  it("descarta 0 a esquerda", () => {
    expect(toE164("062988887777")).toBe("+5562988887777");
  });
  it("rejeita lixo e vazio", () => {
    expect(toE164("abc")).toBeUndefined();
    expect(toE164("")).toBeUndefined();
    expect(toE164("123")).toBeUndefined();
  });
});

describe("jidToE164", () => {
  it("extrai telefone do jid", () => {
    expect(jidToE164("5562988887777@s.whatsapp.net")).toBe("+5562988887777");
  });
  it("ignora sufixo de device", () => {
    expect(jidToE164("5562988887777:12@s.whatsapp.net")).toBe("+5562988887777");
  });
});

describe("firstName / lastName", () => {
  it("separa primeiro e resto", () => {
    expect(firstName("  Fulano  Silva Santos ")).toBe("Fulano");
    expect(lastName("  Fulano  Silva Santos ")).toBe("Silva Santos");
  });
  it("nome unico nao tem sobrenome", () => {
    expect(lastName("Fulano")).toBeUndefined();
    expect(firstName("")).toBeUndefined();
  });
});

describe("buildEventId", () => {
  it("e deterministico dentro do mesmo dia", () => {
    const a = buildEventId("t1", {
      action: "entrada",
      phoneE164: "+5562988887777",
      eventTime: new Date("2026-09-01T02:00:00Z"),
    });
    const b = buildEventId("t1", {
      action: "entrada",
      phoneE164: "+5562988887777",
      eventTime: new Date("2026-09-01T22:00:00Z"),
    });
    expect(a).toBe(b);
    expect(a.startsWith("wajoin_")).toBe(true);
  });
  it("muda com tenant diferente", () => {
    const base = { action: "entrada" as const, phoneE164: "+5562988887777", eventTime: new Date("2026-09-01T02:00:00Z") };
    expect(buildEventId("t1", base)).not.toBe(buildEventId("t2", base));
  });
});

describe("ufFromPhone", () => {
  it("deriva UF do DDD", () => {
    expect(ufFromPhone("+5562988887777")).toBe("go");
    expect(ufFromPhone("+5511988887777")).toBe("sp");
    expect(ufFromPhone("+5581988887777")).toBe("pe");
  });
  it("ignora não-BR e DDD inválido", () => {
    expect(ufFromPhone("+13025551234")).toBeUndefined();
    expect(ufFromPhone("+5520988887777")).toBeUndefined();
  });
});

describe("sha256", () => {
  it("normaliza trim + lowercase", () => {
    expect(sha256("  BR ")).toBe(sha256("br"));
  });
  it("vazio -> undefined", () => {
    expect(sha256("")).toBeUndefined();
    expect(sha256(null)).toBeUndefined();
  });
});
