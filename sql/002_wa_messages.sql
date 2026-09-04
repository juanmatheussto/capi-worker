-- Mensagens do WhatsApp Cloud API (webhook oficial da Meta).
-- Fonte independente do Evolution: recebe em paralelo ao BSP (Kommo),
-- que continua inscrito na mesma WABA.

create table if not exists wa_messages (
  id              bigserial primary key,
  tenant_id       text not null references tenants(id) on delete cascade,
  wamid           text not null,
  waba_id         text,
  phone_number_id text,
  direction       text not null,              -- in | out
  contact_phone   text,                       -- E164 do cliente (nunca o número da empresa)
  contact_name    text,
  msg_type        text,                       -- text | image | audio | button | interactive | ...
  body            text,                       -- texto extraído quando existe
  ctwa_clid       text,                       -- clique de anúncio (referral.ctwa_clid)
  referral        jsonb,
  status          text,                       -- sent | delivered | read | failed
  status_at       timestamptz,
  msg_ts          timestamptz not null,
  payload         jsonb not null,
  created_at      timestamptz not null default now(),
  unique (tenant_id, wamid)
);

create index if not exists wa_messages_contact
  on wa_messages (tenant_id, contact_phone, msg_ts desc);
create index if not exists wa_messages_ts
  on wa_messages (tenant_id, msg_ts desc);

-- payload cru de cada entrega, para reprocessar sem depender do parser
create table if not exists wa_webhook_raw (
  id          bigserial primary key,
  tenant_id   text not null references tenants(id) on delete cascade,
  payload     jsonb not null,
  received_at timestamptz not null default now()
);
