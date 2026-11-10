"use client";

/** Small shared pieces: tags, badges, money, time, and brand-safe text. */
import type { ReactNode } from "react";
import { useDemo } from "./demo-context";
import type { ClientState } from "@/lib/session";
import type { LedgerStatus, Outcome } from "@/lib/types";

export function usd(n: number | string): string {
  const v = typeof n === "string" ? Number(n) : n;
  return "$" + v.toFixed(2);
}

/** The small tag on every AI-written output, naming the model. */
export function AiTag({ model, className = "" }: { model: string | null | undefined; className?: string }) {
  const short = model ? model.split("/").pop() : "model";
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border border-[var(--color-line)] bg-[var(--color-sand)] px-2 py-0.5 align-middle text-[11px] font-semibold text-[var(--color-ink-2)] ${className}`}
      title={`Written by AI (${model ?? "model"}). Money decisions are made by code, not by the model.`}
    >
      <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
        <path d="M8 1l1.8 4.2L14 7l-4.2 1.8L8 13l-1.8-4.2L2 7l4.2-1.8z" fill="currentColor" />
      </svg>
      <span>
        AI<span className="sr-only">-written by</span> · {short}
      </span>
    </span>
  );
}

const OUTCOME: Record<Outcome, { label: string; cls: string }> = {
  auto_approved: { label: "Inside the rules", cls: "bg-[var(--color-ok-soft)] text-[var(--color-ok)]" },
  needs_approval: { label: "Needs a parent's OK", cls: "bg-[var(--color-ask-soft)] text-[var(--color-ask)]" },
  blocked: { label: "Blocked", cls: "bg-[var(--color-stop-soft)] text-[var(--color-stop)]" },
};

export function OutcomeBadge({ outcome, label }: { outcome: Outcome; label?: string }) {
  const o = OUTCOME[outcome];
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11.5px] font-bold ${o.cls}`}>{label ?? o.label}</span>;
}

const STATUS: Record<LedgerStatus, { label: string; cls: string }> = {
  paying: { label: "Paying", cls: "bg-[var(--color-info-soft)] text-[var(--color-info)]" },
  paid: { label: "Paid", cls: "bg-[var(--color-ok-soft)] text-[var(--color-ok)]" },
  refunded: { label: "Refunded", cls: "bg-[var(--color-info-soft)] text-[var(--color-info)]" },
  refund_pending: { label: "Refund in progress", cls: "bg-[var(--color-info-soft)] text-[var(--color-info)]" },
  pending_approval: { label: "Waiting for OK", cls: "bg-[var(--color-ask-soft)] text-[var(--color-ask)]" },
  declined: { label: "Declined", cls: "bg-[var(--color-sand)] text-[var(--color-ink-2)]" },
  blocked: { label: "Blocked", cls: "bg-[var(--color-stop-soft)] text-[var(--color-stop)]" },
  failed: { label: "Not charged", cls: "bg-[var(--color-sand)] text-[var(--color-ink-2)]" },
};

export function StatusBadge({ status }: { status: LedgerStatus }) {
  const s = STATUS[status];
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11.5px] font-bold ${s.cls}`}>{s.label}</span>;
}

export function timeAgo(iso: string, now: number = Date.now()): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  const d = Math.round(s / 86400);
  return d === 1 ? "yesterday" : `${d} days ago`;
}

export function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

export function Spinner({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5" role="status">
      <span className="flex gap-1" aria-hidden="true">
        <span className="dot h-1.5 w-1.5 rounded-full bg-current" />
        <span className="dot h-1.5 w-1.5 rounded-full bg-current" />
        <span className="dot h-1.5 w-1.5 rounded-full bg-current" />
      </span>
      <span>{label}</span>
    </span>
  );
}

/* ----------------------------- brand-safe display ----------------------------- */

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function storeAlias(domain: string): string {
  let h = 0;
  for (let i = 0; i < domain.length; i++) h = (h * 31 + domain.charCodeAt(i)) >>> 0;
  return `store ${String.fromCharCode(65 + (h % 26))}${(h >> 5) % 9 + 1}`;
}

function collect(state: ClientState | null): { stores: string[]; brands: string[] } {
  const stores = new Set<string>();
  const brands = new Set<string>();
  if (!state) return { stores: [], brands: [] };
  const addProduct = (p: { merchant?: string; brand?: string | null }) => {
    if (p.merchant && !p.merchant.endsWith(".example") && p.merchant.includes(".")) stores.add(p.merchant);
    if (p.brand) brands.add(p.brand);
  };
  for (const e of state.ledger) addProduct(e.product);
  for (const a of state.approvals) addProduct(a.product);
  for (const m of state.chat)
    for (const c of m.cards)
      if (c.type === "products")
        for (const p of c.products) {
          if (p.brand) brands.add(p.brand);
          for (const o of p.offers) if (o.domain.includes(".")) stores.add(o.domain);
        }
  for (const d of state.knownMerchants) if (!d.endsWith(".example") && d.includes(".")) stores.add(d);
  return { stores: [...stores].sort((a, b) => b.length - a.length), brands: [...brands].filter((b) => b.length > 2).sort((a, b) => b.length - a.length) };
}

/**
 * Recording mode (?safe=1): keeps other companies' names out of frame for
 * the demo video by replacing store domains with a neutral alias and
 * dropping brand names from titles. The live demo shows real names.
 */
export function useSafeText(): (text: string) => string {
  const { safe, state } = useDemo();
  if (!safe) return identity;
  const { stores, brands } = collect(state);
  const storeRe = stores.length > 0 ? new RegExp(stores.map(escapeRe).join("|"), "gi") : null;
  const brandRe = brands.length > 0 ? new RegExp(`(?:^|\\b)(?:${brands.map(escapeRe).join("|")})(?:[\u00ae\u2122]|'s)?\\s*`, "gi") : null;
  return (t: string) => {
    let out = t;
    if (storeRe) out = out.replace(storeRe, (m) => storeAlias(m.toLowerCase()));
    if (brandRe) out = out.replace(brandRe, "");
    out = out.replace(/[\u00ae\u2122]/g, "").replace(/\s{2,}/g, " ").trim();
    return out.length > 0 ? out.charAt(0).toUpperCase() + out.slice(1) : out;
  };
}

function identity(t: string): string {
  return t;
}

export function Empty({ title, children, kip }: { title: string; children?: ReactNode; kip?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 px-4 py-8 text-center text-[var(--color-ink-2)]">
      {kip}
      <p className="font-display text-base font-bold text-[var(--color-ink)]">{title}</p>
      {children ? <p className="max-w-sm text-sm">{children}</p> : null}
    </div>
  );
}
