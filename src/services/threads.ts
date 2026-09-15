import { exec, many, newId, one } from "./repo.js";
import { newReplyToken } from "../email/threading.js";
import type { Message, Thread, ThreadState, Vendor } from "../domain/types.js";

export async function getOrCreateThread(vendor: Vendor, subject: string): Promise<Thread> {
  const existing = await one<Thread>(`SELECT * FROM threads WHERE vendor_id = $1`, [vendor.id]);
  if (existing) return existing;

  const id = newId("thr");
  await exec(
    `INSERT INTO threads (id, wedding_id, vendor_id, reply_token, subject)
     VALUES ($1,$2,$3,$4,$5)`,
    [id, vendor.wedding_id, vendor.id, newReplyToken(), subject],
  );
  const created = await one<Thread>(`SELECT * FROM threads WHERE id = $1`, [id]);
  if (!created) throw new Error("Tråd kunne ikke oprettes.");
  return created;
}

export async function getThread(id: string): Promise<Thread | null> {
  return one<Thread>(`SELECT * FROM threads WHERE id = $1`, [id]);
}

export async function findThreadByToken(token: string): Promise<Thread | null> {
  return one<Thread>(`SELECT * FROM threads WHERE reply_token = $1`, [token]);
}

/** Fallback når plus-adressen er tabt: match på vores egne Message-ID'er. */
export async function findThreadByMessageIds(ids: string[]): Promise<Thread | null> {
  if (ids.length === 0) return null;
  const row = await one<Thread>(
    `SELECT t.* FROM threads t
     JOIN messages m ON m.thread_id = t.id
     WHERE m.direction = 'outbound' AND m.message_id_hdr = ANY($1::text[])
     ORDER BY m.created_at DESC
     LIMIT 1`,
    [ids],
  );
  return row;
}

/** Sidste fallback: afsenderadressen matcher en leverandør vi har skrevet til. */
export async function findThreadByVendorEmail(
  fromEmail: string | null,
): Promise<Thread | null> {
  if (!fromEmail) return null;
  return one<Thread>(
    `SELECT t.* FROM threads t
     JOIN vendors v ON v.id = t.vendor_id
     WHERE v.contact_email = $1
     ORDER BY t.updated_at DESC
     LIMIT 1`,
    [fromEmail.toLowerCase()],
  );
}

export async function setThreadState(
  threadId: string,
  state: ThreadState,
): Promise<void> {
  await exec(`UPDATE threads SET state = $2, updated_at = now() WHERE id = $1`, [threadId, state]);
}

export async function addMessage(input: {
  threadId: string;
  direction: "outbound" | "inbound";
  fromEmail?: string | null;
  toEmail?: string | null;
  subject?: string | null;
  rawText: string;
  cleanText?: string | null;
  messageIdHdr?: string | null;
  inReplyTo?: string | null;
  refs?: string | null;
  meta?: Record<string, unknown>;
}): Promise<Message> {
  const id = newId("msg");
  await exec(
    `INSERT INTO messages (id, thread_id, direction, from_email, to_email, subject, raw_text,
       clean_text, message_id_hdr, in_reply_to, refs, meta)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      id,
      input.threadId,
      input.direction,
      input.fromEmail ?? null,
      input.toEmail ?? null,
      input.subject ?? null,
      input.rawText,
      input.cleanText ?? null,
      input.messageIdHdr ?? null,
      input.inReplyTo ?? null,
      input.refs ?? null,
      JSON.stringify(input.meta ?? {}),
    ],
  );

  const stampColumn = input.direction === "inbound" ? "last_inbound_at" : "last_outbound_at";
  await exec(
    `UPDATE threads SET ${stampColumn} = now(), turn_count = turn_count + 1, updated_at = now()
     WHERE id = $1`,
    [input.threadId],
  );

  const msg = await one<Message>(`SELECT * FROM messages WHERE id = $1`, [id]);
  if (!msg) throw new Error("Besked kunne ikke gemmes.");
  return msg;
}

export async function listMessages(threadId: string): Promise<Message[]> {
  return many<Message>(`SELECT * FROM messages WHERE thread_id = $1 ORDER BY created_at`, [
    threadId,
  ]);
}

export async function lastOutboundMessage(threadId: string): Promise<Message | null> {
  return one<Message>(
    `SELECT * FROM messages WHERE thread_id = $1 AND direction = 'outbound'
     ORDER BY created_at DESC LIMIT 1`,
    [threadId],
  );
}

/** Kompakt udskrift til modellen: den rensede tekst, ikke den citerede historik. */
export async function buildTranscript(
  threadId: string,
  limit = 12,
): Promise<Array<{ direction: "outbound" | "inbound"; text: string }>> {
  const msgs = await listMessages(threadId);
  return msgs.slice(-limit).map((m) => ({
    direction: m.direction,
    text: (m.clean_text ?? m.raw_text).slice(0, 4000),
  }));
}
