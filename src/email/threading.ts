import crypto from "node:crypto";
import { config } from "../config.js";

/**
 * Trådmatchning hviler på to ben, fordi ingen af dem holder alene:
 * plus-adressering i Reply-To (overlever Outlook-klienter der taber
 * References), og In-Reply-To/References (overlever leverandører der skriver
 * til afsenderadressen i stedet for at svare).
 */

export function newReplyToken(): string {
  return crypto.randomBytes(9).toString("base64url");
}

export function replyToAddress(token: string): string {
  return `${config.email.replyLocalPart}+${token}@${config.email.replyDomain}`;
}

/** Trækker token ud af fx "Bryllup <reply+ab12cd@domæne.dk>". */
export function extractReplyToken(address: string | null | undefined): string | null {
  if (!address) return null;
  const local = config.email.replyLocalPart.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const domain = config.email.replyDomain.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`${local}\\+([A-Za-z0-9_-]{6,})@${domain}`, "i");
  const m = re.exec(address);
  return m?.[1] ?? null;
}

export function newMessageId(): string {
  return `<${crypto.randomUUID()}@${config.email.replyDomain}>`;
}

/** References-kæden: eksisterende kæde plus den mail vi svarer på. */
export function buildReferences(existing: string | null, inReplyTo: string | null): string | null {
  const parts = [existing, inReplyTo].filter((p): p is string => Boolean(p)).join(" ").trim();
  if (!parts) return null;
  const seen = new Set<string>();
  const ids = parts.match(/<[^>]+>/g) ?? [];
  for (const id of ids) seen.add(id);
  // Behold de sidste 20; nogle servere afviser meget lange headere.
  return [...seen].slice(-20).join(" ");
}

export function parseAddress(raw: string | null | undefined): { name: string | null; email: string | null } {
  if (!raw) return { name: null, email: null };
  const angle = /<([^>]+)>/.exec(raw);
  if (angle?.[1]) {
    return { name: raw.slice(0, angle.index).trim().replace(/^"|"$/g, "") || null, email: angle[1].trim().toLowerCase() };
  }
  const bare = /[^\s<>,;]+@[^\s<>,;]+/.exec(raw);
  return { name: null, email: bare ? bare[0].toLowerCase() : null };
}
