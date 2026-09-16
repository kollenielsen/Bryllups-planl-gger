import { config } from "../config.js";
import { classifyReply, splitEmail } from "../domain/emailText.js";
import { groundExtraction } from "../domain/confidence.js";
import { FollowUpDraftSchema, VendorReplyExtractionSchema } from "../domain/schema.js";
import { PARSE_SYSTEM, buildParseUser } from "../llm/prompts/parseReply.js";
import { FOLLOWUP_SYSTEM, buildFollowUpUser } from "../llm/prompts/followup.js";
import { LlmError, getLlm } from "../llm/client.js";
import { buildReferences, extractReplyToken } from "../email/threading.js";
import type { InboundEmail } from "../email/inbound.js";
import { fingerprintInbound } from "../email/inbound.js";
import { exec, logEvent, one } from "./repo.js";
import {
  addMessage,
  buildTranscript,
  findThreadByMessageIds,
  findThreadByToken,
  findThreadByVendorEmail,
  getThread,
  lastOutboundMessage,
  setThreadState,
} from "./threads.js";
import { getVendor, setVendorStatus, suppress } from "./vendors.js";
import { addOpenQuestion, answeredQuestions, getWedding } from "./weddings.js";
import { saveQuote } from "./quotes.js";
import { enqueue } from "./outbox.js";
import type { Thread, Vendor, Wedding } from "../domain/types.js";

export type InboundOutcome =
  | "duplicate"
  | "unmatched"
  | "bounce"
  | "opt_out"
  | "auto_reply"
  | "parsed"
  | "parse_failed";

export interface InboundResult {
  outcome: InboundOutcome;
  threadId?: string;
  quoteId?: string;
  repliedWith?: string;
  needsHuman?: boolean;
  detail?: string;
}

/**
 * Hele den indgående vej. Rækkefølgen er valgt, så de billige og sikre
 * afgørelser træffes før modelkaldet: dublet, trådmatch, og de svartyper
 * hvor et udtræk ville være meningsløst (bounce, framelding, autosvar).
 */
export async function handleInbound(email: InboundEmail): Promise<InboundResult> {
  const fingerprint = fingerprintInbound(email);
  const inserted = await one<{ fingerprint: string }>(
    `INSERT INTO inbound_dedup (fingerprint) VALUES ($1)
     ON CONFLICT (fingerprint) DO NOTHING RETURNING fingerprint`,
    [fingerprint],
  );
  if (!inserted) return { outcome: "duplicate" };

  const thread = await resolveThread(email);
  if (!thread) {
    await logEvent({
      type: "inbound.unmatched",
      payload: { from: email.fromEmail, subject: email.subject, to: email.toEmails },
    });
    return { outcome: "unmatched", detail: "Mailen kunne ikke knyttes til en tråd." };
  }

  const vendor = await getVendor(thread.vendor_id);
  const wedding = await getWedding(thread.wedding_id);
  if (!vendor || !wedding) return { outcome: "unmatched", detail: "Tråden peger på slettede data." };

  const split = splitEmail(email.textBody);
  const cleanText = [split.reply, split.signature].filter(Boolean).join("\n\n");
  const replyClass = classifyReply({
    subject: email.subject,
    body: email.textBody,
    headers: email.headers,
    fromEmail: email.fromEmail,
  });

  const stored = await addMessage({
    threadId: thread.id,
    direction: "inbound",
    fromEmail: email.fromEmail,
    toEmail: email.toEmails[0] ?? null,
    subject: email.subject,
    rawText: email.textBody,
    cleanText,
    messageIdHdr: email.messageId,
    inReplyTo: email.inReplyTo,
    refs: email.references,
    meta: { replyClass, quotedChars: split.quoted?.length ?? 0 },
  });

  await logEvent({
    weddingId: wedding.id,
    vendorId: vendor.id,
    threadId: thread.id,
    type: "inbound.received",
    payload: { class: replyClass, messageId: stored.id },
  });

  if (replyClass === "bounce") {
    if (vendor.contact_email) await suppress(vendor.contact_email, "bounce");
    await setVendorStatus(vendor.id, "bounced");
    await setThreadState(thread.id, "closed");
    return { outcome: "bounce", threadId: thread.id };
  }

  if (replyClass === "opt_out") {
    if (vendor.contact_email) await suppress(vendor.contact_email, "framelding");
    await setVendorStatus(vendor.id, "opted_out");
    await setThreadState(thread.id, "closed");
    await cancelPendingFor(thread.id);
    return { outcome: "opt_out", threadId: thread.id };
  }

  if (replyClass === "auto_reply") {
    // Autosvar er ikke et svar. Tråden bliver stående og venter.
    await setThreadState(thread.id, "awaiting_vendor");
    return { outcome: "auto_reply", threadId: thread.id };
  }

  const ourLast = await lastOutboundMessage(thread.id);

  let extraction;
  try {
    const result = await getLlm().extract({
      label: "parse_reply",
      system: PARSE_SYSTEM,
      user: buildParseUser({
        vendorName: vendor.name,
        category: vendor.category,
        weddingDate: wedding.wedding_date,
        guestRange: `${wedding.guest_count_min}-${wedding.guest_count_max}`,
        ourLastMessage: ourLast ? (ourLast.clean_text ?? ourLast.raw_text).slice(0, 2000) : null,
        replyText: split.reply,
        signature: split.signature,
      }),
      schema: VendorReplyExtractionSchema,
      effort: config.anthropic.parseEffort,
      maxTokens: 4000,
    });
    extraction = result.value;
  } catch (err) {
    const message = err instanceof LlmError ? err.message : String(err);
    await setThreadState(thread.id, "needs_human");
    await setVendorStatus(vendor.id, "replied");
    await logEvent({
      weddingId: wedding.id,
      vendorId: vendor.id,
      threadId: thread.id,
      type: "parse.failed",
      payload: { error: message },
    });
    return { outcome: "parse_failed", threadId: thread.id, needsHuman: true, detail: message };
  }

  const grounding = groundExtraction({
    extraction,
    sourceText: cleanText,
    threshold: config.agent.confidenceThreshold,
  });

  const quote = await saveQuote({
    wedding,
    vendorId: vendor.id,
    threadId: thread.id,
    messageId: stored.id,
    extraction,
    grounding,
  });

  await logEvent({
    weddingId: wedding.id,
    vendorId: vendor.id,
    threadId: thread.id,
    type: "parse.done",
    payload: {
      intent: extraction.reply_intent,
      confidence: grounding.confidence,
      needsHumanReview: grounding.needsHumanReview,
      reasons: grounding.reasons.map((r) => r.code),
    },
  });

  await applyVendorStatus(vendor, extraction.reply_intent, grounding.needsHumanReview);

  const decision = decideNextStep({
    intent: extraction.reply_intent,
    vendorQuestions: extraction.vendor_questions,
    availability: extraction.availability,
    hasPrice: extraction.price_min !== null || extraction.price_max !== null,
    turnCount: await agentTurnCount(thread.id),
    maxTurns: config.agent.maxTurnsPerThread,
    needsHumanReview: grounding.needsHumanReview,
  });

  if (!decision.reply) {
    await setThreadState(thread.id, decision.state);
    return {
      outcome: "parsed",
      threadId: thread.id,
      quoteId: quote.id,
      needsHuman: decision.state === "needs_human",
      detail: decision.reason,
    };
  }

  const followUp = await draftAndQueueFollowUp({
    wedding,
    vendor,
    thread,
    inboundMessageId: email.messageId,
    inboundReferences: email.references,
    vendorQuestions: extraction.vendor_questions,
    stateAfterQueue: decision.state,
  });

  return {
    outcome: "parsed",
    threadId: thread.id,
    quoteId: quote.id,
    repliedWith: followUp.queuedBody ?? undefined,
    needsHuman: followUp.needsHuman,
    detail: followUp.reason,
  };
}

async function resolveThread(email: InboundEmail): Promise<Thread | null> {
  for (const addr of [...email.toEmails, email.headers["delivered-to"], email.headers["to"]]) {
    const token = extractReplyToken(addr ?? null);
    if (token) {
      const t = await findThreadByToken(token);
      if (t) return t;
    }
  }
  const ids = [
    ...(email.inReplyTo ? [email.inReplyTo] : []),
    ...(email.references?.match(/<[^>]+>/g) ?? []),
  ];
  const byId = await findThreadByMessageIds(ids);
  if (byId) return byId;
  return findThreadByVendorEmail(email.fromEmail);
}

/**
 * Hvor mange mails agenten har sendt i tråden — inklusive dem der stadig
 * ligger i køen.
 *
 * Loftet tælles på agentens egne mails, ikke på alle beskeder: det er
 * afsendelserne der koster leverandøren tid, og de endnu usendte skal tælle
 * med, ellers kan flere svar i træk nå at lægge en ny opfølgning i kø hver,
 * før køen overhovedet er tømt.
 */
export async function agentTurnCount(threadId: string): Promise<number> {
  const row = await one<{ count: string | number }>(
    `SELECT
       (SELECT COUNT(*) FROM messages
         WHERE thread_id = $1 AND direction = 'outbound')
     + (SELECT COUNT(*) FROM outbox
         WHERE thread_id = $1 AND status IN ('queued','needs_approval','sending'))
       AS count`,
    [threadId],
  );
  return Number(row?.count ?? 0);
}

export interface NextStep {
  reply: boolean;
  state: Thread["state"];
  reason: string;
}

/**
 * Beslutningen om at svare tages i kode, ikke af modellen. Modellen skriver
 * teksten; om der overhovedet skal skrives, afgøres af trådens tilstand.
 */
export function decideNextStep(input: {
  intent: string;
  vendorQuestions: string[];
  availability: string;
  hasPrice: boolean;
  turnCount: number;
  maxTurns: number;
  needsHumanReview: boolean;
}): NextStep {
  if (input.turnCount >= input.maxTurns) {
    return {
      reply: false,
      state: "needs_human",
      reason: `Agenten har sendt ${input.turnCount} mails i tråden. Den stopper og overlader den til parret.`,
    };
  }
  if (input.intent === "not_interested" || input.intent === "unavailable") {
    return { reply: true, state: "closed", reason: "Afslag — der sendes en kort afsluttende mail." };
  }
  if (input.vendorQuestions.length > 0 || input.intent === "question") {
    return { reply: true, state: "needs_agent_reply", reason: "Leverandøren stiller spørgsmål." };
  }
  if (input.intent === "quote" && input.hasPrice && input.availability === "unknown") {
    return {
      reply: true,
      state: "needs_agent_reply",
      reason: "Pris modtaget, men ledighed på datoen mangler.",
    };
  }
  if (input.intent === "quote" && input.hasPrice) {
    return {
      reply: false,
      state: input.needsHumanReview ? "needs_human" : "quoted",
      reason: input.needsHumanReview
        ? "Tilbud modtaget, men udtrækket kunne ikke verificeres."
        : "Tilbud modtaget og verificeret.",
    };
  }
  if (input.intent === "acknowledgement") {
    return { reply: false, state: "awaiting_vendor", reason: "Kvittering — vi venter videre." };
  }
  if (input.needsHumanReview) {
    return { reply: false, state: "needs_human", reason: "Svaret kunne ikke tolkes sikkert." };
  }
  return { reply: true, state: "needs_agent_reply", reason: "Svaret mangler pris og ledighed." };
}

async function draftAndQueueFollowUp(input: {
  wedding: Wedding;
  vendor: Vendor;
  thread: Thread;
  inboundMessageId: string | null;
  inboundReferences: string | null;
  vendorQuestions: string[];
  coupleInstruction?: string | null;
  /**
   * Trådtilstand når svaret er lagt i kø. Et afslag besvares med en høflig
   * afslutning, og så er tråden slut — den må ikke stå og vente på en
   * leverandør, der allerede har sagt nej.
   */
  stateAfterQueue?: Thread["state"];
}): Promise<{ queuedBody: string | null; needsHuman: boolean; reason: string }> {
  const { wedding, vendor, thread } = input;
  const transcript = await buildTranscript(thread.id);
  const answered = await answeredQuestions(wedding.id);

  let draft;
  try {
    const result = await getLlm().extract({
      label: "followup",
      system: FOLLOWUP_SYSTEM,
      user: buildFollowUpUser({
        wedding,
        vendor,
        transcript,
        vendorQuestions: input.vendorQuestions,
        answered,
        coupleInstruction: input.coupleInstruction ?? null,
      }),
      schema: FollowUpDraftSchema,
      effort: config.anthropic.draftEffort,
      maxTokens: 2000,
    });
    draft = result.value;
  } catch (err) {
    await setThreadState(thread.id, "needs_human");
    const message = err instanceof Error ? err.message : String(err);
    await logEvent({
      weddingId: wedding.id,
      threadId: thread.id,
      type: "followup.failed",
      payload: { error: message },
    });
    return { queuedBody: null, needsHuman: true, reason: `Svarudkast fejlede: ${message}` };
  }

  // Spørgsmål agenten ikke kan besvare, går til parret — de bliver aldrig gættet.
  for (const q of draft.unanswerable_questions) {
    await addOpenQuestion({
      weddingId: wedding.id,
      vendorId: vendor.id,
      threadId: thread.id,
      question: q,
    });
  }

  if (draft.needs_human || !draft.should_reply) {
    await setThreadState(thread.id, draft.needs_human ? "needs_human" : "awaiting_vendor");
    return {
      queuedBody: null,
      needsHuman: draft.needs_human,
      reason: draft.needs_human_reason ?? "Agenten vurderede, at der ikke skal svares automatisk.",
    };
  }

  const body = [
    draft.body_da.trim(),
    "",
    "Med venlig hilsen",
    `${config.email.fromName} – på vegne af ${wedding.couple_names}`,
  ].join("\n");

  await enqueue({
    weddingId: wedding.id,
    threadId: thread.id,
    toEmail: vendor.contact_email ?? "",
    replyToken: thread.reply_token,
    subject: replySubject(thread.subject),
    body,
    kind: "followup",
    inReplyTo: input.inboundMessageId,
    references: buildReferences(input.inboundReferences, input.inboundMessageId),
  });

  await setThreadState(thread.id, input.stateAfterQueue ?? "awaiting_vendor");
  return {
    queuedBody: body,
    needsHuman: false,
    reason:
      draft.unanswerable_questions.length > 0
        ? `Svar lagt i kø. ${draft.unanswerable_questions.length} spørgsmål er sendt videre til parret.`
        : "Svar lagt i kø.",
  };
}

export function replySubject(subject: string): string {
  return /^(re|sv|vs):/i.test(subject.trim()) ? subject : `SV: ${subject}`;
}

async function applyVendorStatus(
  vendor: Vendor,
  intent: string,
  needsReview: boolean,
): Promise<void> {
  if (intent === "unavailable" || intent === "not_interested") {
    await setVendorStatus(vendor.id, "rejected", { reason: intent });
    return;
  }
  if (intent === "quote" && !needsReview) {
    await setVendorStatus(vendor.id, "quoted");
    return;
  }
  if (intent === "question") {
    await setVendorStatus(vendor.id, "awaiting_info");
    return;
  }
  await setVendorStatus(vendor.id, "replied");
}

async function cancelPendingFor(threadId: string): Promise<void> {
  await exec(
    `UPDATE outbox SET status = 'cancelled'
     WHERE thread_id = $1 AND status IN ('queued','needs_approval')`,
    [threadId],
  );
}


/**
 * Parret beder agenten følge op på noget bestemt i en tråd. Samme vej som en
 * almindelig opfølgning, så godkendelse, rate-limit og trådtilstand gælder ens.
 */
export async function requestFollowUp(
  threadId: string,
  instruction: string,
): Promise<{ queuedBody: string | null; needsHuman: boolean; reason: string }> {
  const thread = await getThread(threadId);
  if (!thread) throw new Error("Tråd findes ikke.");
  const vendor = await getVendor(thread.vendor_id);
  const wedding = await getWedding(thread.wedding_id);
  if (!vendor || !wedding) throw new Error("Tråden peger på slettede data.");

  const lastInbound = await one<{ message_id_hdr: string | null; refs: string | null }>(
    `SELECT message_id_hdr, refs FROM messages
     WHERE thread_id = $1 AND direction = 'inbound'
     ORDER BY created_at DESC LIMIT 1`,
    [threadId],
  );

  return draftAndQueueFollowUp({
    wedding,
    vendor,
    thread,
    inboundMessageId: lastInbound?.message_id_hdr ?? null,
    inboundReferences: lastInbound?.refs ?? null,
    vendorQuestions: [],
    coupleInstruction: instruction,
  });
}
