/**
 * The model client. W&B Inference speaks the OpenAI API, so this uses the
 * OpenAI SDK with tool calling. Server-side only.
 *
 *  - maxRetries 4 and a 60 s timeout (about 1 call in 20 fails without retries)
 *  - after repeated failures the fallback model answers instead
 *  - the fallback model always returns a `reasoning` field and can return
 *    content: null, so it gets a bigger token budget and null is handled
 *
 * The model never decides anything about money. It proposes; code checks.
 */
import OpenAI from "openai";
import type { z } from "zod";
import { models, requireEnv } from "../env";
import { external } from "../replay/vcr";

export type ToolCall = { id: string; name: string; arguments: string };

export type LlmResult = {
  content: string;
  toolCalls: ToolCall[];
  model: string;
  ms: number;
  usedFallback: boolean;
  tokens: { prompt: number; completion: number } | null;
};

export type Msg =
  | { role: "system" | "user"; content: string | ContentPart[] }
  | { role: "assistant"; content: string | null; tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[] }
  | { role: "tool"; tool_call_id: string; content: string };

export type ContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

export type ToolDef = { type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } };

export type ChatParams = {
  messages: Msg[];
  tools?: ToolDef[];
  /** "required" makes the model call a tool instead of answering in text. */
  toolChoice?: "auto" | "required";
  json?: boolean;
  maxTokens?: number;
  temperature?: number;
  use?: "text" | "vision";
  /**
   * How much the model may think before answering. The text model is a
   * reasoning model: left alone it can spend its whole token budget on
   * reasoning and return no answer. "none" is right for labeling and short
   * notes, "low" for choosing and planning.
   */
  effort?: "none" | "low" | "medium";
};

let client: OpenAI | null = null;
function openai(): OpenAI {
  if (!client) {
    client = new OpenAI({ baseURL: requireEnv("OPENAI_BASE_URL"), apiKey: requireEnv("OPENAI_API_KEY"), maxRetries: 4, timeout: 60000 });
  }
  return client;
}

/** House style: no long dashes, no curly quotes, no stray thinking tags. */
const LONG_DASHES = new RegExp("\\s*[" + String.fromCharCode(0x2014, 0x2013) + "]\\s*", "g");
const CURLY_SINGLE = new RegExp("[" + String.fromCharCode(0x2018, 0x2019) + "]", "g");
const CURLY_DOUBLE = new RegExp("[" + String.fromCharCode(0x201c, 0x201d) + "]", "g");

export function tidy(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(LONG_DASHES, ", ")
    .replace(CURLY_SINGLE, "'")
    .replace(CURLY_DOUBLE, '"')
    .replace(/\*\*/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

async function once(model: string, p: ChatParams, maxTokens: number, effort: ChatParams["effort"] | null): Promise<Omit<LlmResult, "usedFallback">> {
  const t0 = Date.now();
  const res = await openai().chat.completions.create({
    model,
    messages: p.messages as never,
    ...(p.tools && p.tools.length > 0 ? { tools: p.tools as never, tool_choice: p.toolChoice ?? ("auto" as const) } : {}),
    ...(p.json ? { response_format: { type: "json_object" as const } } : {}),
    ...(effort ? { reasoning_effort: effort as never } : {}),
    max_tokens: maxTokens,
    temperature: p.temperature ?? 0.2,
  });
  const msg = res.choices?.[0]?.message;
  if (!msg) throw new Error("The model returned no message.");
  const toolCalls: ToolCall[] = (msg.tool_calls ?? [])
    .filter((t) => t.type === "function")
    .map((t) => {
      const f = (t as { function: { name: string; arguments: string } }).function;
      return { id: t.id, name: f.name, arguments: f.arguments || "{}" };
    });
  const content = typeof msg.content === "string" ? msg.content : "";
  if (content.trim().length === 0 && toolCalls.length === 0) throw new Error("The model returned an empty answer.");
  return {
    content: tidy(content),
    toolCalls,
    model: res.model ?? model,
    ms: Date.now() - t0,
    tokens: res.usage ? { prompt: res.usage.prompt_tokens, completion: res.usage.completion_tokens } : null,
  };
}

/**
 * One model turn. `purpose` names the job (shown in the reasoning trail and
 * used as the Replay key).
 */
export async function chat(purpose: string, p: ChatParams): Promise<LlmResult> {
  return external<LlmResult>("llm", `chat:${purpose}`, async () => {
    const m = models();
    const primary = p.use === "vision" ? m.vision : m.text;
    const budget = p.maxTokens ?? 700;
    const effort = p.use === "vision" ? null : (p.effort ?? "low");
    try {
      return { ...(await once(primary, p, budget, effort)), usedFallback: false };
    } catch (first) {
      if (p.use === "vision") throw first;
      // The SDK already retried four times. Hand over to the fallback
      // model, which always reasons first, so it gets a bigger budget.
      try {
        return { ...(await once(m.fallback, p, budget + 1500, null)), usedFallback: true };
      } catch {
        throw first;
      }
    }
  });
}

function extractJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new Error("The model did not return JSON.");
  }
}

/**
 * A model turn that must produce JSON matching a Zod schema. If the first
 * answer fails validation, the model gets one chance to fix it with the
 * validation errors in hand.
 */
export async function chatJson<S extends z.ZodType>(purpose: string, schema: S, p: Omit<ChatParams, "json" | "tools">): Promise<{ value: z.infer<S>; model: string; ms: number }> {
  let messages = p.messages;
  let lastError = "";
  let ms = 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await chat(attempt === 0 ? purpose : `${purpose}:repair`, { ...p, messages, json: true });
    ms += r.ms;
    try {
      const parsed = schema.safeParse(extractJson(r.content));
      if (parsed.success) return { value: parsed.data, model: r.model, ms };
      lastError = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    } catch (err) {
      lastError = (err as Error).message;
    }
    messages = [...p.messages, { role: "assistant", content: r.content }, { role: "user", content: `That JSON was not valid: ${lastError}. Reply again with corrected JSON only.` }];
  }
  throw new Error(`The model could not produce valid JSON for ${purpose}: ${lastError}`);
}
