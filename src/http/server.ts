import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import type { Express } from "express";
import { api } from "./routes/api.js";
import { webhooks } from "./routes/webhooks.js";
import { requireAppAuth } from "./auth.js";

const here = path.dirname(fileURLToPath(import.meta.url));

export function createApp(): Express {
  const app = express();
  app.use(express.json({ limit: "5mb" }));
  app.use(express.urlencoded({ extended: true, limit: "5mb" }));

  // Rækkefølgen er selve adgangspolitikken. Alt over gaten er åbent, alt
  // under kræver adgangskode.
  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });
  // Mailudbyderen kan ikke sende Basic Auth; webhooken har sin egen
  // hemmelighed og skal derfor ligge før gaten.
  app.use("/webhooks", webhooks);

  app.use(requireAppAuth());

  app.use("/api", api);
  app.use(express.static(path.resolve(here, "../public")));

  return app;
}
