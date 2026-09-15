import crypto from "node:crypto";
import { Router } from "express";
import type { Request } from "express";
import { config } from "../../config.js";
import { normalizeInbound } from "../../email/inbound.js";
import { handleInbound } from "../../services/conversation.js";

export const webhooks: Router = Router();

/**
 * Indgående mail fra udbyderen (Postmark/SendGrid/Mailgun-formater håndteres ens).
 *
 * Svarer altid 200 ved gyldig hemmelighed, også når håndteringen fejler:
 * mailudbydere gentager leveringen ved fejlkoder, og en gentagen levering af
 * en mail vi allerede har gemt giver ingen mening. Fejlen logges i stedet.
 */
webhooks.post("/inbound", (req, res) => {
  if (!authorized(req)) {
    res.status(401).json({ error: "Ugyldig webhook-hemmelighed." });
    return;
  }

  const email = normalizeInbound((req.body ?? {}) as Record<string, unknown>);
  if (!email.textBody.trim()) {
    res.status(200).json({ outcome: "ignored", detail: "Tom brødtekst." });
    return;
  }

  handleInbound(email)
    .then((result) => res.status(200).json(result))
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[webhook:inbound] fejl:", message);
      res.status(200).json({ outcome: "error", detail: message });
    });
});

function authorized(req: Request): boolean {
  const expected = config.email.inboundSecret;
  if (!expected) {
    // Ingen hemmelighed sat: kun til lokal udvikling.
    if (config.env === "production") return false;
    console.warn("[webhook:inbound] INBOUND_WEBHOOK_SECRET er ikke sat — endpointet er åbent.");
    return true;
  }
  const provided =
    (req.get("x-webhook-secret") ?? "") || String(req.query["token"] ?? "");
  if (provided.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
}
