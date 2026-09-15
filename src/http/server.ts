import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import type { Express } from "express";
import { api } from "./routes/api.js";
import { webhooks } from "./routes/webhooks.js";

const here = path.dirname(fileURLToPath(import.meta.url));

export function createApp(): Express {
  const app = express();
  app.use(express.json({ limit: "5mb" }));
  app.use(express.urlencoded({ extended: true, limit: "5mb" }));

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });
  app.use("/api", api);
  app.use("/webhooks", webhooks);
  app.use(express.static(path.resolve(here, "../public")));

  return app;
}
