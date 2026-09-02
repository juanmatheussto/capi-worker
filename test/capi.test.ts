import { describe, it, expect } from "vitest";
import { buildCapiEvent, buildLeadEvent } from "../src/core/capi.js";
import type { NormalizedEvent, Tenant } from "../src/types.js";

const tenant: Tenant = {
  id: "t1",
  name: "T1",
  pixel_id: "123456",
  capi_token: "tok",
  webhook_secret: "s",
  test_event_code: null,
  event_name: "JoinGroup",
  join_filter: "all",
  lp_origin: null,
  evo_base_url: null,
  evo_api_key: null,
  evo_instance: null,
  active: true,
};

describe("buildCapiEvent", () => {
  it("hasheia telefone/nome/sobrenome e usa system_generated sem CTWA", () => {
    const ev: NormalizedEvent = {
      action: "entrada",
      phoneE164: "+5562988887777",
      displayName: "Fulano Silva Santos",
      groupName: "Comunidade X",
      campaignLabel: "adset-frio-01",
      eventTime: new Date("2026-09-01T12:00:00Z"),
    };
    const e = buildCapiEvent(tenant, ev, "wajoin_abc") as any;

    expect(e.event_name).toBe("JoinGroup");
    expect(e.action_source).toBe("system_generated");
    expect(e.event_id).toBe("wajoin_abc");
    expect(e.event_time).toBe(Math.floor(ev.eventTime.getTime() / 1000));
    expect(e.user_data.ph).toMatch(/^[a-f0-9]{64}$/);
    expect(e.user_data.fn).toMatch(/^[a-f0-9]{64}$/);
    expect(e.user_data.ln).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(e)).not.toContain("62988887777");
    expect(e.custom_data.group_name).toBe("Comunidade X");
    expect(e.custom_data.campaign_label).toBe("adset-frio-01");
  });

  it("com ctwaClid vira business_messaging e monta fbc", () => {
    const ev: NormalizedEvent = {
      action: "entrada",
      phoneE164: "+5562988887777",
      eventTime: new Date("2026-09-01T12:00:00Z"),
    };
    const e = buildCapiEvent(tenant, ev, "id1", { ctwaClid: "ARxyz789" }) as any;

    expect(e.action_source).toBe("business_messaging");
    expect(e.user_data.fbc).toBe(`fb.1.${ev.eventTime.getTime()}.ARxyz789`);
  });

  it("sem telefone ainda envia com fn/country", () => {
    const ev: NormalizedEvent = {
      action: "entrada",
      displayName: "Beltrano",
      eventTime: new Date("2026-09-01T12:00:00Z"),
    };
    const e = buildCapiEvent(tenant, ev, "id2") as any;
    expect(e.user_data.ph).toBeUndefined();
    expect(e.user_data.ln).toBeUndefined();
    expect(e.user_data.fn).toMatch(/^[a-f0-9]{64}$/);
    expect(e.user_data.country).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("buildLeadEvent", () => {
  it("website + fbp/fbc/ip/ua sem hash, external_id com hash", () => {
    const e = buildLeadEvent(
      tenant,
      {
        eventId: "lead_abc",
        fbp: "fb.1.1700000000000.123",
        fbclid: "AR_xyz",
        externalId: "u-42",
        eventSourceUrl: "https://lp.exemplo.com/entrar?fbclid=AR_xyz",
        eventTime: new Date("2026-09-01T12:00:00Z"),
      },
      { ip: "201.1.2.3", ua: "Mozilla/5.0" },
    ) as any;

    expect(e.event_name).toBe("Lead");
    expect(e.action_source).toBe("website");
    expect(e.event_id).toBe("lead_abc");
    expect(e.event_source_url).toContain("lp.exemplo.com");
    expect(e.user_data.fbp).toBe("fb.1.1700000000000.123");
    expect(e.user_data.fbc).toBe(`fb.1.${new Date("2026-09-01T12:00:00Z").getTime()}.AR_xyz`);
    expect(e.user_data.client_ip_address).toBe("201.1.2.3");
    expect(e.user_data.client_user_agent).toBe("Mozilla/5.0");
    expect(e.user_data.external_id).toMatch(/^[a-f0-9]{64}$/);
  });

  it("gera event_id se nao vier (mas ideal e vir do Pixel)", () => {
    const e = buildLeadEvent(tenant, { fbp: "fb.1.1.1" }, {}) as any;
    expect(String(e.event_id).startsWith("lead_")).toBe(true);
  });
});
