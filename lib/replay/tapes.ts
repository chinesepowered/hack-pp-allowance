/**
 * The recorded tapes for Replay mode. They are real sandbox and model
 * responses captured by `pnpm replay:record`, imported statically so they
 * ship with the build.
 */
import type { Tape } from "./vcr";
import approveSneakers from "@/fixtures/replay/approve-sneakers.json";
import chatGaming from "@/fixtures/replay/chat-gaming.json";
import chatNotebooks from "@/fixtures/replay/chat-notebooks.json";
import chatSneakers from "@/fixtures/replay/chat-sneakers.json";
import mandateDraft from "@/fixtures/replay/mandate-draft.json";
import summary from "@/fixtures/replay/summary.json";
import undoNotebooks from "@/fixtures/replay/undo-notebooks.json";
import vaultSave from "@/fixtures/replay/vault-save.json";

export const SCENARIOS = ["chat-notebooks", "chat-sneakers", "chat-gaming", "approve-sneakers", "undo-notebooks", "mandate-draft", "summary", "vault-save"] as const;
export type Scenario = (typeof SCENARIOS)[number];

const TAPES: Record<Scenario, Tape> = {
  "chat-notebooks": chatNotebooks as Tape,
  "chat-sneakers": chatSneakers as Tape,
  "chat-gaming": chatGaming as Tape,
  "approve-sneakers": approveSneakers as Tape,
  "undo-notebooks": undoNotebooks as Tape,
  "mandate-draft": mandateDraft as Tape,
  summary: summary as Tape,
  "vault-save": vaultSave as Tape,
};

export function isScenario(name: string): name is Scenario {
  return (SCENARIOS as readonly string[]).includes(name);
}

export function loadTape(name: string): Tape | null {
  if (!isScenario(name)) return null;
  const t = TAPES[name];
  return t && t.exchanges.length > 0 ? t : null;
}

export function tapeInfo(): { scenario: string; recordedAt: string; exchanges: number }[] {
  return SCENARIOS.map((s) => ({ scenario: s, recordedAt: TAPES[s].recordedAt, exchanges: TAPES[s].exchanges.length }));
}
