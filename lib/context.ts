/**
 * Per-request context, carried with AsyncLocalStorage so the PayPal,
 * Channel3 and model clients can tag what they log without every function
 * passing a session around.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { AgentStep, Channel3Call, Mode, PayPalCall } from "./types";
import type { Tape } from "./replay/vcr";

export type StreamEvent =
  | { type: "step"; step: AgentStep }
  | { type: "paypal"; call: PayPalCall }
  | { type: "channel3"; call: Channel3Call }
  | { type: "status"; text: string; mood: string }
  | { type: "done"; ok: boolean; error?: string };

export type RequestContext = {
  sid: string;
  mode: Mode;
  /** The product feature that triggered the work, shown in Under the hood. */
  feature: string;
  /** Groups the steps of one agent turn. */
  turn: string;
  tape: { mode: "off" } | { mode: "record"; tape: Tape } | { mode: "replay"; tape: Tape; used: Set<number> };
  pending: { paypalCalls: PayPalCall[]; agentSteps: AgentStep[]; channel3Calls: Channel3Call[] };
  emit: ((ev: StreamEvent) => void) | null;
};

const als = new AsyncLocalStorage<RequestContext>();

export function newContext(input: Partial<RequestContext> & { sid: string; mode: Mode; feature: string }): RequestContext {
  return {
    turn: randomUUID().slice(0, 8),
    tape: { mode: "off" },
    pending: { paypalCalls: [], agentSteps: [], channel3Calls: [] },
    emit: null,
    ...input,
  };
}

export function runWithContext<T>(c: RequestContext, fn: () => Promise<T>): Promise<T> {
  return als.run(c, fn);
}

/** The current context, or a throwaway one for scripts and tests. */
export function ctx(): RequestContext {
  return als.getStore() ?? fallback;
}

const fallback: RequestContext = newContext({ sid: "script", mode: "live", feature: "script" });

/** Runs fn with a different feature label for the calls it makes. */
export function withFeature<T>(feature: string, fn: () => Promise<T>): Promise<T> {
  const c = ctx();
  const prev = c.feature;
  c.feature = feature;
  return fn().finally(() => {
    c.feature = prev;
  });
}

export function logPayPalCall(call: Omit<PayPalCall, "id" | "at" | "feature" | "replay"> & { feature?: string }): PayPalCall {
  const c = ctx();
  const full: PayPalCall = {
    id: randomUUID().slice(0, 12),
    at: new Date().toISOString(),
    feature: call.feature ?? c.feature,
    replay: c.tape.mode === "replay",
    ...call,
  };
  full.feature = call.feature ?? c.feature;
  c.pending.paypalCalls.push(full);
  c.emit?.({ type: "paypal", call: full });
  return full;
}

export function logStep(step: Omit<AgentStep, "id" | "at" | "turn">): AgentStep {
  const c = ctx();
  const full: AgentStep = { id: randomUUID().slice(0, 12), at: new Date().toISOString(), turn: c.turn, ...step };
  c.pending.agentSteps.push(full);
  c.emit?.({ type: "step", step: full });
  return full;
}

export function logChannel3Call(call: Omit<Channel3Call, "id" | "at">): Channel3Call {
  const c = ctx();
  const full: Channel3Call = { id: randomUUID().slice(0, 12), at: new Date().toISOString(), ...call };
  c.pending.channel3Calls.push(full);
  c.emit?.({ type: "channel3", call: full });
  return full;
}

export function status(text: string, mood: string = "thinking"): void {
  ctx().emit?.({ type: "status", text, mood });
}
