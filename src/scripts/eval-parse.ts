import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";
import { classifyReply, splitEmail } from "../domain/emailText.js";
import { groundExtraction } from "../domain/confidence.js";
import { VendorReplyExtractionSchema } from "../domain/schema.js";
import { PARSE_SYSTEM, buildParseUser } from "../llm/prompts/parseReply.js";
import { AnthropicLlmClient } from "../llm/client.js";

/**
 * Kører udtrækket mod de vedlagte eksempelmails med den rigtige model og
 * holder resultatet op mod expectations.json.
 *
 * Det er her man ser, om en promptændring gjorde tingene bedre eller værre.
 * Kør den før og efter enhver ændring i PARSE_SYSTEM.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.resolve(here, "../../tests/fixtures");

interface Expectation {
  file: string;
  category: string;
  expect: Record<string, unknown>;
}

const spec = JSON.parse(
  fs.readFileSync(path.join(fixturesDir, "expectations.json"), "utf8"),
) as { cases: Expectation[] };

const llm = new AnthropicLlmClient();
let passed = 0;
let failed = 0;

for (const testCase of spec.cases) {
  const raw = fs.readFileSync(path.join(fixturesDir, "emails", testCase.file), "utf8");
  const split = splitEmail(raw);
  const cleanText = [split.reply, split.signature].filter(Boolean).join("\n\n");
  const replyClass = classifyReply({ body: raw });

  if (replyClass !== "normal") {
    console.log(`\n${testCase.file}: klassificeret som '${replyClass}' — intet modelkald.`);
    continue;
  }

  const started = Date.now();
  const { value: extraction, usage } = await llm.extract({
    label: "parse_reply",
    system: PARSE_SYSTEM,
    user: buildParseUser({
      vendorName: "Testleverandør",
      category: testCase.category,
      weddingDate: "2026-06-12",
      guestRange: "60-90",
      ourLastMessage: "Vi spurgte til pris og ledighed den 12. juni 2026 for 60-90 gæster.",
      replyText: split.reply,
      signature: split.signature,
    }),
    schema: VendorReplyExtractionSchema,
    effort: config.anthropic.parseEffort,
    maxTokens: 4000,
  });

  const grounding = groundExtraction({
    extraction,
    sourceText: cleanText,
    threshold: config.agent.confidenceThreshold,
  });

  const actual: Record<string, unknown> = {
    ...extraction,
    needs_human_review: grounding.needsHumanReview,
    min_vendor_questions: extraction.vendor_questions.length,
  };

  const problems: string[] = [];
  for (const [key, want] of Object.entries(testCase.expect)) {
    const got = actual[key];
    const ok =
      key === "min_vendor_questions" ? Number(got) >= Number(want) : Object.is(got, want) || got === want;
    if (!ok) problems.push(`${key}: forventet ${JSON.stringify(want)}, fik ${JSON.stringify(got)}`);
  }

  if (problems.length === 0) passed += 1;
  else failed += 1;

  console.log(`\n${problems.length === 0 ? "OK  " : "FEJL"} ${testCase.file}  (${Date.now() - started} ms, ${usage?.input ?? "?"}/${usage?.output ?? "?"} tokens)`);
  console.log(
    `     intent=${extraction.reply_intent} pris=${extraction.price_min}–${extraction.price_max} ` +
      `(${extraction.price_basis}) ledig=${extraction.availability} ` +
      `sikkerhed=${grounding.confidence.toFixed(2)} flag=${grounding.needsHumanReview}`,
  );
  if (grounding.reasons.length > 0) {
    console.log(`     ${grounding.reasons.map((r) => `${r.severity}:${r.code}`).join(", ")}`);
  }
  for (const p of problems) console.log(`     ! ${p}`);
}

console.log(`\n${passed} bestået, ${failed} fejlet.`);
process.exit(failed > 0 ? 1 : 0);
