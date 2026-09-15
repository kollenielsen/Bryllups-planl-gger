import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";
import { config } from "../config.js";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface ExtractRequest<T> {
  system: string;
  user: string;
  schema: z.ZodType<T>;
  effort?: Effort;
  maxTokens?: number;
  /** Til logging, så man kan se hvilket promptsted der fejlede. */
  label: string;
}

export interface ExtractResult<T> {
  value: T;
  usage?: { input: number; output: number };
}

export interface LlmClient {
  extract<T>(req: ExtractRequest<T>): Promise<ExtractResult<T>>;
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly label: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "LlmError";
  }
}

export class AnthropicLlmClient implements LlmClient {
  private readonly client: Anthropic;

  constructor(client?: Anthropic) {
    this.client =
      client ?? new Anthropic(config.anthropic.apiKey ? { apiKey: config.anthropic.apiKey } : {});
  }

  async extract<T>(req: ExtractRequest<T>): Promise<ExtractResult<T>> {
    let response;
    try {
      response = await this.client.beta.messages.parse({
        model: config.anthropic.model,
        max_tokens: req.maxTokens ?? 8000,
        system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: req.user }],
        output_config: {
          effort: req.effort ?? "medium",
          format: zodOutputFormat(req.schema as z.ZodType),
        },
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
      });
    } catch (err) {
      throw new LlmError(`Modelkald fejlede (${req.label}): ${describe(err)}`, req.label, err);
    }

    if (response.stop_reason === "refusal") {
      throw new LlmError(`Modellen afviste anmodningen (${req.label}).`, req.label);
    }
    if (response.stop_reason === "max_tokens") {
      throw new LlmError(`Svaret blev afkortet af max_tokens (${req.label}).`, req.label);
    }
    if (response.parsed_output == null) {
      throw new LlmError(`Modellen returnerede ikke gyldig JSON (${req.label}).`, req.label);
    }

    return {
      value: response.parsed_output as T,
      usage: { input: response.usage.input_tokens, output: response.usage.output_tokens },
    };
  }
}

function describe(err: unknown): string {
  if (err instanceof Anthropic.APIError) return `${err.status} ${err.message}`;
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Deterministisk testdouble. Svar slås op på label, så en test kan lægge
 * præcis det udtræk ind, den vil have pipelinen til at håndtere.
 */
export class ScriptedLlmClient implements LlmClient {
  readonly calls: ExtractRequest<unknown>[] = [];

  constructor(private readonly responses: Record<string, unknown[]>) {}

  async extract<T>(req: ExtractRequest<T>): Promise<ExtractResult<T>> {
    this.calls.push(req as ExtractRequest<unknown>);
    const queue = this.responses[req.label];
    if (!queue || queue.length === 0) {
      throw new LlmError(`Ingen scriptet respons for '${req.label}'.`, req.label);
    }
    const next = queue.length === 1 ? queue[0] : queue.shift();
    const parsed = req.schema.safeParse(next);
    if (!parsed.success) {
      throw new LlmError(
        `Scriptet respons for '${req.label}' matcher ikke skemaet: ${parsed.error.message}`,
        req.label,
      );
    }
    return { value: parsed.data };
  }
}

let shared: LlmClient | null = null;

export function getLlm(): LlmClient {
  if (!shared) shared = new AnthropicLlmClient();
  return shared;
}

export function setLlm(client: LlmClient | null): void {
  shared = client;
}
