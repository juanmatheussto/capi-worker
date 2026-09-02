# Deploy — stack completo numa VPS

> **Usa Easypanel?** Veja [`EASYPANEL.md`](./EASYPANEL.md) — lá o proxy/SSL é do
> painel e você não precisa do Caddy nem do compose.

Sobe tudo num `docker compose`: **Evolution API** (guarda o número), **capi-worker**
(api + worker + dashboard) e **Caddy** (só HTTPS/proxy — o Basic Auth do dashboard
é feito pela própria app via `DASH_BASIC_AUTH`).

```
Internet ──HTTPS──► Caddy ──► capi-api (dashboard, /lead, /r, /webhooks)
                              capi-worker ──► Meta CAPI
   rede interna:  capi-api ⇄ Evolution API ⇄ pg-evo
                  capi-api/worker ⇄ pg-capi ⇄ redis
```

Evolution **não** fica exposta na internet — o capi-worker fala com ela pela rede
interna (`http://evolution:8080`).

## Requisitos

- VPS Linux com **Docker + Docker Compose** (2 vCPU / 2–4 GB dão conta).
- Um subdomínio com **registro A** apontando pro IP da VPS
  (ex.: `capi.dutraviagens.com.br`).
- Portas **80 e 443** liberadas no firewall.

## Passos

```bash
git clone <este repo> && cd capi-worker/deploy
cp .env.example .env

# edite o .env: CADDY_DOMAIN, DASH_BASIC_AUTH (usuario:senha), ADMIN_API_KEY,
# EVOLUTION_API_KEY, BOOTSTRAP_TENANT_ID / BOOTSTRAP_WEBHOOK_SECRET

docker compose up -d --build
```

Caddy resolve o certificado Let's Encrypt sozinho no primeiro acesso.

## Configurar (tudo pelo dashboard)

Abra `https://SEU_DOMINIO/` → Basic Auth (DASH_USER / senha).

1. **Topo**: preencha `tenant id` (= `BOOTSTRAP_TENANT_ID`, ex.: `dutra`) e
   `admin api key` (= `ADMIN_API_KEY`) → Salvar.
2. **Meta — Conversions API**: Pixel ID + token (+ `test_event_code` enquanto
   valida) → Salvar Meta.
3. **Conexão WhatsApp** → *configurar instância do Evolution* →
   **Criar instância nova**:
   - `baseUrl` = `http://evolution:8080`
   - `apikey global` = `EVOLUTION_API_KEY` do `.env`
   - `nome` = ex. `dutra-01`
   - → **Criar + conectar**. O webhook já é apontado automaticamente
     (usa `PUBLIC_BASE_URL`).
4. Aparece o **QR** → no celular do número: WhatsApp → Aparelhos conectados →
   Conectar → escaneia. Estado vira `conectado`.
5. **Grupos** → *Descobrir grupos* → marque os da Dutra / Alerta de Voos →
   *Rastrear selecionados* (marque *backfill* se quiser semear os membros atuais
   pra público).
6. **Links da oferta** → crie o slug `grupo` apontando pro destino real.
   Use `https://SEU_DOMINIO/r/grupo` na mensagem da oferta (ou um redirect de
   `dutraviagens.com.br/grupo` pra ele).

## Landing page do botão (no WordPress/Elementor)

Fica no seu site, não aqui. No clique do botão dispare o Pixel + o CAPI com o
mesmo `event_id` e redirecione pro convite — snippet no `README.md` da raiz
(seção "Evento `Lead` no clique do botão"). O `POST` vai pra
`https://SEU_DOMINIO/lead/<tenant>`.

## Operação

- **Número dedicado/secundário** — automação de WhatsApp fere os Termos; não use o
  principal da operação.
- **Atualizar**: `docker compose pull && docker compose up -d --build`
- **Logs**: `docker compose logs -f capi-api capi-worker evolution`
- **Backup**: volumes `pg_capi`, `pg_evo`, `evolution_instances`.
- **Trocar a tag da Evolution** se o pareamento falhar (Baileys muda com
  frequência) — veja a tag estável no Docker Hub.

## Segurança

- `/r/*`, `/lead/*`, `/webhooks/*`, `/healthz` são públicos por design; o resto
  (dashboard + `/tenants/*`) fica atrás do Basic Auth do Caddy **e** do
  `x-api-key`.
- Rode `chmod 600 .env`. Não versione o `.env`.
- Considere restringir 8081 (debug da Evolution) — já está em `127.0.0.1` só.
