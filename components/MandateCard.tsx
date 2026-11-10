"use client";

/** The mandate as a readable card: numbered rules, version and signature. */
import { CATEGORY_LABEL } from "@/lib/mandate/categories";
import type { Rule, SignedMandate } from "@/lib/types";
import { usd } from "./ui";

function gloss(r: Rule): { tone: "ok" | "ask" | "stop" | "info"; label: string; detail: string } {
  switch (r.kind) {
    case "budget":
      return { tone: "info", label: "Weekly limit", detail: `${usd(r.weeklyLimit)} in any seven days` };
    case "allow":
      return { tone: "ok", label: "Kip can buy", detail: `${r.categories.map((c) => CATEGORY_LABEL[c].toLowerCase()).join(", ")}${r.perItemCap !== null ? `, up to ${usd(r.perItemCap)} an item` : ", any price inside the weekly limit"}` };
    case "block":
      return { tone: "stop", label: "Never", detail: [...r.categories.map((c) => CATEGORY_LABEL[c].toLowerCase()), ...r.merchants].join(", ") };
    case "approval":
      return {
        tone: "ask",
        label: "Ask me first",
        detail: `${r.overAmount !== null ? `over ${usd(r.overAmount)}` : "any price"}${r.when === "new_merchant" ? " at a store we have not used before" : ""}${r.categories.length > 0 ? `, for ${r.categories.map((c) => CATEGORY_LABEL[c].toLowerCase()).join(", ")}` : ""}`,
      };
  }
}

const TONE = {
  ok: "bg-[var(--color-ok-soft)] text-[var(--color-ok)]",
  ask: "bg-[var(--color-ask-soft)] text-[var(--color-ask)]",
  stop: "bg-[var(--color-stop-soft)] text-[var(--color-stop)]",
  info: "bg-[var(--color-info-soft)] text-[var(--color-info)]",
};

export function RuleList({ rules }: { rules: Rule[] }) {
  return (
    <ol className="space-y-2" data-testid="mandate-rules">
      {rules.map((r) => {
        const g = gloss(r);
        return (
          <li key={`${r.n}-${r.kind}`} className="flex gap-3">
            <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--color-ink)] text-xs font-bold text-white" aria-label={`Rule ${r.n}`}>
              {r.n}
            </span>
            <div className="min-w-0">
              <p className="text-[15px] font-semibold leading-snug">{r.text}</p>
              <p className="mt-0.5 text-xs text-[var(--color-ink-2)]">
                <span className={`mr-1.5 inline-block rounded-full px-1.5 py-0.5 text-[11px] font-bold ${TONE[g.tone]}`}>{g.label}</span>
                {g.detail}
              </p>
            </div>
          </li>
        );
      })}
      <li className="flex gap-3">
        <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-[var(--color-line)] bg-white text-xs font-bold text-[var(--color-ink-2)]" aria-hidden="true">
          +
        </span>
        <p className="text-[13px] text-[var(--color-ink-2)]">Anything these rules do not cover needs a parent&apos;s OK. Kip never guesses.</p>
      </li>
    </ol>
  );
}

export function MandateCard({
  mandate,
  check,
  paused,
  onEdit,
  onJson,
}: {
  mandate: SignedMandate;
  check: { ok: boolean; reason: string; short: string | null; expired: boolean };
  paused: boolean;
  onEdit?: () => void;
  onJson?: () => void;
}) {
  const status = !check.ok ? { label: "Signature invalid", cls: TONE.stop } : check.expired ? { label: "Expired", cls: TONE.stop } : paused ? { label: "Paused", cls: TONE.ask } : { label: "Active", cls: TONE.ok };
  return (
    <section className="card p-4 sm:p-5" aria-labelledby="mandate-title" data-testid="mandate-card">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 id="mandate-title" className="font-display text-lg font-extrabold">
            {mandate.teen.name}&apos;s spending mandate
          </h3>
          <p className="text-xs text-[var(--color-ink-2)]">
            The rules Kip must follow. Version {mandate.version}, for {mandate.agent.name}, in US dollars.
          </p>
        </div>
        <span className={`rounded-full px-2.5 py-1 text-xs font-bold ${status.cls}`} data-testid="mandate-status">
          {status.label}
        </span>
      </div>

      <div className="mt-4">
        <RuleList rules={mandate.rules} />
      </div>

      {mandate.trustedMerchants.length > 0 ? <p className="mt-3 text-xs text-[var(--color-ink-2)]">Stores you marked as trusted: {mandate.trustedMerchants.join(", ")}</p> : null}

      <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-xl bg-[var(--color-sand)] p-3 text-xs" data-testid="mandate-signature">
        <dt className="font-semibold">Signed by</dt>
        <dd>
          {mandate.signature.signedBy}, {new Date(mandate.signature.signedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
        </dd>
        <dt className="font-semibold">Signature</dt>
        <dd className="mono break-all">
          {mandate.signature.alg} · key {mandate.signature.keyId} · {check.short}
        </dd>
        <dt className="font-semibold">Digest</dt>
        <dd className="mono break-all">sha256:{mandate.signature.digest.slice(0, 20)}...</dd>
        <dt className="font-semibold">Check</dt>
        <dd className={check.ok ? "text-[var(--color-ok)]" : "font-bold text-[var(--color-stop)]"}>{check.reason} Verified in code before every purchase.</dd>
        <dt className="font-semibold">Expires</dt>
        <dd>{new Date(mandate.expiresAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</dd>
      </dl>

      <div className="mt-3 flex flex-wrap gap-2">
        {onEdit ? (
          <button type="button" className="btn btn-quiet btn-sm" onClick={onEdit} data-testid="mandate-edit">
            Rewrite the rules
          </button>
        ) : null}
        {onJson ? (
          <button type="button" className="btn btn-quiet btn-sm" onClick={onJson} data-testid="mandate-json">
            See the signed JSON
          </button>
        ) : null}
      </div>
    </section>
  );
}
