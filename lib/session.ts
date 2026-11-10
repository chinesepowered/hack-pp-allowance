/**
 * Demo state. Every browser gets its own session (a cookie id), cloned from
 * the seeded template, so one judge's purchases never eat another judge's
 * weekly budget. The saved PayPal token is shared: it is Dana's sandbox
 * wallet, vaulted once by `pnpm seed`.
 *
 * Live and Replay keep separate documents, so switching modes never mixes
 * recorded PayPal ids with real ones.
 */
import { randomUUID } from "node:crypto";
import { ctx } from "./context";
import { DEFAULT_DRAFT, DEFAULT_RULES_TEXT, FAMILY } from "./demo/defaults";
import { budgetStatus, canUndo, knownMerchants, UNDO_WINDOW_MS } from "./mandate/policy";
import { buildMandateBody, normalizeDraft } from "./mandate/schema";
import { shortSignature, signMandate, verifyMandate } from "./mandate/sign";
import { store, update } from "./store";
import type { LedgerEntry, Mode, SessionState, SignedMandate, VaultInfo } from "./types";
import replayTemplate from "@/fixtures/replay/template.json";

export type TemplatePurchase = { ageHours: number; entry: LedgerEntry };
export type Template = { createdAt: string; vault: VaultInfo | null; purchases: TemplatePurchase[] };

const TEMPLATE_KEY = "global/template";
const CAPS = { paypalCalls: 150, agentSteps: 240, channel3Calls: 80, chat: 80, webhooks: 40, ledger: 120, approvals: 60, seen: 60 };

function sessionKey(sid: string, mode: Mode): string {
  return `s/${sid}/${mode}`;
}

export function newSid(): string {
  return randomUUID().replace(/-/g, "").slice(0, 20);
}

export async function getTemplate(mode: Mode): Promise<Template | null> {
  if (mode === "replay") return replayTemplate as unknown as Template;
  return store().get<Template>(TEMPLATE_KEY);
}

export async function saveTemplate(t: Template): Promise<void> {
  await store().set(TEMPLATE_KEY, t);
}

export function defaultMandate(now: Date = new Date()): SignedMandate {
  const n = normalizeDraft(DEFAULT_DRAFT);
  const body = buildMandateBody({
    id: "mnd_" + randomUUID().slice(0, 8),
    version: 1,
    rulesText: DEFAULT_RULES_TEXT,
    rules: n.rules,
    weeklyBudget: n.weeklyBudget,
    expiresInDays: n.expiresInDays,
    parent: FAMILY.parent,
    teen: FAMILY.teen,
    now,
  });
  return signMandate(body, FAMILY.parent.name, now);
}

function materialize(p: TemplatePurchase, now: Date, mandateVersion: number): LedgerEntry {
  const createdAt = new Date(now.getTime() - p.ageHours * 3600000).toISOString();
  return {
    ...p.entry,
    createdAt,
    undoUntil: new Date(Date.parse(createdAt) + UNDO_WINDOW_MS).toISOString(),
    decision: { ...p.entry.decision, evaluatedAt: createdAt, mandateVersion },
    seeded: true,
    replaySlug: null,
    events: [{ at: createdAt, text: "Paid by Kip with the saved PayPal (seeded demo purchase, a real sandbox capture)." }],
  };
}

export async function createSession(sid: string, mode: Mode, opts: { fresh?: boolean } = {}): Promise<SessionState> {
  const now = new Date();
  const template = opts.fresh ? null : await getTemplate(mode);
  const mandate = template ? defaultMandate(new Date(now.getTime() - 6 * 86400000)) : null;
  const state: SessionState = {
    sid,
    mode,
    rev: 1,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    family: FAMILY,
    vault: template?.vault ?? null,
    mandate,
    mandateHistory: mandate ? [{ version: 1, signedAt: mandate.signature.signedAt, digest: mandate.signature.digest, note: "Signed by Dana during setup." }] : [],
    paused: null,
    ledger: template && mandate ? template.purchases.map((p) => materialize(p, now, mandate.version)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)) : [],
    approvals: [],
    chat: [],
    paypalCalls: [],
    agentSteps: [],
    channel3Calls: [],
    webhooks: [],
    summary: null,
    seen: {},
  };
  await store().set(sessionKey(sid, mode), state);
  return state;
}

export async function loadSession(sid: string, mode: Mode): Promise<SessionState> {
  const s = await store().get<SessionState>(sessionKey(sid, mode));
  if (s) return s;
  return createSession(sid, mode);
}

function trim(s: SessionState): void {
  s.paypalCalls = s.paypalCalls.slice(-CAPS.paypalCalls);
  s.agentSteps = s.agentSteps.slice(-CAPS.agentSteps);
  s.channel3Calls = s.channel3Calls.slice(-CAPS.channel3Calls);
  s.chat = s.chat.slice(-CAPS.chat);
  s.webhooks = s.webhooks.slice(-CAPS.webhooks);
  s.ledger = s.ledger.slice(0, CAPS.ledger);
  s.approvals = s.approvals.slice(0, CAPS.approvals);
  const seen = Object.entries(s.seen ?? {}).sort((a, b) => b[1].seenAt.localeCompare(a[1].seenAt));
  s.seen = Object.fromEntries(seen.slice(0, CAPS.seen));
}

/** Moves the calls and steps logged during this request into the state. */
function drainPending(s: SessionState): void {
  const p = ctx().pending;
  if (ctx().sid !== s.sid) return;
  if (p.paypalCalls.length > 0) s.paypalCalls.push(...p.paypalCalls.splice(0));
  if (p.agentSteps.length > 0) s.agentSteps.push(...p.agentSteps.splice(0));
  if (p.channel3Calls.length > 0) s.channel3Calls.push(...p.channel3Calls.splice(0));
}

export async function mutateSession(sid: string, mode: Mode, fn: (s: SessionState) => void | Promise<void>): Promise<SessionState> {
  return update<SessionState>(sessionKey(sid, mode), async (doc) => {
    const s = doc ?? (await createSession(sid, mode));
    await fn(s);
    drainPending(s);
    trim(s);
    s.rev += 1;
    s.updatedAt = new Date().toISOString();
    return s;
  });
}

/** Writes any buffered log entries. Call at the end of a request. */
export async function flushLogs(): Promise<void> {
  const c = ctx();
  const p = c.pending;
  if (p.paypalCalls.length + p.agentSteps.length + p.channel3Calls.length === 0) return;
  await mutateSession(c.sid, c.mode, () => undefined);
}

export async function resetSession(sid: string, mode: Mode, opts: { fresh?: boolean } = {}): Promise<SessionState> {
  await store().del(sessionKey(sid, mode));
  return createSession(sid, mode, opts);
}

/* ----------------------------- capture index ----------------------------- */

type CaptureIndex = { sid: string; mode: Mode; ledgerId: string };

export async function indexCapture(captureId: string, ref: CaptureIndex): Promise<void> {
  await store().set(`idx/cap/${captureId}`, ref);
}

export async function findCapture(captureId: string): Promise<CaptureIndex | null> {
  return store().get<CaptureIndex>(`idx/cap/${captureId}`);
}

/* ----------------------------- client view ----------------------------- */

function maskEmail(email: string | null): string | null {
  if (!email) return null;
  const [user, domain] = email.split("@");
  if (!domain) return email;
  return `${user.slice(0, 2)}${"*".repeat(Math.max(3, user.length - 2))}@${domain}`;
}

/** What the browser gets. The vault token id never leaves the server. */
export function toClient(s: SessionState) {
  const now = new Date();
  const sig = s.mandate ? verifyMandate(s.mandate) : { ok: false, reason: "No mandate yet." };
  const budget = budgetStatus(s.mandate, s.ledger, now);
  return {
    sid: s.sid,
    mode: s.mode,
    rev: s.rev,
    updatedAt: s.updatedAt,
    family: s.family,
    vault: s.vault
      ? { saved: true as const, payerEmail: maskEmail(s.vault.payerEmail), payerName: s.vault.payerName, savedAt: s.vault.savedAt, source: s.vault.source, kind: s.vault.kind, tokenHint: "..." + s.vault.paymentTokenId.slice(-4) }
      : { saved: false as const },
    mandate: s.mandate,
    mandateCheck: { ...sig, short: s.mandate ? shortSignature(s.mandate) : null, expired: s.mandate ? Date.parse(s.mandate.expiresAt) <= now.getTime() : false },
    mandateHistory: s.mandateHistory,
    paused: s.paused,
    budget,
    knownMerchants: [...knownMerchants(s.mandate, s.ledger)].sort(),
    ledger: s.ledger.map((e) => ({ ...e, undo: canUndo(e, now) })),
    approvals: s.approvals,
    chat: s.chat,
    paypalCalls: s.paypalCalls,
    agentSteps: s.agentSteps,
    channel3Calls: s.channel3Calls,
    webhooks: s.webhooks,
    summary: s.summary,
    setupComplete: Boolean(s.vault && s.mandate),
  };
}

export type ClientState = ReturnType<typeof toClient>;
