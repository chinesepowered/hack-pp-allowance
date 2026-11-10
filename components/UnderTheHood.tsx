"use client";

/**
 * Under the hood: every PayPal call this session made (method, path,
 * status, PayPal-Debug-Id, which feature triggered it), Kip's reasoning
 * trail, the Channel3 calls, the signed mandate and webhooks.
 */
import { useEffect, useRef } from "react";
import { useDemo } from "./demo-context";
import { AiTag, clock, useSafeText } from "./ui";

export type HoodTab = "paypal" | "agent" | "channel3" | "mandate" | "webhooks";

const TABS: { id: HoodTab; label: string }[] = [
  { id: "paypal", label: "PayPal calls" },
  { id: "agent", label: "Agent trail" },
  { id: "channel3", label: "Channel3" },
  { id: "mandate", label: "Mandate JSON" },
  { id: "webhooks", label: "Webhooks" },
];

const VIA: Record<string, string> = { "agent-toolkit": "Agent Toolkit", "server-sdk": "Server SDK", rest: "REST", "js-sdk": "JS SDK v6" };

function statusClass(status: number): string {
  if (status >= 200 && status < 300) return "bg-[var(--color-ok-soft)] text-[var(--color-ok)]";
  if (status >= 400) return "bg-[var(--color-stop-soft)] text-[var(--color-stop)]";
  return "bg-[var(--color-sand)] text-[var(--color-ink-2)]";
}

export function UnderTheHood({ open, tab, onTab, onClose }: { open: boolean; tab: HoodTab; onTab: (t: HoodTab) => void; onClose: () => void }) {
  const { state } = useDemo();
  const safeText = useSafeText();
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "Tab" && panelRef.current) {
        const focusable = panelRef.current.querySelectorAll<HTMLElement>('button, [href], [tabindex]:not([tabindex="-1"])');
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      previous?.focus?.();
    };
  }, [open, onClose]);

  if (!open || !state) return null;
  const calls = [...state.paypalCalls].reverse();
  const steps = [...state.agentSteps].reverse();
  const c3 = [...state.channel3Calls].reverse();

  return (
    <div className="fixed inset-0 z-50 flex justify-end" data-testid="hood">
      <button type="button" className="absolute inset-0 bg-[rgb(28_37_48/0.45)]" aria-label="Close Under the hood" onClick={onClose} tabIndex={-1} />
      <div ref={panelRef} role="dialog" aria-modal="true" aria-labelledby="hood-title" className="relative flex h-full w-full max-w-[720px] flex-col bg-[var(--color-paper)] shadow-2xl">
        <div className="flex items-start justify-between gap-3 border-b border-[var(--color-line)] bg-white px-4 py-3">
          <div>
            <h2 id="hood-title" className="font-display text-lg font-extrabold">
              Under the hood
            </h2>
            <p className="text-xs text-[var(--color-ink-2)]">
              What this demo session really did. {state.mode === "replay" ? "Replay mode: these are recorded sandbox responses." : "Live against the PayPal sandbox."}
            </p>
          </div>
          <button ref={closeRef} type="button" className="btn btn-quiet btn-sm" onClick={onClose} data-testid="hood-close">
            Close
          </button>
        </div>

        <div className="scroll-soft flex gap-1 overflow-x-auto border-b border-[var(--color-line)] bg-white px-3 py-2" role="tablist" aria-label="Under the hood sections">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              id={`hood-tab-${t.id}`}
              aria-selected={tab === t.id}
              aria-controls="hood-panel"
              onClick={() => onTab(t.id)}
              data-testid={`hood-tab-${t.id}`}
              className={`shrink-0 rounded-full px-3 py-1.5 text-sm font-bold ${tab === t.id ? "bg-[var(--color-ink)] text-white" : "text-[var(--color-ink-2)] hover:bg-[var(--color-sand)]"}`}
            >
              {t.label}
              {t.id === "paypal" ? ` (${calls.length})` : t.id === "agent" ? ` (${steps.length})` : t.id === "channel3" ? ` (${c3.length})` : ""}
            </button>
          ))}
        </div>

        <div id="hood-panel" role="tabpanel" aria-labelledby={`hood-tab-${tab}`} className="scroll-soft min-h-0 flex-1 overflow-y-auto p-4" tabIndex={0}>
          {tab === "paypal" ? (
            calls.length === 0 ? (
              <p className="text-sm text-[var(--color-ink-2)]">No PayPal calls yet in this session. Ask Kip to buy something, or approve a request.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[620px] border-separate border-spacing-y-1 text-left text-[13px]" data-testid="paypal-calls">
                  <caption className="sr-only">PayPal API calls made by this session, newest first</caption>
                  <thead className="text-xs uppercase tracking-wide text-[var(--color-ink-3)]">
                    <tr>
                      <th scope="col" className="px-2 py-1">
                        Time
                      </th>
                      <th scope="col" className="px-2 py-1">
                        Call
                      </th>
                      <th scope="col" className="px-2 py-1">
                        Status
                      </th>
                      <th scope="col" className="px-2 py-1">
                        PayPal-Debug-Id
                      </th>
                      <th scope="col" className="px-2 py-1">
                        Feature
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {calls.map((c) => (
                      <tr key={c.id} className="bg-white align-top" data-testid="paypal-call">
                        <td className="rounded-l-xl px-2 py-2 text-xs text-[var(--color-ink-2)]">{clock(c.at)}</td>
                        <td className="px-2 py-2">
                          <p className="mono break-all">
                            <span className="font-bold">{c.method}</span> {c.path}
                          </p>
                          <p className="text-xs text-[var(--color-ink-2)]">
                            {VIA[c.via] ?? c.via} · {c.ms} ms{c.note ? ` · ${c.note}` : ""}
                            {c.replay ? " · replayed" : ""}
                          </p>
                          {c.requestId ? <p className="mono text-[11px] text-[var(--color-ink-3)]">PayPal-Request-Id {c.requestId}</p> : null}
                        </td>
                        <td className="px-2 py-2">
                          <span className={`rounded-full px-2 py-0.5 text-xs font-bold ${statusClass(c.status)}`}>{c.status || "none"}</span>
                        </td>
                        <td className="mono px-2 py-2">{c.debugId ?? "none"}</td>
                        <td className="rounded-r-xl px-2 py-2 text-xs">{c.feature}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          ) : null}

          {tab === "agent" ? (
            steps.length === 0 ? (
              <p className="text-sm text-[var(--color-ink-2)]">No agent steps yet. Each thing Kip does is logged here: model turns, tool calls, the policy check and its result.</p>
            ) : (
              <ol className="space-y-2" data-testid="agent-steps">
                {steps.map((s) => (
                  <li key={s.id} className="rounded-xl bg-white p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold uppercase ${s.kind === "policy" ? "bg-[var(--color-ink)] text-white" : s.kind === "model" ? "bg-[var(--color-sand)] text-[var(--color-ink-2)]" : "bg-[var(--color-pond-soft)] text-[var(--color-pond-deep)]"}`}>
                        {s.kind === "policy" ? "policy (code)" : s.kind}
                      </span>
                      <p className="text-sm font-semibold">{safeText(s.title)}</p>
                      {s.model ? <AiTag model={s.model} /> : null}
                      <span className="ml-auto text-xs text-[var(--color-ink-3)]">
                        {clock(s.at)}
                        {s.ms ? ` · ${s.ms} ms` : ""}
                      </span>
                    </div>
                    <p className="mt-1 break-words text-[13px] text-[var(--color-ink-2)]">{safeText(s.detail)}</p>
                    {s.kind === "policy" && (s.data as { checks?: { name: string; pass: boolean; detail: string; ruleN: number | null }[] } | undefined)?.checks ? (
                      <ul className="mt-2 space-y-0.5 text-xs">
                        {(s.data as { checks: { name: string; pass: boolean; detail: string; ruleN: number | null }[] }).checks.map((c) => (
                          <li key={c.name} className="flex gap-2">
                            <span className={`font-bold ${c.pass ? "text-[var(--color-ok)]" : "text-[var(--color-stop)]"}`}>{c.pass ? "pass" : "stop"}</span>
                            <span className="mono">{c.name}</span>
                            <span className="text-[var(--color-ink-2)]">{safeText(c.detail)}</span>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </li>
                ))}
              </ol>
            )
          ) : null}

          {tab === "channel3" ? (
            c3.length === 0 ? (
              <p className="text-sm text-[var(--color-ink-2)]">No Channel3 calls yet. Kip uses Channel3 for text search, image search, similar products and product detail.</p>
            ) : (
              <ul className="space-y-2" data-testid="channel3-calls">
                {c3.map((c) => (
                  <li key={c.id} className="rounded-xl bg-white p-3 text-[13px]">
                    <p className="mono break-all font-bold">{c.endpoint}</p>
                    <p className="text-[var(--color-ink-2)]">{safeText(c.summary)}</p>
                    <p className="mt-0.5 text-xs text-[var(--color-ink-3)]">
                      {clock(c.at)} · {c.status} · {c.cached ? "served from cache" : `${c.ms} ms`} · {c.results} result{c.results === 1 ? "" : "s"}
                    </p>
                  </li>
                ))}
              </ul>
            )
          ) : null}

          {tab === "mandate" ? (
            state.mandate ? (
              <div data-testid="mandate-json">
                <p className="mb-2 text-sm text-[var(--color-ink-2)]">
                  The mandate is stored as signed JSON. The signature is an HMAC-SHA256 over the canonical form of everything except the signature block, so changing any rule breaks it. This follows the intent mandate idea from agent payment protocols such as AP2. It is not an AP2 implementation.
                </p>
                <p className={`mb-2 text-sm font-bold ${state.mandateCheck.ok ? "text-[var(--color-ok)]" : "text-[var(--color-stop)]"}`}>{state.mandateCheck.reason}</p>
                <pre className="mono overflow-x-auto rounded-xl bg-[var(--color-ink)] p-3 text-[12px] leading-relaxed text-[#e8eef5]" tabIndex={0}>
                  {JSON.stringify(state.mandate, null, 2)}
                </pre>
                <h3 className="mb-1 mt-4 font-display text-base font-extrabold">Versions</h3>
                <ul className="space-y-1 text-[13px]">
                  {state.mandateHistory.map((h) => (
                    <li key={h.version} className="rounded-xl bg-white p-2">
                      <span className="font-bold">v{h.version}</span> · {new Date(h.signedAt).toLocaleString("en-US")} · <span className="mono">{h.digest.slice(0, 16)}...</span>
                      <br />
                      <span className="text-[var(--color-ink-2)]">{h.note}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <p className="text-sm text-[var(--color-ink-2)]">No mandate has been signed yet.</p>
            )
          ) : null}

          {tab === "webhooks" ? (
            <div data-testid="webhooks">
              <p className="mb-2 text-sm text-[var(--color-ink-2)]">
                PayPal posts events to <span className="mono">/api/paypal/webhook</span>. Each delivery is verified with <span className="mono">POST /v1/notifications/verify-webhook-signature</span> and handled once. The app does not depend on delivery: every money screen also re-reads PayPal.
              </p>
              {state.webhooks.length === 0 ? (
                <p className="text-sm text-[var(--color-ink-2)]">No webhook events for this session yet. They arrive once the app is deployed and the webhook is registered with pnpm paypal:webhook.</p>
              ) : (
                <ul className="space-y-2">
                  {[...state.webhooks].reverse().map((w) => (
                    <li key={w.id} className="rounded-xl bg-white p-3 text-[13px]">
                      <p className="mono font-bold">{w.eventType}</p>
                      <p className="text-[var(--color-ink-2)]">
                        {clock(w.at)} · {w.verified ? "signature verified" : "not verified"} · {w.handled}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
