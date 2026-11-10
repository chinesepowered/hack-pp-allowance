/**
 * ElevenLabs text to speech for the build pipeline only (Kip's in-product
 * voice lines and the video narration). The running app never calls it.
 *
 * Every generation is written to demo/elevenlabs-usage.json so the build's
 * character total stays visible. A line is only generated again when its
 * text or voice changed.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Narrator: Jessica, a young female premade voice. */
export const NARRATOR_VOICE = "cgSgspJ2msm6clMCkdW9";
/** Kip: Will, a relaxed young male premade voice, clearly different from the narrator. */
export const KIP_VOICE = "bIHbv24MWmeRgasZH58o";
export const MODEL = "eleven_multilingual_v2";
export const BUDGET = 15000;

const USAGE_FILE = path.join(process.cwd(), "demo", "elevenlabs-usage.json");

type Usage = { budget: number; total: number; items: { file: string; chars: number; voice: string; hash: string; at: string }[] };

export function readUsage(): Usage {
  if (!existsSync(USAGE_FILE)) return { budget: BUDGET, total: 0, items: [] };
  return JSON.parse(readFileSync(USAGE_FILE, "utf8")) as Usage;
}

function writeUsage(u: Usage) {
  mkdirSync(path.dirname(USAGE_FILE), { recursive: true });
  writeFileSync(USAGE_FILE, JSON.stringify(u, null, 1) + "\n");
}

export async function speak(opts: { text: string; voice: string; out: string; stability?: number; style?: number; speed?: number }): Promise<{ generated: boolean; chars: number }> {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) throw new Error("ELEVENLABS_API_KEY is not set.");
  const rel = path.relative(process.cwd(), opts.out);
  const hash = createHash("sha256").update(`${opts.voice}|${MODEL}|${opts.stability ?? ""}|${opts.style ?? ""}|${opts.speed ?? ""}|${opts.text}`).digest("hex").slice(0, 16);
  const usage = readUsage();
  const known = usage.items.find((i) => i.file === rel && i.hash === hash);
  if (known && existsSync(opts.out)) return { generated: false, chars: 0 };
  if (usage.total + opts.text.length > BUDGET) throw new Error(`ElevenLabs budget for this build would be exceeded (${usage.total} + ${opts.text.length} > ${BUDGET}).`);

  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${opts.voice}?output_format=mp3_44100_128`, {
    method: "POST",
    headers: { "xi-api-key": key, "Content-Type": "application/json", Accept: "audio/mpeg" },
    body: JSON.stringify({
      text: opts.text,
      model_id: MODEL,
      voice_settings: { stability: opts.stability ?? 0.5, similarity_boost: 0.8, style: opts.style ?? 0.2, use_speaker_boost: true, ...(opts.speed ? { speed: opts.speed } : {}) },
    }),
  });
  if (!res.ok) throw new Error(`ElevenLabs answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
  mkdirSync(path.dirname(opts.out), { recursive: true });
  writeFileSync(opts.out, Buffer.from(await res.arrayBuffer()));
  usage.items.push({ file: rel, chars: opts.text.length, voice: opts.voice, hash, at: new Date().toISOString() });
  usage.total = usage.items.reduce((sum, i) => sum + i.chars, 0);
  writeUsage(usage);
  return { generated: true, chars: opts.text.length };
}
