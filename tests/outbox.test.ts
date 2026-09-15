import { beforeEach, describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { freshDb } from "./helpers.js";
import { RecordingEmailProvider, setEmailProvider } from "../src/email/provider.js";
import { createWedding } from "../src/services/weddings.js";
import { upsertVendor } from "../src/services/vendors.js";
import { getOrCreateThread } from "../src/services/threads.js";
import {
  approveAllForWedding,
  clampToSendWindow,
  enqueue,
  listOutbox,
  nextSlot,
  processOutbox,
} from "../src/services/outbox.js";
import type { Thread, Wedding } from "../src/domain/types.js";

async function setup(): Promise<{ wedding: Wedding; threads: Thread[] }> {
  const wedding = await createWedding({
    couple_names: "Mia og Jonas",
    contact_email: "mia@example.dk",
    region: "Sjælland",
    guest_count_min: 60,
    guest_count_max: 90,
  });
  const threads: Thread[] = [];
  for (let i = 0; i < 4; i += 1) {
    const vendor = await upsertVendor({
      wedding_id: wedding.id,
      name: `Lokale ${i}`,
      category: "venue",
      contact_email: `lokale${i}@example.com`,
    });
    threads.push(await getOrCreateThread(vendor, `Forespørgsel ${i}`));
  }
  return { wedding, threads };
}

async function queueAll(wedding: Wedding, threads: Thread[]): Promise<void> {
  for (const [i, thread] of threads.entries()) {
    await enqueue({
      weddingId: wedding.id,
      threadId: thread.id,
      toEmail: `lokale${i}@example.com`,
      replyToken: thread.reply_token,
      subject: `Forespørgsel ${i}`,
      body: "Hej",
      kind: "outreach",
    });
  }
}

beforeEach(async () => {
  await freshDb();
  setEmailProvider(new RecordingEmailProvider());
  config.sending.dryRun = false;
  config.sending.requireApproval = false;
  config.sending.minGapSeconds = 0;
  config.sending.jitterSeconds = 0;
  config.sending.sendWindowStartHour = 0;
  config.sending.sendWindowEndHour = 24;
  config.sending.maxPerHour = 50;
});

describe("afsendelseskø", () => {
  it("kræver godkendelse af førstehenvendelser når det er slået til", async () => {
    config.sending.requireApproval = true;
    const { wedding, threads } = await setup();
    await queueAll(wedding, threads);

    expect((await listOutbox(wedding.id)).every((o) => o.status === "needs_approval")).toBe(true);
    expect(await processOutbox()).toBe(0);

    expect(await approveAllForWedding(wedding.id)).toBe(4);
    expect(await processOutbox()).toBe(4);
  });

  it("sender aldrig flere end timegrænsen", async () => {
    config.sending.maxPerHour = 2;
    const { wedding, threads } = await setup();
    await queueAll(wedding, threads);

    expect(await processOutbox()).toBe(2);
    expect(await processOutbox()).toBe(0);

    const items = await listOutbox(wedding.id);
    expect(items.filter((o) => o.status === "sent")).toHaveLength(2);
    expect(items.filter((o) => o.status === "queued")).toHaveLength(2);
  });

  it("spreder mails ud i tid i stedet for at sende dem samtidig", async () => {
    config.sending.minGapSeconds = 300;
    const { wedding, threads } = await setup();
    await queueAll(wedding, threads);

    const times = (await listOutbox(wedding.id))
      .map((o) => new Date(o.scheduled_at).getTime())
      .sort((a, b) => a - b);
    for (let i = 1; i < times.length; i += 1) {
      expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(300_000);
    }
    // Ingen af dem er forfaldne endnu ud over den første.
    expect(await processOutbox()).toBe(1);
  });

  it("skubber afsendelse uden for kontortid frem til næste morgen", () => {
    config.sending.sendWindowStartHour = 8;
    config.sending.sendWindowEndHour = 18;

    const evening = new Date(2026, 2, 3, 23, 30, 0);
    const moved = clampToSendWindow(evening);
    expect(moved.getDate()).toBe(4);
    expect(moved.getHours()).toBe(8);

    const earlyMorning = new Date(2026, 2, 3, 5, 0, 0);
    expect(clampToSendWindow(earlyMorning).getHours()).toBe(8);

    const midday = new Date(2026, 2, 3, 12, 0, 0);
    expect(clampToSendWindow(midday).getHours()).toBe(12);
  });

  it("lægger nye mails efter dem der allerede er i kø", async () => {
    config.sending.minGapSeconds = 600;
    const { wedding, threads } = await setup();
    await queueAll(wedding, [threads[0]!]);
    const first = (await listOutbox(wedding.id))[0]!;
    const slot = await nextSlot(wedding.id);
    expect(slot.getTime()).toBeGreaterThanOrEqual(
      new Date(first.scheduled_at).getTime() + 600_000,
    );
  });

  it("skriver mailen til disk i stedet for at sende i tør-kørsel", async () => {
    config.sending.dryRun = true;
    const recorder = new RecordingEmailProvider();
    setEmailProvider(recorder);
    const { wedding, threads } = await setup();
    await queueAll(wedding, [threads[0]!]);

    expect(await processOutbox()).toBe(1);
    // Den konfigurerede udbyder blev aldrig brugt.
    expect(recorder.sent).toHaveLength(0);
  });
});
