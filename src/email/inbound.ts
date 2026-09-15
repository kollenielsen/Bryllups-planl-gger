import crypto from "node:crypto";
import { parseAddress } from "./threading.js";

export interface InboundEmail {
  fromEmail: string | null;
  fromName: string | null;
  toEmails: string[];
  subject: string | null;
  textBody: string;
  messageId: string | null;
  inReplyTo: string | null;
  references: string | null;
  headers: Record<string, string>;
  providerId: string | null;
}

/**
 * Normaliserer webhook-payloads fra Postmark, SendGrid Inbound Parse, Mailgun
 * og et generisk format til én intern form. Ukendte felter ignoreres.
 */
export function normalizeInbound(payload: Record<string, unknown>): InboundEmail {
  const headers = collectHeaders(payload);
  const get = (...keys: string[]): string | null => {
    for (const k of keys) {
      const v = payload[k];
      if (typeof v === "string" && v.trim() !== "") return v;
    }
    return null;
  };

  const fromRaw =
    get("From", "from", "sender", "FromFull") ?? stringifyPerson(payload["FromFull"]) ?? null;
  const from = parseAddress(fromRaw);

  const toRaw = get("To", "to", "recipient", "envelope_to", "OriginalRecipient") ?? "";
  const deliveredTo = headers["delivered-to"] ?? "";
  const envelope = parseEnvelopeRecipient(payload["envelope"]);
  const toEmails = uniq(
    [...splitAddresses(toRaw), ...splitAddresses(deliveredTo), ...(envelope ? [envelope] : [])],
  );

  const text =
    get("TextBody", "text", "body-plain", "stripped-text", "plain", "text_body") ??
    htmlToText(get("HtmlBody", "html", "body-html") ?? "");

  return {
    fromEmail: from.email,
    fromName: from.name,
    toEmails,
    subject: get("Subject", "subject"),
    textBody: text ?? "",
    messageId: normalizeMsgId(get("MessageID", "Message-Id", "message-id", "messageId") ?? headers["message-id"] ?? null),
    inReplyTo: normalizeMsgId(get("InReplyTo", "In-Reply-To", "in_reply_to") ?? headers["in-reply-to"] ?? null),
    references: get("References", "references") ?? headers["references"] ?? null,
    headers,
    providerId: get("MessageStream", "provider_id", "id"),
  };
}

function collectHeaders(payload: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  const raw = payload["Headers"] ?? payload["headers"] ?? payload["message-headers"];
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (Array.isArray(entry) && typeof entry[0] === "string") {
        out[entry[0].toLowerCase()] = String(entry[1] ?? "");
      } else if (entry && typeof entry === "object") {
        const e = entry as Record<string, unknown>;
        const name = e["Name"] ?? e["name"];
        const value = e["Value"] ?? e["value"];
        if (typeof name === "string") out[name.toLowerCase()] = String(value ?? "");
      }
    }
  } else if (raw && typeof raw === "object") {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      out[k.toLowerCase()] = String(v ?? "");
    }
  }
  return out;
}

function parseEnvelopeRecipient(envelope: unknown): string | null {
  if (typeof envelope === "string") {
    try {
      const parsed = JSON.parse(envelope) as Record<string, unknown>;
      return typeof parsed["to"] === "string" ? parsed["to"].toLowerCase() : null;
    } catch {
      return null;
    }
  }
  if (envelope && typeof envelope === "object") {
    const to = (envelope as Record<string, unknown>)["to"];
    if (typeof to === "string") return to.toLowerCase();
    if (Array.isArray(to) && typeof to[0] === "string") return to[0].toLowerCase();
  }
  return null;
}

function stringifyPerson(v: unknown): string | null {
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    const email = o["Email"] ?? o["email"];
    const name = o["Name"] ?? o["name"];
    if (typeof email === "string") return name ? `${String(name)} <${email}>` : email;
  }
  return null;
}

function splitAddresses(raw: string): string[] {
  return raw
    .split(",")
    .map((p) => parseAddress(p).email)
    .filter((e): e is string => Boolean(e));
}

function uniq(list: string[]): string[] {
  return [...new Set(list)];
}

function normalizeMsgId(id: string | null): string | null {
  if (!id) return null;
  const trimmed = id.trim();
  if (!trimmed) return null;
  return trimmed.startsWith("<") ? trimmed : `<${trimmed}>`;
}

export function htmlToText(html: string): string {
  if (!html) return "";
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6])>/gi, "\n\n")
    .replace(/<\/(tr|li)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Samme mail kan leveres flere gange; fingeraftrykket gør håndtering idempotent. */
export function fingerprintInbound(email: InboundEmail): string {
  const basis = email.messageId ?? `${email.fromEmail}|${email.subject}|${email.textBody.slice(0, 500)}`;
  return crypto.createHash("sha256").update(basis).digest("hex");
}
