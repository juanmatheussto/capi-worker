# capi-worker — CAPI as a service (fonte: Evolution API)

Recebe a **entrada de pessoas em grupo/comunidade** via webhook do Evolution API,
pega o telefone, hasheia, deduplica e envia um evento `JoinGroup` pro
**Meta Conversions API** — em fila, com retry e log.

O Meta faz o match do telefone hasheado contra a base dele, vê se essa pessoa
clicou/viu seu anúncio nos últimos 7 dias e **atribui + otimiza a campanha para
quem entra** (não para quem clica). É o mesmo mecanismo de conversões
offline / upload de CRM.

```
anúncio → landing page → botão → pessoa entra no grupo
      │
      ▼  Evolution API  ──webhook GROUP_PARTICIPANTS_UPDATE──►  /webhooks/evolution/:tenantId
                                                                     │ enfileira
                                                                     ▼
                                                      Redis/BullMQ ──► worker ──► Meta CAPI
                                                                                 JoinGroup + sha256(phone)
```

## Por que não precisa de fbclid

A atribuição acontece **do lado do Meta**, por identidade (telefone → usuário →
clique no anúncio). Você não carrega nada do navegador até o WhatsApp.

- **Match rate** telefone-only no Brasil ~50–70%. Some `fn`/`ln`/`country` (o
  worker já manda) para subir. → a contagem no Gerenciador fica **subcontada**;
  seu CPA real é melhor que o exibido.
- **Volume**: ~50 `JoinGroup` casados por semana por conjunto de anúncios para
  sair do aprendizado.
- **Janela**: o join precisa chegar em até 7 dias do clique (e o evento CAPI em
  até 7 dias do join — tempo real via Evolution resolve).
- **Join orgânico** (amigo convidou, outro tráfego) também gera evento; o Meta
  não acha clique e simplesmente não conta — não infla nada.

## Stack

Node 20 · TypeScript · Fastify · BullMQ + Redis · Postgres (`pg`).

## Subir (Docker)

```bash
cp .env.example .env      # ajuste ADMIN_API_KEY
docker compose up --build
```

`api` em `http://localhost:8080`; `worker` em processo separado. O schema
(`sql/001_init.sql`) é aplicado no boot.

## Dashboard

`http://localhost:8080/` — página única servida pela própria API. Preencha
**tenant id** + **admin api key** (ficam no `localStorage`). Mostra:

- **Meta — Conversions API**: painel para salvar `Pixel ID` + `token` + rótulo do
  evento; badge de estado e contadores (enviados / fila / falhou / pulados).
- **Conexão WhatsApp**: estado da instância do Evolution + **QR code** para
  parear (auto-poll até conectar). Painel "configurar instância" salva
  `baseUrl` / `apikey` / `instance`.
- **Grupos**: botão *Descobrir grupos* lista todos os grupos da instância; você
  marca quais rastrear (rótulo de campanha opcional, backfill de membros
  opcional). Cards por grupo: membros, `+entradas` / `-saídas` no período,
  sparkline.
- **Links da oferta**: cria o link encurtado que vai junto com a oferta
  (`/r/<slug>`), mostra cliques total / 7d / série. O bot de preview do
  WhatsApp é detectado e **não conta**.

Sem Docker: `npm install && npm run build`, depois `node dist/server.js` e
`node dist/worker.js` (precisa de Postgres e Redis nas URLs do `.env`).

## Passo a passo

### 1. Cadastrar o tenant

```bash
curl -X POST http://localhost:8080/tenants \
  -H "x-api-key: $ADMIN_API_KEY" -H "content-type: application/json" \
  -d '{
    "id": "voll",
    "name": "VOLL Pilates",
    "pixelId": "630203745608256",
    "capiToken": "EAAG...",
    "webhookSecret": "um-segredo-forte",
    "testEventCode": "TEST12345",
    "eventName": "JoinGroup",
    "joinFilter": "all"
  }'
```

- `joinFilter: "all"` → conta quem entrou pelo link **e** quem foi adicionado por
  admin. `"self_only"` → só quem entrou sozinho (pelo link de convite).

**Onde ficam as credenciais do Meta:** `pixelId` + `capiToken` são do **tenant**
(tabela `tenants`, colunas `pixel_id` / `capi_token`). Depois de criado, edite só
o Meta pelo dashboard (painel "Meta — Conversions API") ou via API:

```bash
curl -X POST http://localhost:8080/tenants/voll/meta \
  -H "x-api-key: $ADMIN_API_KEY" -H "content-type: application/json" \
  -d '{ "pixelId": "630203745608256", "capiToken": "EAAG...", "testEventCode": "", "eventName": "JoinGroup" }'
```

- `pixelId` = ID do dataset/pixel no Gerenciador de Eventos.
- `capiToken` = token gerado em Gerenciador de Eventos → Configurações → Conversions API.
- `testEventCode` vazio = produção; preenchido = eventos aparecem em "Testar eventos".
- Fallback: se o tenant não tiver `pixel_id`/`capi_token`, o worker usa
  `META_PIXEL_ID` / `META_CAPI_TOKEN` do `.env`.

### 2. (opcional) Allowlist de grupos + rótulo de campanha

A instância do Evolution manda eventos de **todos** os grupos em que está. Se
quiser filtrar e/ou rotular por campanha:

```bash
curl -X POST http://localhost:8080/tenants/voll/groups \
  -H "x-api-key: $ADMIN_API_KEY" -H "content-type: application/json" \
  -d '{
    "groupJid": "120363000000000000@g.us",
    "groupName": "Alerta de Voos - Geral",
    "campaignLabel": "adset-frio-brasil"
  }'
```

Com ao menos um grupo cadastrado, só os grupos da lista são processados e o
`campaignLabel` vai em `custom_data.campaign_label` de cada evento (útil para
recortar no Gerenciador ou fazer **um grupo por adset**). Lista vazia = aceita
qualquer grupo.

### 2b. Conectar o WhatsApp (Evolution)

Pelo dashboard (painel "configurar instância") ou via API:

```bash
curl -X POST http://localhost:8080/tenants/voll/instance \
  -H "x-api-key: $ADMIN_API_KEY" -H "content-type: application/json" \
  -d '{ "baseUrl": "https://evolution.seu.host", "apiKey": "APIKEY", "instance": "voll-01" }'

# estado + QR (repita até "state":"open")
curl -s http://localhost:8080/tenants/voll/connection -H "x-api-key: $ADMIN_API_KEY" | jq
```

`GET /tenants/:id/dashboard?days=14` devolve os agregados de grupos e links que o
dashboard consome.

### 3. Configurar o webhook no Evolution API

Aponte a instância para o endpoint, com o segredo no header. Via API do Evolution
(v2):

```bash
curl -X POST "https://SEU_EVOLUTION/webhook/set/NOME_DA_INSTANCIA" \
  -H "apikey: SUA_APIKEY_EVOLUTION" -H "content-type: application/json" \
  -d '{
    "webhook": {
      "enabled": true,
      "url": "https://SEU_HOST/webhooks/evolution/voll",
      "headers": { "x-webhook-secret": "um-segredo-forte" },
      "byEvents": false,
      "events": ["GROUP_PARTICIPANTS_UPDATE", "MESSAGES_UPSERT"]
    }
  }'
```

- `GROUP_PARTICIPANTS_UPDATE` → entrada/saída de participantes (o que importa).
- `MESSAGES_UPSERT` → só necessário se você quiser registrar `ctwa_clid` de
  quem chega por anúncio Click-to-WhatsApp (opcional; melhora o match quando existe).

O endpoint trata as duas grafias (`GROUP_PARTICIPANTS_UPDATE`,
`group-participants.update`), ignora `action: "remove"` e, quando dá, lê o
`pushName` do participante para preencher `fn`/`ln`.

### 4. Conferir

```bash
curl -s "http://localhost:8080/tenants/voll/events?limit=20" \
  -H "x-api-key: $ADMIN_API_KEY" | jq
```

Retorna:
- `status` — contagem por `pending`/`sent`/`skipped`/`failed`
- `match_readiness` — proxy local: `% com telefone`, `% com nome`, quantos
  `sent`, quantos casaram `ctwa` (o **Event Match Quality** de verdade só
  aparece no Gerenciador de Eventos → sua fonte CAPI)
- `events` — últimas linhas com `graph_response`, `error`, `campaign_label`

Com `testEventCode` setado, os eventos aparecem em **Gerenciador de Eventos →
Testar eventos**.

## Evento `Lead` no clique do botão (landing page)

O `JoinGroup` casa só por telefone (EMQ Ok). O evento **rico** é o `Lead`
disparado no clique do botão da LP — ele carrega `fbc`, `fbp`, IP e User-Agent,
tem EMQ alta e atribuição determinística. Use os dois: otimize por `Lead`
enquanto o volume de `JoinGroup` casado é baixo e migre depois.

### Endpoint

`POST /lead/:tenantId` — chamado **do navegador** (sem `x-api-key`). Auth = o
`tenantId` no path + checagem de `Origin` contra `lpOrigin` do tenant (defina no
`POST /tenants` com `"lpOrigin": "https://lp.exemplo.com"`; sem isso, aceita
qualquer origem). O servidor pega IP e User-Agent do próprio request.

Body (JSON):

```json
{
  "event_id": "MESMO id usado no fbq('track','Lead',{},{eventID})",
  "fbp": "valor do cookie _fbp",
  "fbc": "valor do cookie _fbc",
  "fbclid": "da URL, se _fbc não existir",
  "event_source_url": "https://lp.exemplo.com/entrar?fbclid=...",
  "external_id": "opcional, id estável seu (será hasheado)"
}
```

### Snippet da landing page

O botão dispara o Pixel **e** o CAPI com o **mesmo `event_id`** (o Meta
deduplica), depois redireciona pro convite:

```html
<!-- Pixel base já instalado na página -->
<script>
  const CAPI_URL = "https://SEU_HOST/lead/voll";
  const INVITE   = "https://chat.whatsapp.com/XXXXXXXXXXXXXXX";

  function getCookie(n){return (document.cookie.match('(^|;)\\s*'+n+'\\s*=\\s*([^;]+)')||[])[2]}

  document.getElementById("btn-entrar").addEventListener("click", function (e) {
    e.preventDefault();
    var eventId = (crypto.randomUUID && crypto.randomUUID()) || String(Date.now()+Math.random());
    var params  = new URLSearchParams(location.search);

    // 1) Pixel (browser)
    if (window.fbq) fbq("track", "Lead", {}, { eventID: eventId });

    // 2) CAPI (server) — sendBeacon sobrevive ao redirect e não faz preflight
    var payload = JSON.stringify({
      event_id: eventId,
      fbp: getCookie("_fbp"),
      fbc: getCookie("_fbc"),
      fbclid: params.get("fbclid"),
      event_source_url: location.href
    });
    (navigator.sendBeacon && navigator.sendBeacon(CAPI_URL, payload)) ||
      fetch(CAPI_URL, { method: "POST", body: payload, headers: { "content-type": "text/plain" }, keepalive: true });

    // 3) vai pro grupo
    location.href = INVITE;
  });
</script>
```

Fluxo completo: `Lead` (atribuído, agora) → pessoa entra → `JoinGroup` (via
Evolution, telefone) alguns minutos depois. Dedupe: `Lead` por `event_id`
(Pixel↔CAPI), `JoinGroup` por `event_id` determinístico.

## Endpoints

| método | rota | auth | uso |
|---|---|---|---|
| GET | `/` , `/dashboard` | — | dashboard (auth via api key no navegador) |
| GET | `/healthz` | — | liveness |
| GET | `/r/:slug` | — | redirect + contagem de clique do link da oferta |
| POST | `/tenants` | `x-api-key` | cria/atualiza tenant (`joinFilter`, `eventName`, `lpOrigin`) |
| POST | `/tenants/:id/meta` | `x-api-key` | credenciais do Meta (`pixelId`, `capiToken`, `testEventCode`, `eventName`) |
| POST | `/tenants/:id/instance` | `x-api-key` | configura Evolution (`baseUrl`, `apiKey`, `instance`) |
| GET | `/tenants/:id/connection` | `x-api-key` | estado + QR |
| POST | `/tenants/:id/discover-groups` | `x-api-key` | lista grupos da instância |
| POST | `/tenants/:id/groups` | `x-api-key` | rastreia grupo (+`campaignLabel`, +`backfill`) |
| POST | `/tenants/:id/links` | `x-api-key` | cria link `/r/<slug>` |
| GET | `/tenants/:id/dashboard` | `x-api-key` | agregados de grupos + links |
| GET | `/tenants/:id/events` | `x-api-key` | log + status (join e lead) + match_readiness |
| POST | `/webhooks/evolution/:tenantId` | `x-webhook-secret` | **fonte principal (join + saída + log)** |
| POST | `/lead/:tenantId` | Origin do tenant | **Lead do clique do botão** |
| POST | `/webhooks/ingest/:tenantId` | `x-webhook-secret` | ingest `{joins}` (extensão Chrome / n8n) |
| POST | `/events` | `x-api-key` | ingest `{tenantId, joins}` (manual) |

## Configuração da campanha no Meta

- Objetivo **Conversões**, otimizar para o evento `JoinGroup` da sua fonte CAPI.
- Enquanto o volume de `JoinGroup` casado for baixo (< ~50/semana/adset):
  otimize por um `Lead` disparado no **clique do botão** (Pixel na landing page,
  atribuído em tempo real) e migre para `JoinGroup` quando acumular.
- `one group per adset` (passo 2 com `campaignLabel`) dá atribuição determinística
  **no nível de adset** para leitura manual, além do match probabilístico do Meta.

## Produção — pendências

- [ ] Criptografar `capi_token` no banco (libsodium/KMS) — hoje é texto puro.
- [ ] HTTPS + rate limit no Fastify; assinatura HMAC real nos webhooks.
- [ ] Painel BullMQ (`bull-board`) e métricas Prometheus.
- [ ] Retenção/purga de `capi_events` e `ctwa_leads`.
- [ ] Reconciliação periódica: comparar joins no banco × conversões atribuídas
  no Gerenciador para saber o match rate real.
- [ ] Operação de números do WhatsApp (pool, aquecimento, proxy) — fora do escopo.

## Arquivos

| caminho | função |
|---|---|
| `src/server.ts` | boot da API |
| `src/worker.ts` | boot do worker BullMQ |
| `src/routes.ts` | endpoints + parsing do payload Evolution |
| `src/pipeline.ts` | dedupe + janela 7d + enfileira |
| `src/core/normalize.ts` | E.164, hashing, `event_id`, first/last name, UF do DDD |
| `src/core/capi.ts` | monta `JoinGroup` / `Lead` e faz POST no Graph API |
| `src/core/attribution.ts` | lookup de `ctwa_clid` (opcional) |
| `src/repo.ts` | queries Postgres |
| `sql/001_init.sql` | schema |
| `test/` | testes das funções puras (`vitest`) |
