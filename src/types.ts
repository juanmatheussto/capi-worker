export type EventAction = "entrada" | "saida";
export type EventStatus = "pending" | "sent" | "skipped" | "failed";
export type JoinFilter = "all" | "self_only";

export interface Tenant {
  id: string;
  name: string;
  pixel_id: string;
  capi_token: string;
  webhook_secret: string;
  test_event_code: string | null;
  event_name: string;
  join_filter: JoinFilter;
  lp_origin: string | null;
  evo_base_url: string | null;
  evo_api_key: string | null;
  evo_instance: string | null;
  active: boolean;
}

export interface TenantGroup {
  tenant_id: string;
  group_jid: string;
  group_name: string | null;
  campaign_label: string | null;
  active: boolean;
}

export interface NormalizedEvent {
  action: EventAction;
  phoneE164?: string;
  displayName?: string;
  groupJid?: string;
  groupName?: string;
  addedBy?: string;
  campaignLabel?: string;
  eventTime: Date;
}

export interface CapiEventRow {
  id: string;
  tenant_id: string;
  event_id: string;
  event_name: string;
  action: EventAction;
  phone_e164: string | null;
  display_name: string | null;
  group_jid: string | null;
  group_name: string | null;
  added_by: string | null;
  campaign_label: string | null;
  event_time: string;
  status: EventStatus;
  attempts: number;
  matched_ctwa: boolean;
}

export interface LeadInput {
  eventId?: string;
  fbp?: string;
  fbc?: string;
  fbclid?: string;
  externalId?: string;
  eventSourceUrl?: string;
  eventTime?: Date;
}

export interface LeadEventRow {
  id: string;
  tenant_id: string;
  event_id: string;
  fbp: string | null;
  fbc: string | null;
  external_id: string | null;
  event_source_url: string | null;
  client_ip: string | null;
  client_ua: string | null;
  event_time: string;
  status: EventStatus;
  attempts: number;
}

export type CapiJob =
  | { kind: "join"; eventDbId: string }
  | { kind: "lead"; leadDbId: string };
