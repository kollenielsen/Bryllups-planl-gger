import { config } from "../config.js";
import { getLlm } from "../llm/client.js";
import { OUTREACH_SYSTEM, buildOutreachUser } from "../llm/prompts/outreach.js";
import { OutreachDraftSchema } from "../domain/schema.js";
import { getOrCreateThread, setThreadState } from "./threads.js";
import { enqueue } from "./outbox.js";
import { answeredQuestions, getWedding } from "./weddings.js";
import { getVendor, listVendors, setVendorStatus } from "./vendors.js";
import { logEvent } from "./repo.js";
import type { Vendor, VendorCategory, Wedding } from "../domain/types.js";

export interface OutreachResult {
  queued: number;
  skipped: Array<{ vendor: string; reason: string }>;
}

export async function draftOutreach(
  wedding: Wedding,
  vendor: Vendor,
): Promise<{ subject: string; body: string }> {
  const answered = await answeredQuestions(wedding.id);
  const { value } = await getLlm().extract({
    label: "outreach",
    system: OUTREACH_SYSTEM,
    user: buildOutreachUser({ wedding, vendor, answered }),
    schema: OutreachDraftSchema,
    effort: config.anthropic.draftEffort,
    maxTokens: 2000,
  });
  return { subject: value.subject.trim(), body: withFooter(value.body_da.trim(), wedding) };
}

/**
 * Signatur og afmeldingslinje lægges på i kode, ikke af modellen. De skal stå
 * der hver gang og ordret — det er dem der gør henvendelsen identificerbar og
 * gør det let for en leverandør at sige fra.
 */
function withFooter(body: string, wedding: Wedding): string {
  return [
    body,
    "",
    "Med venlig hilsen",
    `${config.email.fromName} – på vegne af ${wedding.couple_names}`,
    "",
    "Svar blot på denne mail. Ønsker I ikke henvendelser fra os, skriver I det bare, så hører I ikke mere.",
  ].join("\n");
}

/** Klargør førstehenvendelser til alle egnede leverandører i en kategori. */
export async function startOutreach(input: {
  weddingId: string;
  category: VendorCategory;
  limit?: number;
  vendorIds?: string[];
}): Promise<OutreachResult> {
  const wedding = await getWedding(input.weddingId);
  if (!wedding) throw new Error("Bryllup findes ikke.");

  const all = input.vendorIds
    ? ((await Promise.all(input.vendorIds.map(getVendor))).filter(Boolean) as Vendor[])
    : await listVendors(input.weddingId, { category: input.category });

  const limit = input.limit ?? config.sending.maxVendorsPerCategory;
  const skipped: OutreachResult["skipped"] = [];
  let queued = 0;

  for (const vendor of all) {
    if (queued >= limit) {
      skipped.push({ vendor: vendor.name, reason: "over grænsen for antal leverandører" });
      continue;
    }
    if (vendor.excluded) {
      skipped.push({ vendor: vendor.name, reason: "fravalgt af parret" });
      continue;
    }
    if (!vendor.contact_email) {
      skipped.push({ vendor: vendor.name, reason: "ingen mailadresse fundet" });
      continue;
    }
    if (vendor.status !== "discovered" && vendor.status !== "approved_for_outreach") {
      skipped.push({ vendor: vendor.name, reason: `status er allerede '${vendor.status}'` });
      continue;
    }

    try {
      const draft = await draftOutreach(wedding, vendor);
      const thread = await getOrCreateThread(vendor, draft.subject);
      const item = await enqueue({
        weddingId: wedding.id,
        threadId: thread.id,
        toEmail: vendor.contact_email,
        replyToken: thread.reply_token,
        subject: draft.subject,
        body: draft.body,
        kind: "outreach",
      });
      if (!item) {
        skipped.push({ vendor: vendor.name, reason: "adressen står på blokliste" });
        continue;
      }
      await setThreadState(thread.id, "draft");
      await setVendorStatus(vendor.id, "approved_for_outreach");
      queued += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      skipped.push({ vendor: vendor.name, reason: `udkast fejlede: ${message}` });
      await logEvent({
        weddingId: wedding.id,
        vendorId: vendor.id,
        type: "outreach.draft_failed",
        payload: { error: message },
      });
    }
  }

  await logEvent({
    weddingId: wedding.id,
    type: "outreach.started",
    payload: { category: input.category, queued, skipped: skipped.length },
  });
  return { queued, skipped };
}
