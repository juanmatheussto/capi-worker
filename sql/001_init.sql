create table if not exists tenants (
  id              text primary key,
  name            text not null,
  pixel_id        text not null,
  capi_token      text not null,
  webhook_secret  text not null,
  test_event_code text,
  event_name      text not null default 'JoinGroup',
  join_filter     text not null default 'all',   -- all | self_only (só quem entrou pelo link)
  lp_origin       text,                           -- Origin permitido no POST /lead (CORS). null = qualquer
  evo_base_url    text,                           -- Evolution API
  evo_api_key     text,
  evo_instance    text,
  active          boolean not null default true,
  created_at      timestamptz not null default now()
);

-- grupos que o tenant escolheu rastrear (allowlist + rótulo de campanha)
create table if not exists tenant_groups (
  tenant_id      text not null references tenants(id) on delete cascade,
  group_jid      text not null,
  group_name     text,
  campaign_label text,
  active         boolean not null default true,
  created_at     timestamptz not null default now(),
  primary key (tenant_id, group_jid)
);

-- snapshot de membros (backfill no enroll + manutenção via webhook). NÃO vai pra fila do CAPI.
create table if not exists group_members (
  tenant_id   text not null references tenants(id) on delete cascade,
  group_jid   text not null,
  phone_e164  text not null,
  is_admin    boolean not null default false,
  source      text not null default 'live',   -- backfill | live
  first_seen  timestamptz not null default now(),
  last_seen   timestamptz not null default now(),
  present     boolean not null default true,
  primary key (tenant_id, group_jid, phone_e164)
);

-- log de entradas/saídas para o dashboard (entrada E saida). Independente do envio ao CAPI.
create table if not exists membership_log (
  id             bigserial primary key,
  tenant_id      text not null references tenants(id) on delete cascade,
  group_jid      text not null,
  group_name     text,
  campaign_label text,
  action         text not null,                 -- entrada | saida
  phone_e164     text,
  actor          text,                          -- quem adicionou/removeu
  self_action    boolean,
  occurred_at    timestamptz not null default now()
);
create index if not exists membership_log_idx
  on membership_log (tenant_id, group_jid, occurred_at desc);

-- encurtador de links (o link que vai junto com a oferta no grupo)
create table if not exists links (
  id              bigserial primary key,
  tenant_id       text not null references tenants(id) on delete cascade,
  slug            text not null unique,
  destination_url text not null,
  campaign_label  text,
  message         text,                          -- template da mensagem da oferta
  active          boolean not null default true,
  created_at      timestamptz not null default now()
);

create table if not exists link_clicks (
  id         bigserial primary key,
  link_id    bigint not null references links(id) on delete cascade,
  clicked_at timestamptz not null default now(),
  ip         text,
  ua         text,
  referer    text,
  is_bot     boolean not null default false
);
create index if not exists link_clicks_idx on link_clicks (link_id, clicked_at desc);

create table if not exists ctwa_leads (
  id          bigserial primary key,
  tenant_id   text not null references tenants(id) on delete cascade,
  phone_e164  text not null,
  ctwa_clid   text not null,
  source_id   text,
  created_at  timestamptz not null default now()
);
create index if not exists ctwa_leads_lookup
  on ctwa_leads (tenant_id, phone_e164, created_at desc);

-- evento Lead disparado no clique do botão da landing page (browser + CAPI)
create table if not exists lead_events (
  id               bigserial primary key,
  tenant_id        text not null references tenants(id) on delete cascade,
  event_id         text not null,
  fbp              text,
  fbc              text,
  external_id      text,
  event_source_url text,
  client_ip        text,
  client_ua        text,
  event_time       timestamptz not null,
  status           text not null default 'pending',
  attempts         int not null default 0,
  graph_response   jsonb,
  error            text,
  received_at      timestamptz not null default now(),
  sent_at          timestamptz,
  unique (tenant_id, event_id)
);
create index if not exists lead_events_status
  on lead_events (tenant_id, status, received_at desc);

create table if not exists capi_events (
  id             bigserial primary key,
  tenant_id      text not null references tenants(id) on delete cascade,
  event_id       text not null,
  event_name     text not null,
  action         text not null,                      -- entrada | saida
  phone_e164     text,
  display_name   text,
  group_jid      text,
  group_name     text,
  added_by       text,
  campaign_label text,
  event_time     timestamptz not null,
  status         text not null default 'pending',    -- pending | sent | skipped | failed
  attempts       int not null default 0,
  matched_ctwa   boolean not null default false,
  graph_response jsonb,
  error          text,
  received_at    timestamptz not null default now(),
  sent_at        timestamptz,
  unique (tenant_id, event_name, event_id)
);
create index if not exists capi_events_status
  on capi_events (tenant_id, status, received_at desc);

-- migrações leves para bancos que já rodaram uma versão anterior
alter table tenants     add column if not exists join_filter text not null default 'all';
alter table tenants     add column if not exists lp_origin text;
alter table tenants     add column if not exists evo_base_url text;
alter table tenants     add column if not exists evo_api_key text;
alter table tenants     add column if not exists evo_instance text;
alter table capi_events add column if not exists campaign_label text;
alter table links       add column if not exists message text;
