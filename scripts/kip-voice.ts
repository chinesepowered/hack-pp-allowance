/**
 * pnpm tsx scripts/kip-voice.ts
 *
 * Pre-renders Kip's short in-product voice lines into public/audio/, so
 * the hosted demo plays files and never calls ElevenLabs.
 */
import "./lib/load-env";
import path from "node:path";
import { KIP_VOICE, readUsage, speak } from "./lib/tts";

/** Keep these generic: they must fit any family, not only Dana and Leo. */
export const KIP_LINES: Record<string, string> = {
  hello: "Hey, I'm Kip. What do you need?",
  paid: "Done! It's inside the rules, so I paid.",
  ask: "This one needs a parent's OK. I've asked.",
  approved: "Approved! It's paid.",
  declined: "That one's a no this time.",
  blocked: "Sorry, the rules don't allow that one.",
  paused: "Spending is paused for now.",
  undo: "That purchase was undone and refunded.",
};

async function main() {
  for (const [name, text] of Object.entries(KIP_LINES)) {
    const out = path.join(process.cwd(), "public", "audio", `kip-${name}.mp3`);
    const r = await speak({ text, voice: KIP_VOICE, out, stability: 0.45, style: 0.35 });
    console.log(`${r.generated ? "generated" : "kept     "} kip-${name}.mp3  "${text}"`);
  }
  const u = readUsage();
  console.log(`ElevenLabs characters used by this build so far: ${u.total} of ${u.budget}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
