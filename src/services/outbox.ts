import { config } from "../config.js";
import { exec, logEvent, many, newId, one } from "./repo.js";
import { ConsoleEmailProvider, getEmailProvider } from "../email/provider.js";
import { buildReferences, replyToAddress } from "../email/threading.js";
import { addMessage, getThread, setThreadState } from "./threads.js";
import { isSuppressed, setVendorStatus } from "./vendors.js";
import type { OutboxItem } from "../domain/types.js";

export interface EnqueueInput {
  weddingId: string;
  threadId: string;
  toEmail: string;
  replyToken: string;
  subject: string;
  body: string;
  kind: "outreach" | "followup" | "manual";
  inReplyTo?: string | null;
  references?: string | null;
  /** Tvinger godkendelseskrav uanset konfiguration. */
  requireApproval?: boolean;
}

export async function enqueue(input: EnqueueInput): Promise<OutboxItem | null> {
  if (await isSuppressed(input.toEmail)) {
    await logEvent({
      weddingId: input.weddingId,
      threadId: input.threadId,
      type: "outbox.suppressed",
      payload: { to: input.toEmail },
    });
    return null;
  }

  const id = newId("out");
  const scheduledAt = await nextSlot(input.weddingId);
  // Godkendelse kræves for førstehenvendelser; opfølgninger i en igangværende
  // tråd sendes af agenten, ellers er samtaleløkken ikke en løkke.
  const needsApproval =
    input.requireApproval ?? (config.sending.requireApproval && input.kind === "outreach");

  await exec(
    `INSERT INTO outbox (id, wedding_id, thread_id, to_email, reply_to, subject, body_text,
       in_reply_to, refs, kind, status, scheduled_at, dry_run)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [
      id,
      input.weddingId,
      input.threadId,
      input.toEmail.toLowerCase(),
      replyToAddress(input.replyToken),
      input.subject,
      input.body,
      input.inReplyTo ?? null,
      input.references ?? null,
      input.kind,
      needsApproval ? "needs_approval" : "queued",
      scheduledAt.toISOString(),
      config.sending.dryRun,
    ],
  );

  await logEvent({
    weddingId: input.weddingId,
    threadId: input.threadId,
    type: "outbox.queued",
    payload: { id, kind: input.kind, needsApproval, scheduledAt: scheduledAt.toISOString() },
  });

  return one<OutboxItem>(`SELECT * FROM outbox WHERE id = $1`, [id]);
}

/**
 * Næste ledige afsendelsestidspunkt for dette bryllup.
 *
 * Tre begrænsninger stablet oven på hinanden: minimumsafstand mellem mails,
 * tilfældigt spring så mønsteret ikke er maskinelt, og kontortidsvindue.
 * Formålet er deliverability — tyve mails fra samme adresse på ét minut er
 * den hurtigste vej i spamfilteret.
 */
export async function nextSlot(weddingId: string, now = new Date()): Promise<Date> {
  const row = await one<{ latest: string | Date | null }>(
    `SELECT MAX(scheduled_at) AS latest FROM outbox
     WHERE wedding_id = $1 AND status IN ('queued','needs_approval','sending','sent')`,
    [weddingId],
  );
  const latest = row?.latest ? new Date(row.latest) : null;
  const gapMs = config.sending.minGapSeconds * 1000;
  const jitterMs = Math.floor(Math.random() * config.sending.jitterSeconds * 1000);

  let candidate = new Date(Math.max(now.getTime(), (latest?.getTime() ?? 0) + gapMs) + jitterMs);
  candidate = clampToSendWindow(candidate);
  return candidate;
}

export function clampToSendWindow(date: Date): Date {
  const { sendWindowStartHour: start, sendWindowEndHour: end } = config.sending;
  if (start >= end) return date;
  const out = new Date(date);
  if (out.getHours() < start) {
    out.setHours(start, Math.floor(Math.random() * 20), 0, 0);
  } else if (out.getHours() >= end) {
    out.setDate(out.getDate() + 1);
    out.setHours(start, Math.floor(Math.random() * 20), 0, 0);
  }
  return out;
}

export async function approveOutboxItem(id: string): Promise<void> {
  await exec(`UPDATE outbox SET status = 'queued' WHERE id = $1 AND status = 'needs_approval'`, [
    id,
  ]);
}

export async function approveAllForWedding(weddingId: string): Promise<number> {
  const rows = await many<{ id: string }>(
    `SELECT id FROM outbox WHERE wedding_id = $1 AND status = 'needs_approval'`,
    [weddingId],
  );
  for (const r of rows) await approveOutboxItem(r.id);
  return rows.length;
}

export async function cancelOutboxItem(id: string): Promise<void> {
  await exec(
    `UPDATE outbox SET status = 'cancelled' WHERE id = $1 AND status IN ('queued','needs_approval')`,
    [id],
  );
}

export async function listOutbox(weddingId: string): Promise<OutboxItem[]> {
  return many<OutboxItem>(
    `SELECT * FROM outbox WHERE wedding_id = $1 ORDER BY scheduled_at DESC LIMIT 200`,
    [weddingId],
  );
}

async function sentLastHour(): Promise<number> {
  const row = await one<{ count: string | number }>(
    `SELECT COUNT(*) AS count FROM outbox WHERE status = 'sent' AND sent_at > now() - interval '1 hour'`,
  );
  return Number(row?.count ?? 0);
}

/** Ét gennemløb af køen. Returnerer antal faktisk afsendte. */
export async function processOutbox(now = new Date()): Promise<number> {
  let budget = config.sending.maxPerHour - (await sentLastHour());
  if (budget <= 0) return 0;

  const due = await many<OutboxItem>(
    `SELECT * FROM outbox WHERE status = 'queued' AND scheduled_at <= $1
     ORDER BY scheduled_at LIMIT $2`,
    [now.toISOString(), budget],
  );

  let sent = 0;
  for (const item of due) {
    if (budget <= 0) break;
    const claimed = await one<{ id: string }>(
      `UPDATE outbox SET status = 'sending', attempts = attempts + 1
       WHERE id = $1 AND status = 'queued' RETURNING id`,
      [item.id],
    );
    if (!claimed) continue;

    try {
      const provider = item.dry_run ? new ConsoleEmailProvider() : getEmailProvider();
      const result = await provider.send({
        to: item.to_email,
        replyTo: item.reply_to,
        subject: item.subject,
        text: item.body_text,
        inReplyTo: item.in_reply_to,
        references: item.refs,
      });

      await exec(`UPDATE outbox SET status = 'sent', sent_at = now() WHERE id = $1`, [item.id]);
      await addMessage({
        threadId: item.thread_id,
        direction: "outbound",
        toEmail: item.to_email,
        fromEmail: item.reply_to,
        subject: item.subject,
        rawText: item.body_text,
        cleanText: item.body_text,
        messageIdHdr: result.messageId,
        inReplyTo: item.in_reply_to,
        refs: buildReferences(item.refs, item.in_reply_to),
        meta: { kind: item.kind, transport: result.transport, dryRun: item.dry_run },
      });

      const thread = await getThread(item.thread_id);
      if (thread) {
        // Kun førstehenvendelsen flytter leverandøren til 'contacted'. En
        // opfølgning må ikke rulle status tilbage fra fx 'quoted' til
        // 'contacted' — så ville sammenligningsvisningen vise et modtaget
        // tilbud, som om der aldrig var kommet svar.
        if (item.kind === "outreach") {
          await setThreadState(thread.id, "awaiting_vendor");
          await setVendorStatus(thread.vendor_id, "contacted", { via: item.kind });
        } else if (thread.state !== "closed") {
          // Samtaleløkken har allerede sat trådtilstanden; en lukket tråd
          // (fx en høflig afslutning efter et afslag) forbliver lukket.
          await setThreadState(thread.id, "awaiting_vendor");
        }
      }
      await logEvent({
        weddingId: item.wedding_id,
        threadId: item.thread_id,
        type: "outbox.sent",
        payload: { id: item.id, dryRun: item.dry_run, transport: result.transport },
      });
      sent += 1;
      budget -= 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const failed = item.attempts + 1 >= 3;
      await exec(`UPDATE outbox SET status = $2, last_error = $3 WHERE id = $1`, [
        item.id,
        failed ? "failed" : "queued",
        message,
      ]);
      await logEvent({
        weddingId: item.wedding_id,
        threadId: item.thread_id,
        type: "outbox.error",
        payload: { id: item.id, error: message, willRetry: !failed },
      });
    }
  }
  return sent;
}

let timer: NodeJS.Timeout | null = null;

export function startOutboxWorker(): void {
  if (timer) return;
  timer = setInterval(() => {
    processOutbox().catch((err) => console.error("[outbox] fejl:", err));
  }, config.sending.workerIntervalMs);
  timer.unref?.();
}

export function stopOutboxWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
