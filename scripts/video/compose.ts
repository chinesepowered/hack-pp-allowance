/**
 * Step 3 of the demo video: narrate and compose.
 *
 *   pnpm video:compose      after `pnpm video:record` and cards.ts
 *
 * Reads demo/raw/main.webm, popup.webm and marks.json, the cards in
 * demo/raw/cards/, narrates each scene with ElevenLabs (cached, counted in
 * demo/elevenlabs-usage.json), and writes:
 *
 *   demo/video.mp4       1920x1080 H.264, under three minutes
 *   demo/narration.txt   the narration, scene by scene
 *
 * No music. Kip's lines are the pre-rendered files in public/audio/.
 */
import "../lib/load-env";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { KIP_VOICE, MODEL, NARRATOR_VOICE, readUsage, speak } from "../lib/tts";

const ROOT = process.cwd();
const RAW = path.join(ROOT, "demo", "raw");
const WORK = path.join(RAW, "work");
const AUDIO = path.join(RAW, "audio");
const FPS = 30;

type Marks = { main: Record<string, number>; popup: Record<string, number> };
const marks = JSON.parse(readFileSync(path.join(RAW, "marks.json"), "utf8")) as Marks;
const M = marks.main;
const P = marks.popup;

type Line = { id: string; text: string; voice: "narrator" } | { id: string; text: string; voice: "kip"; file: string };
type Part =
  | { type: "card"; png: string; fixed?: number; untilSentence?: { line: string; n: number } }
  | { type: "clip"; from: number; to: number; maxSpeed?: number }
  | { type: "popup"; from: number; to: number; speed: number; bgAt: number };
type Scene = { id: string; title: string; parts: Part[]; audio: Line[]; lead?: number; tail?: number };

const kip = (name: string, text: string): Line => ({ id: `kip-${name}`, text, voice: "kip", file: path.join(ROOT, "public", "audio", `kip-${name}.mp3`) });
const say = (id: string, text: string): Line => ({ id, text, voice: "narrator" });

const SCENES: Scene[] = [
  {
    id: "01-problem",
    title: "Cold open: the problem",
    parts: [
      // Shown until the narrator starts the fifth sentence ("Today a parent ...").
      { type: "card", png: "problem-1.png", fixed: 4.3, untilSentence: { line: "n01", n: 5 } },
      { type: "card", png: "problem-2.png" },
    ],
    audio: [say("n01", "A teenager needs things. Notebooks. Sneakers. A calculator. Today a parent has two bad options: hand over a card with no limits, or be asked before every single purchase.")],
  },
  {
    id: "02-intro",
    title: "What Allowance is, and who it is for",
    parts: [{ type: "card", png: "intro.png" }],
    audio: [say("n02", "Allowance is a shopping agent for teenagers, and for the parents who pay for their school things. It pays with the family's PayPal, but only inside rules a parent signs. Meet Kip."), kip("hello", "Hey, I'm Kip. What do you need?")],
  },
  {
    id: "03-save-paypal",
    title: "Dana saves her PayPal (Vault v3, JS SDK v6)",
    parts: [
      { type: "clip", from: M.setup_start - 0.4, to: M.paypal_click + 0.45 },
      { type: "popup", from: Math.max(0, P.login_visible - 0.3), to: P.consent_clicked + 0.9, speed: 2.1, bgAt: Math.max(0, M.paypal_click - 0.25) },
    ],
    audio: [say("n03", "Dana saves her PayPal once, in PayPal's own window. That is the Vault API: a setup token, then a payment token that stays on the server.")],
  },
  {
    id: "04-rules-to-mandate",
    title: "Plain-English rules become a signed mandate",
    parts: [{ type: "clip", from: M.vault_saved - 0.2, to: M.signed + 6.3, maxSpeed: 1.45 }],
    audio: [say("n04", "Then she writes the rules in plain English. The AI turns them into a structured mandate: a weekly budget, allowed and blocked categories, per item caps, and when to ask. A schema validates it, and Dana signs it. Change one rule later, and the signature breaks.")],
  },
  {
    id: "05-notebooks",
    title: "Request one: notebooks, paid at once",
    parts: [{ type: "clip", from: M.nb_click - 0.7, to: M.nb_paid + 4.0 }],
    audio: [
      say("n05a", "Leo, who is fifteen, asks Kip for notebooks. Kip searches real stores through Channel3, with the price cap taken from the mandate. Code checks the rules, and Kip pays at once with the saved PayPal. No popup."),
      kip("paid", "Done! It's inside the rules, so I paid."),
      say("n05b", "The receipt quotes the rule that allowed it."),
    ],
  },
  {
    id: "06-sneakers",
    title: "Request two: sneakers over the cap wait for Dana",
    parts: [{ type: "clip", from: M.sn_click - 0.5, to: M.ap_paid + 3.3, maxSpeed: 1.12 }],
    audio: [say("n06", "Sneakers around fifty-five dollars are over the forty dollar clothes cap, so Kip does not pay. Dana gets a card with Kip's reasoning and the exact rule. One tap, and PayPal captures the payment.")],
  },
  {
    id: "07-gaming",
    title: "Request three: a gaming gift card is blocked",
    parts: [{ type: "clip", from: M.gm_click - 0.5, to: M.gm_blocked + 4.0 }],
    audio: [say("n07", "A gaming gift card? Blocked, kindly, with the rule quoted. Nothing is searched, and nothing is charged.")],
  },
  {
    id: "08-under-the-hood",
    title: "Under the hood: PayPal calls and the agent trail",
    parts: [{ type: "clip", from: M.hood_paypal - 0.5, to: M.hood_channel3 + 3.0, maxSpeed: 1.0 }],
    audio: [say("n08", "Under the hood, every PayPal call is listed with its debug I D. The Agent Toolkit's create order tool is wrapped: the model can never reach it unless the mandate check passes in code.")],
  },
  {
    id: "09-undo-and-pause",
    title: "Undo (refund), the weekly note, and pause",
    parts: [{ type: "clip", from: M.ledger_view - 0.2, to: M.paused + 3.6, maxSpeed: 1.3 }],
    audio: [say("n09", "Dana can undo a purchase for twenty-four hours, which refunds it through PayPal. Kip writes her a weekly note from the ledger. And one switch pauses Kip at once.")],
  },
  {
    id: "10-limit",
    title: "One honest limitation",
    parts: [{ type: "clip", from: M.limit - 0.4, to: M.end }],
    audio: [say("n10", "One honest limit. In this prototype, Allowance charges the family's PayPal through its own sandbox merchant account, and the retailer order step is simulated.")],
  },
  {
    id: "11-end",
    title: "End card",
    parts: [{ type: "card", png: "end.png" }],
    audio: [say("n11", "Allowance. An agent that pays, inside your rules.")],
    tail: 1.6,
  },
];

function ff(args: string[]): void {
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { stdio: ["ignore", "pipe", "pipe"] });
}

function duration(file: string): number {
  return Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]).toString().trim());
}

/** Runs ffmpeg and returns what it wrote to stderr (where its analysis filters report). */
function probe(args: string[]): string {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-nostats", ...args, "-f", "null", "-"], { encoding: "utf8" });
  return r.stderr ?? "";
}

/** The pauses inside a spoken line: where each one starts and ends, in seconds. */
function pauses(file: string): { start: number; end: number }[] {
  const log = probe(["-i", file, "-af", "silencedetect=noise=-34dB:d=0.22"]);
  const starts = [...log.matchAll(/silence_start: ([\d.]+)/g)].map((m) => Number(m[1]));
  const ends = [...log.matchAll(/silence_end: ([\d.]+)/g)].map((m) => Number(m[1]));
  return starts.map((start, i) => ({ start, end: ends[i] ?? start })).filter((p) => p.start > 0.15 && p.end > p.start);
}

/** Mean level in dB of one stretch of an audio or video file. */
function level(file: string, from: number, length: number): number {
  const log = probe(["-ss", Math.max(0, from).toFixed(3), "-t", length.toFixed(3), "-i", file, "-vn", "-af", "volumedetect"]);
  const m = log.match(/mean_volume: (-?[\d.]+) dB/);
  return m ? Number(m[1]) : -120;
}

function peak(file: string): number {
  const m = probe(["-i", file, "-vn", "-af", "volumedetect"]).match(/max_volume: (-?[\d.]+) dB/);
  return m ? Number(m[1]) : 0;
}

/** Where PayPal's login pages show the email, in window pixels. */
const EMAIL_BAND = { x: 16, y: 194, w: 536, h: 82 };

const ENC = ["-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-pix_fmt", "yuv420p", "-r", String(FPS)];

async function popupChrome(w: number, h: number, file: string): Promise<void> {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    const left = Math.round((1920 - w) / 2);
    await page.setContent(`<!doctype html><html><body style="margin:0;background:transparent;font-family:system-ui,sans-serif">
      <div style="position:absolute;left:${left - 16}px;top:${96 - 16}px;width:${w + 32}px;height:${h + 32 + 54}px;background:#fff;border-radius:22px;box-shadow:0 30px 80px rgba(0,0,0,.45)"></div>
      <div style="position:absolute;left:${left}px;top:${96 + h + 8}px;width:${w}px;text-align:center;font-weight:650;font-size:22px;color:#1c2530">PayPal's own window, sandbox buyer login</div>
      </body></html>`);
    await page.screenshot({ path: file, omitBackground: true });
  } finally {
    await browser.close();
  }
}

async function buildPart(sceneId: string, idx: number, part: Part, hold: number, speedOverride?: number): Promise<{ file: string; dur: number }> {
  const file = path.join(WORK, `${sceneId}-p${idx}.mp4`);
  if (part.type === "card") {
    const dur = (part.fixed ?? 0) + hold;
    ff(["-loop", "1", "-framerate", String(FPS), "-t", dur.toFixed(3), "-i", path.join(RAW, "cards", part.png), "-vf", `scale=1920:1080,format=yuv420p${idx === 0 ? ",fade=t=in:st=0:d=0.3" : ""}`, ...ENC, file]);
    return { file, dur };
  }
  if (part.type === "clip") {
    const speed = speedOverride ?? 1;
    const src = part.to - part.from;
    ff(["-ss", part.from.toFixed(3), "-t", src.toFixed(3), "-i", path.join(RAW, "main.webm"), "-vf", `setpts=PTS/${speed.toFixed(4)},fps=${FPS},scale=1920:1080:flags=lanczos,tpad=stop_mode=clone:stop_duration=${hold.toFixed(3)}`, ...ENC, file]);
    return { file, dur: src / speed + hold };
  }
  // The PayPal window, shown over a dimmed frame of the app it was opened from.
  const bg = path.join(WORK, `${sceneId}-bg.png`);
  const chrome = path.join(WORK, `${sceneId}-chrome.png`);
  ff(["-ss", part.bgAt.toFixed(3), "-i", path.join(RAW, "main.webm"), "-frames:v", "1", bg]);
  const targetH = 860;
  const targetW = Math.round(((P.width || 500) * targetH) / (P.height || 700) / 2) * 2;
  await popupChrome(targetW, targetH, chrome);
  const src = part.to - part.from;
  const dur = src / part.speed + hold;
  ff([
    "-loop", "1", "-framerate", String(FPS), "-i", bg,
    "-ss", part.from.toFixed(3), "-t", src.toFixed(3), "-i", path.join(RAW, "popup.webm"),
    "-loop", "1", "-framerate", String(FPS), "-i", chrome,
    "-filter_complex",
    // The login pages show the sandbox buyer's email in one band of the
    // window. Blur that band until the consent page appears.
    `[0:v]scale=1920:1080,boxblur=10:2,eq=brightness=-0.22[bg];[1:v]crop=${P.width || 500}:${P.height || 700}:0:0,split[pa][pb];[pb]crop=${EMAIL_BAND.w}:${EMAIL_BAND.h}:${EMAIL_BAND.x}:${EMAIL_BAND.y},boxblur=12:4[blur];[pa][blur]overlay=${EMAIL_BAND.x}:${EMAIL_BAND.y}:enable='lt(t,${Math.max(0, P.consent_clicked - 0.9 - part.from).toFixed(2)})'[pm];[pm]scale=${targetW}:${targetH}:flags=lanczos,setpts=PTS/${part.speed},fps=${FPS},tpad=stop_mode=clone:stop_duration=${(hold + 1).toFixed(3)}[pp];[bg][2:v]overlay=0:0[b2];[b2][pp]overlay=${Math.round((1920 - targetW) / 2)}:96[v]`,
    "-map", "[v]", "-t", dur.toFixed(3), ...ENC, file,
  ]);
  return { file, dur };
}

async function main() {
  mkdirSync(WORK, { recursive: true });
  mkdirSync(AUDIO, { recursive: true });
  for (const need of ["main.webm", "popup.webm", "cards/intro.png"]) if (!existsSync(path.join(RAW, need))) throw new Error(`Missing demo/raw/${need}. Run pnpm video:record and scripts/video/cards.ts first.`);

  /* 1. narration */
  const audioFile = new Map<string, string>();
  for (const scene of SCENES) {
    for (const line of scene.audio) {
      if (line.voice === "kip") {
        audioFile.set(line.id, line.file);
        continue;
      }
      const out = path.join(AUDIO, `${line.id}.mp3`);
      const r = await speak({ text: line.text, voice: NARRATOR_VOICE, out, stability: 0.55, style: 0.1 });
      if (r.generated) console.log(`narrated ${line.id} (${r.chars} characters)`);
      audioFile.set(line.id, out);
    }
  }

  // Cards that wait for a sentence get their length from the audio itself,
  // so the picture stays in step whichever voice reads the line.
  for (const scene of SCENES) {
    for (const part of scene.parts) {
      if (part.type !== "card" || !part.untilSentence) continue;
      const found = pauses(audioFile.get(part.untilSentence.line)!);
      const gap = found[part.untilSentence.n - 2];
      if (gap) {
        part.fixed = (scene.lead ?? 0.4) + gap.end - 0.12;
        console.log(`${part.png} is shown for ${part.fixed.toFixed(2)} s (sentence ${part.untilSentence.n} of ${part.untilSentence.line} starts at ${gap.end.toFixed(2)} s)`);
      } else console.log(`${part.png}: could not find sentence ${part.untilSentence.n}, keeping ${part.fixed} s`);
    }
  }

  /* 2. scenes */
  const sceneFiles: string[] = [];
  const cues: { file: string; at: number; volume: number; id: string; sceneEnd: number }[] = [];
  const report: string[] = [];
  let t = 0;
  for (const scene of SCENES) {
    const lead = scene.lead ?? 0.4;
    const tail = scene.tail ?? 0.55;
    let cursor = lead;
    const local: { file: string; at: number; volume: number; id: string }[] = [];
    for (const line of scene.audio) {
      const file = audioFile.get(line.id)!;
      local.push({ file, at: cursor, volume: line.voice === "kip" ? 0.95 : 1, id: line.id });
      cursor += duration(file) + (line.voice === "kip" ? 0.3 : 0.25);
    }
    const audioNeed = cursor + tail;

    // How long would the picture run on its own?
    const natural = scene.parts.map((p) => (p.type === "card" ? (p.fixed ?? 0) : p.type === "clip" ? p.to - p.from : (p.to - p.from) / p.speed));
    const flexible = scene.parts.length - 1;
    const last = scene.parts[flexible];
    const fixedTotal = natural.slice(0, flexible).reduce((a, b) => a + b, 0);
    let speed = 1;
    if (last.type === "clip") {
      const room = Math.max(1, audioNeed - fixedTotal);
      // If the footage runs much longer than the narration, speed it up a little.
      if (natural[flexible] > room + 0.8) speed = Math.min(last.maxSpeed ?? 1.35, natural[flexible] / room);
    }
    const lastNatural = last.type === "clip" ? natural[flexible] / speed : natural[flexible];
    const sceneDur = Math.max(fixedTotal + lastNatural, audioNeed);
    const hold = sceneDur - fixedTotal - lastNatural;

    const partFiles: string[] = [];
    for (let i = 0; i < scene.parts.length; i++) {
      const isLast = i === flexible;
      const built = await buildPart(scene.id, i, scene.parts[i], isLast ? hold : 0, isLast && last.type === "clip" ? speed : undefined);
      partFiles.push(built.file);
    }
    const sceneFile = path.join(WORK, `${scene.id}.mp4`);
    const list = path.join(WORK, `${scene.id}.txt`);
    writeFileSync(list, partFiles.map((f) => `file '${f}'`).join("\n") + "\n");
    ff(["-f", "concat", "-safe", "0", "-i", list, "-c", "copy", sceneFile]);
    const real = duration(sceneFile);
    for (const cue of local) cues.push({ ...cue, at: t + cue.at, sceneEnd: t + real });
    report.push(`${scene.id.padEnd(22)} ${t.toFixed(1).padStart(6)}s  +${real.toFixed(1)}s  speed ${speed.toFixed(2)}  hold ${hold.toFixed(1)}s`);
    sceneFiles.push(sceneFile);
    t += real;
  }
  console.log(report.join("\n"));
  console.log(`total ${t.toFixed(1)} s`);
  if (t >= 178) throw new Error(`The video would be ${t.toFixed(1)} s. It must stay under three minutes.`);

  /* 3. picture */
  const all = path.join(WORK, "all.txt");
  writeFileSync(all, sceneFiles.map((f) => `file '${f}'`).join("\n") + "\n");
  const picture = path.join(WORK, "picture.mp4");
  ff(["-f", "concat", "-safe", "0", "-i", all, "-c", "copy", picture]);

  /* 4. sound: every cue at its place, mixed once, then levelled */
  const inputs: string[] = [];
  const chains: string[] = [];
  cues.forEach((cue, i) => {
    inputs.push("-i", cue.file);
    const ms = Math.round(cue.at * 1000);
    chains.push(`[${i}:a]aresample=44100,aformat=channel_layouts=stereo,volume=${cue.volume},adelay=${ms}|${ms}[a${i}]`);
  });
  const sound = path.join(WORK, "sound.m4a");
  ff([
    ...inputs,
    "-filter_complex",
    `${chains.join(";")};${cues.map((_, i) => `[a${i}]`).join("")}amix=inputs=${cues.length}:duration=longest:normalize=0,apad=whole_dur=${t.toFixed(3)},loudnorm=I=-16:TP=-1.5:LRA=11[out]`,
    "-map", "[out]", "-t", t.toFixed(3), "-c:a", "aac", "-b:a", "160k", "-ar", "44100", sound,
  ]);

  /* 5. final file */
  const out = path.join(ROOT, "demo", "video.mp4");
  ff(["-i", picture, "-i", sound, "-map", "0:v", "-map", "1:a", "-c:v", "libx264", "-preset", "slow", "-crf", process.env.VIDEO_CRF ?? "23", "-pix_fmt", "yuv420p", "-r", String(FPS), "-c:a", "copy", "-movflags", "+faststart", "-shortest", out]);
  const mb = statSync(out).size / 1024 / 1024;
  console.log(`demo/video.mp4: ${duration(out).toFixed(1)} s, ${mb.toFixed(1)} MB`);
  if (mb >= 50) throw new Error("The video is over 50 MB. Re-run with VIDEO_CRF=26.");

  /* 6. check that every spoken line is whole */
  const total = duration(out);
  const problems: string[] = [];
  let previousEnd = 0;
  for (const cue of cues) {
    const length = duration(cue.file);
    const end = cue.at + length;
    // The source file must fade out on its own, not stop mid-word.
    if (level(cue.file, Math.max(0, length - 0.06), 0.06) > -32) problems.push(`${cue.id}: the generated audio ends abruptly`);
    if (cue.at < previousEnd - 0.01) problems.push(`${cue.id}: starts before the previous line has finished`);
    if (end > cue.sceneEnd - 0.2) problems.push(`${cue.id}: runs past the end of its scene`);
    if (end > total - 0.2) problems.push(`${cue.id}: runs past the end of the video`);
    // The last half second of the line must be audible in the finished mix.
    const tailInSource = level(cue.file, Math.max(0, length - 0.7), 0.5);
    const tailInVideo = level(out, Math.max(0, end - 0.7), 0.5);
    if (tailInSource > -45 && tailInVideo < tailInSource - 14) problems.push(`${cue.id}: its ending is missing from the mix (${tailInVideo.toFixed(1)} dB against ${tailInSource.toFixed(1)} dB)`);
    previousEnd = end;
  }
  const top = peak(out);
  if (top > -1) problems.push(`the mix peaks at ${top.toFixed(1)} dB, which risks clipping`);
  if (total >= 180) problems.push(`the video is ${total.toFixed(1)} s, not under three minutes`);
  if (problems.length > 0) throw new Error("Audio check failed:\n  " + problems.join("\n  "));
  console.log(`audio check: all ${cues.length} lines are complete, none overlap, peak ${top.toFixed(1)} dB, last line ends ${(total - previousEnd).toFixed(1)} s before the end`);

  /* 7. the narration as text */
  const usage = readUsage();
  const text = [
    "Allowance: demo video narration",
    `Narrator: ElevenLabs premade voice ${NARRATOR_VOICE} (Jessica), model ${MODEL}.`,
    `Kip: ElevenLabs premade voice ${KIP_VOICE} (Will), model ${MODEL}. These are the same pre-rendered lines the app plays.`,
    "No music.",
    "",
    ...SCENES.flatMap((s) => [`[${s.id}] ${s.title}`, ...s.audio.map((l) => `${l.voice === "kip" ? "KIP" : "NARRATOR"}: ${l.text}`), ""]),
    `ElevenLabs characters used by this build so far: ${usage.total} of ${usage.budget}.`,
    "",
  ].join("\n");
  writeFileSync(path.join(ROOT, "demo", "narration.txt"), text);
  console.log("wrote demo/narration.txt");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    if (e && typeof e === "object" && "stderr" in e) console.error(String((e as { stderr: Buffer }).stderr).slice(0, 1500));
    process.exit(1);
  });
