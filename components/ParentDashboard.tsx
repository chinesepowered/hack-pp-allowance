"use client";

/**
 * The parent's view: approvals first, then the budget, the mandate, the
 * ledger with Undo, the weekly summary and the pause switch.
 */
import { useState } from "react";
import { DEFAULT_RULES_TEXT } from "@/lib/demo/defaults";
import { CATEGORY_LABEL } from "@/lib/mandate/categories";
import type { ClientState } from "@/lib/session";
import type { Approval } from "@/lib/types";
import { useDemo, type DraftResult } from "./demo-context";
import { Kip } from "./Kip";
import { MandateCard, RuleList } from "./MandateCard";
import { PayPalSaveButton } from "./PayPalSaveButton";
import { AiTag, Empty, Spinner, StatusBadge, timeAgo, usd, useSafeText } from "./ui";

/* ----------------------------- setup ----------------------------- */

export function RulesEditor({ initialText, onDone, onCancel }: { initialText: string; onDone: () => void; onCancel?: () => void }) {
  const { draftMandate, signMandate, busy, state } = useDemo();
  const [text, setText] = useState(initialText);
  const [result, setResult] = useState<DraftResult | null>(null);
  const replay = state?.mode === "replay";
  return (
    <div data-testid="rules-editor">
      <label htmlFor="rules-text" className="text-sm font-semibold">
        Your rules, in your own words
      </label>
      <textarea
        id="rules-text"
        data-testid="rules-text"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setResult(null);
        }}
        readOnly={replay}
        rows={5}
        maxLength={1500}
        className="mt-1 w-full rounded-2xl border-[1.5px] border-[var(--color-line)] bg-white p-3 text-[15px]"
        aria-describedby="rules-help"
      />
      <p id="rules-help" className="mt-1 text-xs text-[var(--color-ink-2)]">
        {replay ? "Replay mode uses the recorded rules, so this text cannot be changed." : "Say how much per week, what is always fine, what is never fine, and when you want to be asked."}
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" className="btn btn-primary" disabled={busy === "draft" || text.trim().length < 10} onClick={async () => setResult(await draftMandate(text))} data-testid="rules-draft">
          {busy === "draft" ? <Spinner label="Kip is reading your rules" /> : result ? "Read my rules again" : "Turn into a mandate"}
        </button>
        {onCancel ? (
          <button type="button" className="btn btn-quiet" onClick={onCancel}>
            Cancel
          </button>
        ) : null}
      </div>

      {result ? (
        <div className="rise mt-4 rounded-2xl border-[1.5px] border-[var(--color-pond)] bg-white p-4" data-testid="mandate-draft">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h4 className="font-display text-base font-extrabold">Here is how Kip will read them</h4>
            <AiTag model={result.model} />
          </div>
          <p className="mb-3 mt-1 text-xs text-[var(--color-ink-2)]">The model proposed this structure. It was validated against a schema and checked in code. Nothing takes effect until you sign.</p>
          <RuleList rules={result.draft.rules} />
          {result.draft.unclear.length > 0 ? (
            <div className="mt-3 rounded-xl bg-[var(--color-ask-soft)] p-3 text-[13px] text-[var(--color-ask)]" role="note">
              <p className="font-bold">Not turned into a rule:</p>
              <ul className="list-disc pl-5">
                {result.draft.unclear.map((u) => (
                  <li key={u}>{u}</li>
                ))}
              </ul>
            </div>
          ) : null}
          <p className="mt-3 text-xs text-[var(--color-ink-2)]">
            Weekly limit {usd(result.draft.weeklyBudget)}. Valid for {result.draft.expiresInDays} days.
          </p>
          <button
            type="button"
            className="btn btn-primary mt-3"
            disabled={busy === "sign"}
            onClick={async () => {
              if (await signMandate(text, result.draft)) onDone();
            }}
            data-testid="mandate-sign"
          >
            {busy === "sign" ? <Spinner label="Signing" /> : "Looks right. Sign the mandate"}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function Setup({ state }: { state: ClientState }) {
  const step = !state.vault.saved ? 1 : 2;
  return (
    <div className="mx-auto w-full max-w-2xl space-y-4 p-4" data-testid="parent-setup">
      <div className="flex items-center gap-3">
        <Kip mood="idle" size={56} />
        <div>
          <h2 className="font-display text-xl font-extrabold">Set up {state.family.teen.name}&apos;s allowance</h2>
          <p className="text-sm text-[var(--color-ink-2)]">Two steps, about two minutes. You stay in charge the whole time.</p>
        </div>
      </div>

      <section className={`card p-4 sm:p-5 ${step === 1 ? "ring-2 ring-[var(--color-pond)]" : ""}`} aria-labelledby="setup-1">
        <h3 id="setup-1" className="font-display text-base font-extrabold">
          1. Save your PayPal once
        </h3>
        {state.vault.saved ? (
          <p className="mt-1 text-sm text-[var(--color-ok)]" data-testid="vault-saved">
            Saved: {state.vault.payerEmail ?? "your PayPal"}. Kip can pay with it, but only inside the rules you sign next.
          </p>
        ) : (
          <>
            <p className="mb-3 mt-1 text-sm text-[var(--color-ink-2)]">Kip pays with it later, with no popup, but only when a purchase passes your rules. You approve this in PayPal&apos;s own window; Allowance never sees your login.</p>
            <PayPalSaveButton />
          </>
        )}
      </section>

      <section className={`card p-4 sm:p-5 ${step === 2 ? "ring-2 ring-[var(--color-pond)]" : "opacity-70"}`} aria-labelledby="setup-2">
        <h3 id="setup-2" className="font-display text-base font-extrabold">
          2. Write the rules and sign
        </h3>
        {step === 2 ? <div className="mt-2">{<RulesEditor initialText={DEFAULT_RULES_TEXT} onDone={() => undefined} />}</div> : <p className="mt-1 text-sm text-[var(--color-ink-2)]">Save your PayPal first.</p>}
      </section>
    </div>
  );
}

/* ----------------------------- approvals ----------------------------- */

function ApprovalCard({ a, state }: { a: Approval; state: ClientState }) {
  const { approve, busy } = useDemo();
  const safeText = useSafeText();
  const working = busy?.startsWith(`approval:${a.id}`);
  return (
    <li className="rise rounded-2xl border-[1.5px] border-[#f3d28a] bg-white p-4" data-testid="approval-card">
      <div className="flex gap-3">
        {a.product.image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={a.product.image} alt="" className="h-16 w-16 shrink-0 rounded-xl bg-[var(--color-sand)] object-contain" referrerPolicy="no-referrer" />
        ) : null}
        <div className="min-w-0 flex-1">
          <p className="text-xs font-bold uppercase tracking-wide text-[var(--color-ask)]">
            {state.family.teen.name} is asking · {timeAgo(a.createdAt)}
          </p>
          <p className="text-[15px] font-bold leading-snug">{safeText(a.product.title)}</p>
          <p className="text-sm text-[var(--color-ink-2)]">
            <span className="font-display text-lg font-extrabold text-[var(--color-ink)]">{usd(a.amount.value)}</span> at {safeText(a.product.merchant)} · {CATEGORY_LABEL[a.category]}
          </p>
        </div>
      </div>

      <div className="mt-3 rounded-xl bg-[var(--color-ask-soft)] p-3" data-testid="approval-rule">
        <p className="text-xs font-bold uppercase tracking-wide text-[var(--color-ask)]">Why Kip did not just buy it</p>
        <p className="mt-0.5 text-sm font-semibold">{safeText(a.decision.parentLine)}</p>
        <p className="mt-1 text-xs text-[var(--color-ink-2)]">Decided by the policy check in code, not by the AI.</p>
      </div>

      <div className="mt-3">
        <p className="text-xs font-bold uppercase tracking-wide text-[var(--color-ink-3)]">Kip&apos;s note</p>
        <p className="mt-0.5 text-sm">{safeText(a.kipReasoning)}</p>
        {a.aiModel ? <AiTag model={a.aiModel} className="mt-1" /> : null}
        <p className="mt-1 text-xs text-[var(--color-ink-2)]">
          {state.family.teen.name} wrote: <q>{a.requestText}</q>
        </p>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" className="btn btn-primary" disabled={Boolean(busy)} onClick={() => void approve(a.id, "approve")} data-testid="approve">
          {working && busy?.endsWith(":approve") ? <Spinner label="Paying with PayPal" /> : `Approve ${usd(a.amount.value)}`}
        </button>
        <button type="button" className="btn btn-danger" disabled={Boolean(busy)} onClick={() => void approve(a.id, "decline")} data-testid="decline">
          Decline
        </button>
        {a.suggestedRule ? (
          <button type="button" className="btn btn-quiet" disabled={Boolean(busy)} onClick={() => void approve(a.id, "approve_and_add_rule")} data-testid="approve-add-rule" title="Approves this purchase and signs a new version of the mandate with this rule">
            {working && busy?.endsWith("add_rule") ? <Spinner label="Paying and signing" /> : `Approve and add a rule: ${a.suggestedRule.text}`}
          </button>
        ) : null}
      </div>
      {state.paused ? <p className="mt-2 text-xs font-semibold text-[var(--color-ask)]">The mandate is paused. Resume it to approve.</p> : null}
    </li>
  );
}

/* ----------------------------- ledger ----------------------------- */

function Ledger({ state }: { state: ClientState }) {
  const { undo, busy } = useDemo();
  const safeText = useSafeText();
  const [all, setAll] = useState(false);
  const rows = state.ledger.filter((e) => all || ["paid", "refunded", "refund_pending", "paying"].includes(e.status));
  const hidden = state.ledger.length - rows.length;
  return (
    <section className="card p-4 sm:p-5" aria-labelledby="ledger-title" data-testid="ledger">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 id="ledger-title" className="font-display text-lg font-extrabold">
            Ledger
          </h3>
          <p className="text-xs text-[var(--color-ink-2)]">Every purchase Kip made, the rule it relied on, and the PayPal ids. PayPal is the source of truth.</p>
        </div>
        <div className="flex rounded-full border border-[var(--color-line)] bg-[var(--color-sand)] p-0.5 text-xs font-bold" role="group" aria-label="What to show">
          <button type="button" className={`rounded-full px-3 py-1.5 ${!all ? "bg-white shadow" : ""}`} aria-pressed={!all} onClick={() => setAll(false)}>
            Purchases
          </button>
          <button type="button" className={`rounded-full px-3 py-1.5 ${all ? "bg-white shadow" : ""}`} aria-pressed={all} onClick={() => setAll(true)} data-testid="ledger-all">
            All requests{hidden > 0 && !all ? ` (${state.ledger.length})` : ""}
          </button>
        </div>
      </div>

      {rows.length === 0 ? (
        <Empty title="Nothing here yet" kip={<Kip mood="idle" size={64} decorative />}>
          When Kip buys something for {state.family.teen.name}, it shows up here with the rule that allowed it.
        </Empty>
      ) : (
        <ul className="mt-3 divide-y divide-[var(--color-line)]">
          {rows.map((e) => {
            const money = ["paid", "refunded", "refund_pending", "paying"].includes(e.status);
            return (
              <li key={e.id} className="py-3" data-testid="ledger-row" data-status={e.status}>
                <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
                  <div className="min-w-0 flex-1">
                    <p className="text-[15px] font-semibold leading-snug">{safeText(e.product.title)}</p>
                    <p className="text-xs text-[var(--color-ink-2)]">
                      {safeText(e.product.merchant)} · {timeAgo(e.createdAt)} · {CATEGORY_LABEL[e.category]}
                      {e.seeded ? " · seeded demo history" : ""}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <StatusBadge status={e.status} />
                    <p className={`font-display text-lg font-extrabold ${e.status === "refunded" ? "text-[var(--color-ink-3)] line-through" : ""}`}>{money ? usd(e.amount.value) : e.product.price > 0 ? usd(e.product.price) : ""}</p>
                  </div>
                </div>
                <p className="mt-1 text-[13px]" data-testid="ledger-rule">
                  {e.approvedBy === "parent" ? `Approved by you. ` : ""}
                  {safeText(e.approvedBy === "parent" ? e.decision.parentLine : e.decision.summary)}
                </p>
                {e.paypal.orderId ? (
                  <p className="mt-1 text-xs text-[var(--color-ink-2)]">
                    PayPal order <span className="mono">{e.paypal.orderId}</span> · capture <span className="mono">{e.paypal.captureId}</span>
                    {e.paypal.refundId ? (
                      <>
                        {" "}
                        · refund <span className="mono">{e.paypal.refundId}</span>
                      </>
                    ) : null}
                    {e.paypal.via ? ` · via ${e.paypal.via === "agent-toolkit" ? "PayPal Agent Toolkit" : "PayPal Server SDK"}` : ""}
                  </p>
                ) : null}
                {money ? (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    {e.undo.ok ? (
                      <button type="button" className="btn btn-quiet btn-sm" disabled={Boolean(busy)} onClick={() => void undo(e.id)} data-testid="undo" aria-label={`Undo ${e.product.title}: refund ${usd(e.amount.value)}`}>
                        {busy === `undo:${e.id}` ? <Spinner label="Refunding through PayPal" /> : "Undo (refund)"}
                      </button>
                    ) : (
                      <span className="text-xs text-[var(--color-ink-3)]">{e.undo.reason}</span>
                    )}
                    {e.undo.ok && e.undoUntil ? <span className="text-xs text-[var(--color-ink-3)]">Undo is open for 24 hours after a purchase.</span> : null}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/* ----------------------------- the dashboard ----------------------------- */

export function ParentDashboard({ onOpenHood }: { onOpenHood?: (tab: string) => void }) {
  const { state, pause, busy, writeSummary, refresh } = useDemo();
  const [editing, setEditing] = useState(false);
  const [changeVault, setChangeVault] = useState(false);
  const safeText = useSafeText();

  if (!state) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-[var(--color-ink-2)]">
        <Spinner label="Loading the dashboard" />
      </div>
    );
  }
  if (!state.setupComplete || !state.mandate) return <Setup state={state} />;

  const parent = state.family.parent.name;
  const teen = state.family.teen.name;
  const pending = state.approvals.filter((a) => a.status === "pending");
  const { limit, spent, remaining } = state.budget;
  const pct = limit > 0 ? Math.round((spent / limit) * 100) : 0;
  const over = spent > limit;

  return (
    <div className="mx-auto w-full max-w-3xl space-y-4 p-4" data-testid="parent-view">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-display text-xl font-extrabold">{parent}&apos;s dashboard</h2>
          <p className="text-sm text-[var(--color-ink-2)]">
            What Kip may spend for {teen}, what it has spent, and anything waiting for you.
          </p>
        </div>
        <div className="flex items-center gap-3 rounded-2xl border border-[var(--color-line)] bg-white px-3 py-2" data-testid="pause-box">
          <div>
            <p className="text-sm font-bold" id="pause-label">
              {state.paused ? "Kip is paused" : "Kip can spend"}
            </p>
            <p className="text-xs text-[var(--color-ink-2)]">{state.paused ? "No purchases until you resume." : "Inside the rules only."}</p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={!state.paused}
            aria-labelledby="pause-label"
            disabled={busy === "pause"}
            onClick={() => void pause(!state.paused)}
            data-testid="pause-switch"
            className={`relative h-8 w-14 shrink-0 rounded-full transition-colors ${state.paused ? "bg-[#9aa3ad]" : "bg-[var(--color-pond)]"}`}
          >
            <span className={`absolute top-1 h-6 w-6 rounded-full bg-white shadow transition-all ${state.paused ? "left-1" : "left-7"}`} />
          </button>
        </div>
      </header>

      {state.paused ? (
        <p className="rounded-2xl border border-[#f3d28a] bg-[var(--color-ask-soft)] px-4 py-3 text-sm font-semibold text-[var(--color-ask)]" role="status" data-testid="paused-banner">
          You paused the mandate {timeAgo(state.paused.at)}. Kip told {teen} and has stopped buying.
        </p>
      ) : null}

      <section aria-labelledby="approvals-title" data-testid="approvals">
        <h3 id="approvals-title" className="mb-2 font-display text-lg font-extrabold">
          Needs your OK {pending.length > 0 ? <span className="ml-1 rounded-full bg-[var(--color-ask)] px-2 py-0.5 align-middle text-xs text-white">{pending.length}</span> : null}
        </h3>
        <div aria-live="polite">
          {pending.length === 0 ? (
            <div className="card flex items-center gap-3 p-4 text-sm text-[var(--color-ink-2)]">
              <Kip mood="happy" size={44} decorative />
              <p>Nothing is waiting. Kip only asks when a purchase would break a rule or no rule covers it.</p>
            </div>
          ) : (
            <ul className="space-y-3">
              {pending.map((a) => (
                <ApprovalCard key={a.id} a={a} state={state} />
              ))}
            </ul>
          )}
        </div>
      </section>

      <section className="card p-4 sm:p-5" aria-labelledby="budget-title" data-testid="budget">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h3 id="budget-title" className="font-display text-lg font-extrabold">
              This week
            </h3>
            <p className="text-xs text-[var(--color-ink-2)]">A rolling seven days. Refunds give the money back to the week.</p>
          </div>
          <p className="font-display text-2xl font-extrabold" data-testid="budget-numbers">
            {usd(spent)} <span className="text-sm font-semibold text-[var(--color-ink-2)]">of {usd(limit)}</span>
          </p>
        </div>
        <div className="mt-3 h-4 w-full overflow-hidden rounded-full bg-[var(--color-sand)]" role="progressbar" aria-label="Weekly budget used" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, pct)}>
          <div className={`h-full rounded-full ${over ? "bg-[var(--color-ask)]" : "bg-[var(--color-pond)]"}`} style={{ width: `${Math.min(100, pct)}%` }} />
        </div>
        <p className="mt-2 text-sm">
          {over ? (
            <span className="font-semibold text-[var(--color-ask)]">{usd(spent - limit)} over the weekly limit, because you approved a purchase above it. Kip cannot buy anything else on its own this week.</span>
          ) : (
            <>
              <span className="font-semibold">{usd(remaining)} left</span> for Kip to spend without asking.
            </>
          )}
        </p>
      </section>

      {editing ? (
        <section className="card p-4 sm:p-5" aria-label="Rewrite the rules">
          <h3 className="mb-2 font-display text-lg font-extrabold">Rewrite the rules</h3>
          <p className="mb-3 text-sm text-[var(--color-ink-2)]">Signing creates version {state.mandate.version + 1}. The current version stays in force until you sign.</p>
          <RulesEditor initialText={state.mandate.rulesText} onDone={() => setEditing(false)} onCancel={() => setEditing(false)} />
        </section>
      ) : (
        <MandateCard mandate={state.mandate} check={state.mandateCheck} paused={Boolean(state.paused)} onEdit={() => setEditing(true)} onJson={onOpenHood ? () => onOpenHood("mandate") : undefined} />
      )}

      <Ledger state={state} />

      <section className="card p-4 sm:p-5" aria-labelledby="summary-title" data-testid="summary">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 id="summary-title" className="font-display text-lg font-extrabold">
            Kip&apos;s weekly note
          </h3>
          <button type="button" className="btn btn-quiet btn-sm" disabled={busy === "summary"} onClick={() => void writeSummary()} data-testid="summary-write">
            {busy === "summary" ? <Spinner label="Writing" /> : state.summary ? "Write it again" : "Write this week's note"}
          </button>
        </div>
        {state.summary ? (
          <div className="mt-2" aria-live="polite">
            <p className="text-[15px] leading-relaxed" data-testid="summary-text">
              {safeText(state.summary.text)}
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <AiTag model={state.summary.model} />
              <span className="text-xs text-[var(--color-ink-2)]">
                Numbers come from the ledger in code: {String(state.summary.facts.purchases)} purchases, {String(state.summary.facts.spent)} of {String(state.summary.facts.budget)}, {String(state.summary.facts.askedParent)} asked, {String(state.summary.facts.blocked)} blocked.
              </span>
            </div>
          </div>
        ) : (
          <p className="mt-2 text-sm text-[var(--color-ink-2)]">A short note about what {teen} bought this week, written by the AI from the ledger.</p>
        )}
      </section>

      <section className="card p-4 sm:p-5" aria-labelledby="vault-title" data-testid="vault">
        <h3 id="vault-title" className="font-display text-lg font-extrabold">
          Saved PayPal
        </h3>
        {state.vault.saved ? (
          <p className="mt-1 text-sm">
            <span className="font-semibold">{state.vault.payerEmail ?? "PayPal wallet"}</span>
            {state.vault.payerName ? ` (${state.vault.payerName})` : ""} · vault token <span className="mono">{state.vault.tokenHint}</span> · saved {timeAgo(state.vault.savedAt)}
            {state.vault.source === "seed" ? " by the seed script, approved once in PayPal's window" : ""}
          </p>
        ) : null}
        <p className="mt-1 text-xs text-[var(--color-ink-2)]">Stored by PayPal Vault. Allowance keeps only the token id on the server and uses it for purchases that pass the mandate.</p>
        {changeVault ? (
          <div className="mt-3">
            <PayPalSaveButton onSaved={() => setChangeVault(false)} />
          </div>
        ) : (
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" className="btn btn-quiet btn-sm" onClick={() => setChangeVault(true)} data-testid="vault-change">
              Save a PayPal again
            </button>
            <button type="button" className="btn btn-quiet btn-sm" onClick={() => void refresh(true)} data-testid="refresh-paypal">
              Refresh from PayPal
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
