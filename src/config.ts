import "dotenv/config";

export const config = {
  env: process.env.NODE_ENV ?? "development",
  port: Number(process.env.PORT ?? 8080),
  logLevel: process.env.LOG_LEVEL ?? "info",

  databaseUrl: process.env.DATABASE_URL ?? "postgres://capi:capi@localhost:5432/capi",
  redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",

  graph: {
    version: process.env.GRAPH_API_VERSION ?? "v21.0",
    fallbackPixelId: process.env.META_PIXEL_ID ?? "",
    fallbackToken: process.env.META_CAPI_TOKEN ?? "",
    fallbackTestCode: process.env.META_TEST_EVENT_CODE ?? "",
  },

  adminApiKey: process.env.ADMIN_API_KEY ?? "troque-isto",
  publicBaseUrl: process.env.PUBLIC_BASE_URL ?? "", // ex.: https://capi.dutraviagens.com.br
  dashBasicAuth: process.env.DASH_BASIC_AUTH ?? "", // "usuario:senha" protege dashboard + /tenants/*
  workerConcurrency: Number(process.env.WORKER_CONCURRENCY ?? 5),

  eventMaxAgeDays: Number(process.env.EVENT_MAX_AGE_DAYS ?? 7),
  ctwaWindowHours: Number(process.env.CTWA_ATTRIBUTION_WINDOW_HOURS ?? 72),
  defaultEventName: process.env.DEFAULT_EVENT_NAME ?? "JoinGroup",

  // cria um tenant automaticamente no boot se ainda não existir (deploy turnkey)
  bootstrap: {
    tenantId: process.env.BOOTSTRAP_TENANT_ID ?? "",
    tenantName: process.env.BOOTSTRAP_TENANT_NAME ?? "",
    webhookSecret: process.env.BOOTSTRAP_WEBHOOK_SECRET ?? "",
  },
};
