import { randomBytes } from "node:crypto";
import Fastify from "fastify";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { ensureSchema } from "./db.js";
import { getTenant, upsertTenant } from "./repo.js";
import { registerRoutes } from "./routes.js";

async function bootstrapTenant(): Promise<void> {
  const id = config.bootstrap.tenantId;
  if (!id) return;
  if (await getTenant(id)) return;
  await upsertTenant({
    id,
    name: config.bootstrap.tenantName || id,
    pixelId: "",
    capiToken: "",
    webhookSecret: config.bootstrap.webhookSecret || randomBytes(18).toString("hex"),
  });
  logger.info({ tenant: id }, "tenant criado no bootstrap (configure Meta pelo dashboard)");
}

async function main(): Promise<void> {
  await ensureSchema();
  await bootstrapTenant();

  const app = Fastify({
    logger: false,
    bodyLimit: 2 * 1024 * 1024,
    trustProxy: true, // req.ip correto atrás de proxy/load balancer
  });

  // navigator.sendBeacon manda text/plain -> parseia como JSON
  app.addContentTypeParser("text/plain", { parseAs: "string" }, (_req, body, done) => {
    try {
      done(null, body ? JSON.parse(String(body)) : {});
    } catch {
      done(null, {});
    }
  });

  await registerRoutes(app);

  await app.listen({ host: "0.0.0.0", port: config.port });
  logger.info(`API ouvindo em :${config.port}`);
}

main().catch((err) => {
  logger.error({ err }, "falha no boot da API");
  process.exit(1);
});
