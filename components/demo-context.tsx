"use client";

/**
 * Client-side state for the demo: one polled snapshot of the session plus
 * the actions the teen and the parent can take.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { StreamEvent } from "@/lib/context";
import type { ClientState } from "@/lib/session";
import type { AgentStep, Mode, Rule } from "@/lib/types";

export type DraftResult = { draft: { rules: Rule[]; weeklyBudget: number; expiresInDays: number; unclear: string[] }; model: string; ms: number };

type Working = { status: string; mood: string; steps: AgentStep[]; pendingText: string | null; pendingImage: string | null } | null;

type Demo = {
  state: ClientState | null;
  loadError: string | null;
  working: Working;
  busy: string | null;
  notice: { tone: "ok" | "error"; text: string } | null;
  clearNotice(): void;
  refresh(sync?: boolean): Promise<void>;
  send(text: string, opts?: { slug?: string | null; image?: { base64: string; mime: string } | null }): Promise<void>;
  approve(id: string, action: "approve" | "decline" | "approve_and_add_rule"): Promise<void>;
  undo(id: string): Promise<void>;
  pause(paused: boolean): Promise<void>;
  draftMandate(rulesText: string): Promise<DraftResult | null>;
  signMandate(rulesText: string, draft: DraftResult["draft"]): Promise<boolean>;
  writeSummary(): Promise<void>;
  session(action: "reset" | "fresh"): Promise<void>;
  setMode(mode: Mode): Promise<void>;
  vaultSetupToken(): Promise<string>;
  vaultFinish(setupTokenId: string): Promise<boolean>;
  safe: boolean;
  sound: boolean;
  setSound(on: boolean): void;
};

const Ctx = createContext<Demo | null>(null);

export function useDemo(): Demo {
  const d = useContext(Ctx);
  if (!d) throw new Error("useDemo must be used inside DemoProvider");
  return d;
}

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) }, cache: "no-store" });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string; issues?: string[] };
  if (!res.ok) throw new Error([data.error ?? `Request failed (${res.status})`, ...(data.issues ?? [])].join(" "));
  return data;
}

/** ?safe=1 turns on recording mode (store and brand names masked); ?safe=0 turns it off. */
function readSafeFlag(): boolean {
  if (typeof window === "undefined") return false;
  const param = new URLSearchParams(window.location.search).get("safe");
  if (param === "1") window.localStorage.setItem("alw_safe", "1");
  if (param === "0") window.localStorage.removeItem("alw_safe");
  return window.localStorage.getItem("alw_safe") === "1";
}

function readSoundFlag(): boolean {
  return typeof window !== "undefined" && window.localStorage.getItem("alw_sound") === "1";
}

export function DemoProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ClientState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [working, setWorking] = useState<Working>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Demo["notice"]>(null);
  const [safe] = useState(readSafeFlag);
  const [sound, setSoundState] = useState(readSoundFlag);
  const revRef = useRef<string>("");
  const workingRef = useRef(false);
  const busyRef = useRef(false);

  const apply = useCallback((s: ClientState) => {
    const key = `${s.mode}:${s.sid}:${s.rev}`;
    if (key !== revRef.current) {
      revRef.current = key;
      setState(s);
    }
  }, []);

  const refresh = useCallback(
    async (sync = false) => {
      try {
        const { state: s } = await call<{ state: ClientState }>(`/api/state${sync ? "?sync=1" : ""}`);
        apply(s);
        setLoadError(null);
      } catch (err) {
        setLoadError((err as Error).message);
      }
    },
    [apply],
  );

  useEffect(() => {
    // First load re-reads money state from PayPal, then a light poll keeps
    // both roles in step (the parent sees new requests, the teen sees answers).
    const first = window.setTimeout(() => void refresh(true), 0);
    const t = window.setInterval(() => {
      if (document.visibilityState === "visible" && !workingRef.current && !busyRef.current) void refresh(false);
    }, 3500);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(t);
    };
  }, [refresh]);

  const run = useCallback(
    async <T,>(label: string, fn: () => Promise<T>, okText?: string): Promise<T | null> => {
      setBusy(label);
      busyRef.current = true;
      setNotice(null);
      try {
        const out = await fn();
        if (okText) setNotice({ tone: "ok", text: okText });
        return out;
      } catch (err) {
        setNotice({ tone: "error", text: (err as Error).message });
        await refresh(false);
        return null;
      } finally {
        busyRef.current = false;
        setBusy(null);
      }
    },
    [refresh],
  );

  const send = useCallback<Demo["send"]>(
    async (text, opts) => {
      if (workingRef.current) return;
      workingRef.current = true;
      setNotice(null);
      const pendingImage = opts?.image ? `data:${opts.image.mime};base64,${opts.image.base64}` : null;
      setWorking({ status: "Kip is thinking", mood: "thinking", steps: [], pendingText: text || "Something like this", pendingImage });
      try {
        const res = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, slug: opts?.slug ?? null, image: opts?.image ?? null }) });
        if (!res.ok || !res.body) {
          const data = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(data.error ?? `Kip could not answer (${res.status}).`);
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let nl: number;
          while ((nl = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            if (!line) continue;
            let ev: StreamEvent;
            try {
              ev = JSON.parse(line) as StreamEvent;
            } catch {
              continue;
            }
            if (ev.type === "status") setWorking((w) => (w ? { ...w, status: ev.text, mood: ev.mood } : w));
            else if (ev.type === "step") setWorking((w) => (w ? { ...w, steps: [...w.steps, ev.step] } : w));
            else if (ev.type === "done" && !ev.ok) setNotice({ tone: "error", text: ev.error ?? "Kip could not finish that." });
          }
        }
      } catch (err) {
        setNotice({ tone: "error", text: (err as Error).message });
      } finally {
        await refresh(false);
        workingRef.current = false;
        setWorking(null);
      }
    },
    [refresh],
  );

  const value = useMemo<Demo>(
    () => ({
      state,
      loadError,
      working,
      busy,
      notice,
      clearNotice: () => setNotice(null),
      refresh,
      send,
      approve: async (id, action) => {
        const r = await run(`approval:${id}:${action}`, () => call<{ state: ClientState }>(`/api/approvals/${id}`, { method: "POST", body: JSON.stringify({ action }) }));
        if (r) apply(r.state);
      },
      undo: async (id) => {
        const r = await run(`undo:${id}`, () => call<{ state: ClientState }>(`/api/ledger/${id}/undo`, { method: "POST" }), "Refunded through PayPal.");
        if (r) apply(r.state);
      },
      pause: async (paused) => {
        const r = await run("pause", () => call<{ state: ClientState }>("/api/mandate/pause", { method: "POST", body: JSON.stringify({ paused }) }));
        if (r) apply(r.state);
      },
      draftMandate: (rulesText) => run("draft", () => call<DraftResult>("/api/mandate/draft", { method: "POST", body: JSON.stringify({ rulesText }) })),
      signMandate: async (rulesText, draft) => {
        const r = await run("sign", () => call<{ state: ClientState }>("/api/mandate/sign", { method: "POST", body: JSON.stringify({ rulesText, rules: draft.rules, expiresInDays: draft.expiresInDays }) }), "Mandate signed.");
        if (r) apply(r.state);
        return Boolean(r);
      },
      writeSummary: async () => {
        const r = await run("summary", () => call<{ state: ClientState }>("/api/summary", { method: "POST" }));
        if (r) apply(r.state);
      },
      session: async (action) => {
        const r = await run(`session:${action}`, () => call<{ state: ClientState }>("/api/session", { method: "POST", body: JSON.stringify({ action }) }), action === "reset" ? "Demo family restored." : "Started with an empty family.");
        if (r) apply(r.state);
      },
      setMode: async (mode) => {
        const r = await run("mode", () => call<{ state: ClientState }>("/api/session", { method: "POST", body: JSON.stringify({ action: "mode", mode }) }));
        if (r) apply(r.state);
      },
      vaultSetupToken: async () => (await call<{ id: string }>("/api/paypal/vault/setup-token", { method: "POST" })).id,
      vaultFinish: async (setupTokenId) => {
        const r = await run("vault", () => call<{ state: ClientState }>("/api/paypal/vault/payment-token", { method: "POST", body: JSON.stringify({ setupTokenId }) }), "PayPal saved for Kip's purchases.");
        if (r) apply(r.state);
        return Boolean(r);
      },
      safe,
      sound,
      setSound: (on) => {
        setSoundState(on);
        if (on) window.localStorage.setItem("alw_sound", "1");
        else window.localStorage.removeItem("alw_sound");
      },
    }),
    [state, loadError, working, busy, notice, refresh, send, run, apply, safe, sound],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
