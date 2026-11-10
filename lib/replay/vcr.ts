/**
 * Record and replay for the three outside services (PayPal, Channel3, the
 * model). Live is the default. When a scenario is recorded, every outside
 * response is written to a tape under fixtures/replay/. In Replay mode the
 * same application code runs, but each outside call is answered from the
 * tape. The policy check, the ledger and the UI are never faked.
 */
import { ctx } from "../context";

export type Service = "paypal" | "channel3" | "llm";

export type Exchange = {
  svc: Service;
  /** Operation name, for example "orders.create" or "chat:pick". */
  op: string;
  res: unknown;
};

export type Tape = {
  scenario: string;
  recordedAt: string;
  note: string;
  exchanges: Exchange[];
};

export class ReplayMiss extends Error {
  constructor(
    public svc: Service,
    public op: string,
  ) {
    super(`Replay mode has no recorded ${svc} response for "${op}" in this step.`);
  }
}

const REPLAY_PACE_MS = process.env.NODE_ENV === "test" ? 0 : 280;

export function isReplay(): boolean {
  return ctx().tape.mode === "replay";
}

/**
 * Wraps one outside call. `live` must return plain JSON data.
 */
export async function external<T>(svc: Service, op: string, live: () => Promise<T>): Promise<T> {
  const t = ctx().tape;
  if (t.mode === "off") return live();
  if (t.mode === "record") {
    const res = await live();
    t.tape.exchanges.push({ svc, op, res: JSON.parse(JSON.stringify(res ?? null)) });
    return res;
  }
  const idx = t.tape.exchanges.findIndex((e, i) => !t.used.has(i) && e.svc === svc && e.op === op);
  if (idx === -1) throw new ReplayMiss(svc, op);
  t.used.add(idx);
  // A short pause per recorded call, so the steps can be followed on screen.
  if (REPLAY_PACE_MS > 0) await new Promise((r) => setTimeout(r, REPLAY_PACE_MS));
  return JSON.parse(JSON.stringify(t.tape.exchanges[idx].res)) as T;
}

export function newTape(scenario: string, note: string): Tape {
  return { scenario, recordedAt: new Date().toISOString(), note, exchanges: [] };
}
