# Deploy no Easypanel

No Easypanel o **proxy reverso + SSL** são do painel (Traefik). Você **não** usa o
Caddy nem o `docker-compose.yml` deste repo — monta cada peça como serviço do
Easypanel. O Basic Auth do dashboard é feito pela própria app (`DASH_BASIC_AUTH`),
então também não depende do painel.

## Peças (tudo dentro de 1 projeto, ex. `dutra`)

| Serviço | Tipo no Easypanel | Domínio |
|---|---|---|
| `capi-db` | Template → **PostgreSQL** | — |
| `capi-redis` | Template → **Redis** | — |
| `evolution` | Template → **Evolution API** | — (interno) |
| `capi-api` | **App** (do GitHub, Dockerfile) | `capi.dutraviagens.com.br` |
| `capi-worker` | **App** (mesmo repo) | — |

Serviços do mesmo projeto se enxergam pelo host interno que o Easypanel mostra na
página de cada um (normalmente `dutra_capi-db`, `dutra_capi-redis`,
`dutra_evolution`). Use exatamente o que aparecer lá.

## 0. Código no GitHub

O Easypanel builda a partir de um repositório. Uma vez só:

```bash
cd ~/capi-worker
git init && git add -A && git commit -m "capi-worker"
# crie um repo privado (ex.: gh repo create dutra/capi-worker --private --source=. --push)
git remote add origin git@github.com:SEU_USUARIO/capi-worker.git
git push -u origin main
```

No Easypanel: **Settings → Git → conectar GitHub**.

## 1. PostgreSQL + Redis

- **+ Service → Template → PostgreSQL**. Nome `capi-db`. Deploy. Abra o serviço e
  copie a **Internal Connection URL** (`postgres://user:pass@dutra_capi-db:5432/db`).
- **+ Service → Template → Redis**. Nome `capi-redis`. Host interno:
  `redis://dutra_capi-redis:6379`.

## 2. Evolution API

- **+ Service → Template → Evolution API**. Nome `evolution`.
- Nas envs do template, defina/anote **`AUTHENTICATION_API_KEY`** = uma chave
  longa aleatória (essa é a **apikey global** que cria instâncias).
- Não precisa de domínio — o `capi-api` fala com ela pelo host interno
  `http://dutra_evolution:8080`.

## 3. capi-api (App)

- **+ Service → App**. Nome `capi-api`.
- **Source**: GitHub → seu repo → branch `main`.
- **Build**: Dockerfile (o repo já tem um na raiz).
- **Deploy → Command**: deixe vazio (o Dockerfile já roda `node dist/server.js`).
- **Domains**: adicione `capi.dutraviagens.com.br`, **Port `8080`**, SSL ligado.
  (crie antes o registro **A** desse subdomínio apontando pro IP da VPS.)
- **Environment**:

```
NODE_ENV=production
PORT=8080
DATABASE_URL=postgres://USER:PASS@dutra_capi-db:5432/DB
REDIS_URL=redis://dutra_capi-redis:6379
ADMIN_API_KEY=uma-chave-longa-aleatoria
DASH_BASIC_AUTH=admin:umaSenhaForte
PUBLIC_BASE_URL=https://capi.dutraviagens.com.br
BOOTSTRAP_TENANT_ID=dutra
BOOTSTRAP_TENANT_NAME=Dutra Viagens
BOOTSTRAP_WEBHOOK_SECRET=um-segredo-de-webhook
```

Deploy. O schema é criado sozinho e o tenant `dutra` nasce no primeiro boot.

## 4. capi-worker (App)

- **+ Service → App**. Nome `capi-worker`. Mesmo repo / branch / Dockerfile.
- **Sem domínio, sem porta.**
- **Deploy → Command**: `node dist/worker.js`
- **Environment**: as mesmas `DATABASE_URL` e `REDIS_URL` do `capi-api`, mais
  `WORKER_CONCURRENCY=5`.

Deploy.

## 5. Configurar (no dashboard)

Abra `https://capi.dutraviagens.com.br/` → Basic Auth (`DASH_BASIC_AUTH`).

1. Topo: `tenant id` = `dutra`, `admin api key` = `ADMIN_API_KEY` → Salvar.
2. **Meta — Conversions API**: Pixel ID + token → Salvar Meta.
3. **Conexão WhatsApp → configurar instância → Criar + conectar**:
   - `baseUrl` = `http://dutra_evolution:8080`
   - `apikey global` = `AUTHENTICATION_API_KEY` da Evolution
   - `nome` = `dutra-01`
   - → o webhook é apontado sozinho pra `https://capi.dutraviagens.com.br/webhooks/evolution/dutra`.
4. Escaneia o **QR** com o número (dedicado!).
5. **Grupos → Descobrir → Rastrear** os da Dutra.
6. **Links da oferta → criar** `grupo`. Use `https://capi.dutraviagens.com.br/r/grupo`
   (ou redirect de `dutraviagens.com.br/grupo` pra ele).

## Atualizar

`git push` no repo → Easypanel rebuilda os dois Apps (ou clique **Deploy**).

## Notas

- Rotas públicas por design: `/r/*`, `/lead/*`, `/webhooks/*`, `/healthz`.
  Protegido (Basic Auth + `x-api-key`): `/`, `/dashboard`, `/tenants/*`.
- Se o pareamento da Evolution falhar, troque a tag da imagem no template
  (Baileys muda com frequência).
- Backups: os volumes dos serviços PostgreSQL / Redis / Evolution são gerenciados
  pelo Easypanel.
