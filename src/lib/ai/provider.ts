import { AppError } from "@/lib/errors";

/**
 * Model-agnostic chat completion. Implementations: Anthropic Messages API and
 * any OpenAI-compatible Chat Completions API. Keys are read server-side only.
 */
export type Poster = (url: string, body: string, headers: Record<string, string>, timeoutMs: number) => Promise<{ ok: boolean; status: number; text: string }>;

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface AiProvider {
  name: "anthropic" | "openai-compatible";
  model: string;
  complete(system: string, messages: ChatMessage[], maxTokens: number): Promise<string>;
}

export const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-5-5";

export function aiConfigStatus(): { configured: boolean; provider: string | null; model: string | null; reason?: string } {
  const key = process.env.AI_API_KEY;
  const provider = (process.env.AI_PROVIDER ?? "anthropic").toLowerCase();
  if (!key) return { configured: false, provider: null, model: null, reason: "AI_API_KEY is not set." };
  if (provider === "anthropic") return { configured: true, provider, model: process.env.AI_MODEL || DEFAULT_ANTHROPIC_MODEL };
  if (provider === "openai" || provider === "openai-compatible") {
    if (!process.env.AI_MODEL) return { configured: false, provider, model: null, reason: "AI_MODEL must be set for OpenAI-compatible providers." };
    const base = process.env.AI_BASE_URL ?? "https://api.openai.com/v1";
    if (!base.startsWith("https://")) return { configured: false, provider, model: null, reason: "AI_BASE_URL must use https." };
    return { configured: true, provider: "openai-compatible", model: process.env.AI_MODEL };
  }
  return { configured: false, provider, model: null, reason: `Unknown AI_PROVIDER "${provider}". Use "anthropic" or "openai".` };
}

function fail(provider: string, status: number, text: string): never {
  // Log status only; upstream error bodies can echo request content.
  console.error(`[unwrap] AI provider ${provider} returned HTTP ${status}`);
  void text;
  if (status === 401 || status === 403) throw new AppError("AI_FAILED", "The AI provider rejected the configured credentials.");
  if (status === 429) throw new AppError("AI_FAILED", "The AI provider is rate-limiting requests. Try again in a minute.");
  throw new AppError("AI_FAILED", `The AI provider returned an error (HTTP ${status}).`);
}

export function getAiProvider(post: Poster): AiProvider | null {
  const status = aiConfigStatus();
  if (!status.configured) return null;
  const key = process.env.AI_API_KEY!;
  const model = status.model!;
  if (status.provider === "anthropic") {
    return {
      name: "anthropic",
      model,
      async complete(system, messages, maxTokens) {
        const res = await post(
          "https://api.anthropic.com/v1/messages",
          JSON.stringify({ model, max_tokens: maxTokens, system, messages, temperature: 0 }),
          { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
          60_000,
        );
        if (!res.ok) fail("anthropic", res.status, res.text);
        const body = JSON.parse(res.text) as { content?: { type: string; text?: string }[] };
        return (body.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
      },
    };
  }
  const base = (process.env.AI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, "");
  return {
    name: "openai-compatible",
    model,
    async complete(system, messages, maxTokens) {
      const res = await post(
        `${base}/chat/completions`,
        JSON.stringify({ model, max_tokens: maxTokens, temperature: 0, response_format: { type: "json_object" }, messages: [{ role: "system", content: system }, ...messages] }),
        { Authorization: `Bearer ${key}`, "content-type": "application/json" },
        60_000,
      );
      if (!res.ok) fail("openai-compatible", res.status, res.text);
      const body = JSON.parse(res.text) as { choices?: { message?: { content?: string } }[] };
      return body.choices?.[0]?.message?.content ?? "";
    },
  };
}
