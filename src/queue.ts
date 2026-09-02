import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { config } from "./config.js";
import type { CapiJob } from "./types.js";

export type { CapiJob };

export const connection = new Redis(config.redisUrl, { maxRetriesPerRequest: null });

export const CAPI_QUEUE = "capi";

export const capiQueue = new Queue<CapiJob>(CAPI_QUEUE, {
  connection,
  defaultJobOptions: {
    attempts: 5,
    backoff: { type: "exponential", delay: 5000 },
    removeOnComplete: { count: 1000 },
    removeOnFail: { count: 5000 },
  },
});
