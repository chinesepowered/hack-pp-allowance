"use client";

/**
 * The demo shell: one browser shows the teen and the parent, side by side
 * on a wide screen or one at a time with the role switcher.
 */
import { useEffect, useRef, useState } from "react";
import { DemoProvider, useDemo } from "./demo-context";
import { KipHead } from "./Kip";
import { ParentDashboard } from "./ParentDashboard";
import { TeenChat } from "./TeenChat";
import { UnderTheHood, type HoodTab } from "./UnderTheHood";

export type View = "teen" | "parent" | "both";

function Menu({ onHood }: { onHood: () => void }) {
  const { state, session, sound, setSound, busy } = useDemo();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);
  const item = "block w-full rounded-xl px-3 py-2 text-left text-sm font-semibold hover:bg-[var(--color-sand)] disabled:opacity-50";
  return (
    <div className="relative" ref={ref}>
      <button type="button" className="btn btn-quiet btn-sm" aria-haspopup="true" aria-expanded={open} onClick={() => setOpen((o) => !o)} data-testid="menu">
        Demo menu
      </button>
      {open ? (
        <div className="absolute right-0 z-40 mt-2 w-72 rounded-2xl border border-[var(--color-line)] bg-white p-2 shadow-xl" data-testid="menu-panel">
          <button
            type="button"
            className={item}
            onClick={() => {
              setOpen(false);
              onHood();
            }}
          >
            Under the hood
            <span className="block text-xs font-normal text-[var(--color-ink-2)]">PayPal calls, agent trail, mandate JSON</span>
          </button>
          <button
            type="button"
            className={item}
            disabled={Boolean(busy)}
            data-testid="menu-reset"
            onClick={() => {
              setOpen(false);
              void session("reset");
            }}
          >
            Start over with the demo family
            <span className="block text-xs font-normal text-[var(--color-ink-2)]">Saved PayPal, signed mandate, three past purchases</span>
          </button>
          <button
            type="button"
            className={item}
            disabled={Boolean(busy)}
            data-testid="menu-fresh"
            onClick={() => {
              setOpen(false);
              void session("fresh");
            }}
          >
            Start from an empty family
            <span className="block text-xs font-normal text-[var(--color-ink-2)]">Walk through the two-minute parent setup</span>
          </button>
          <button type="button" className={item} aria-pressed={sound} onClick={() => setSound(!sound)} data-testid="menu-sound">
            Kip&apos;s voice: {sound ? "on" : "off"}
            <span className="block text-xs font-normal text-[var(--color-ink-2)]">Short pre-recorded lines, no live text to speech</span>
          </button>
          {state ? (
            <button
              type="button"
              className={item}
              onClick={async () => {
                const url = `${window.location.origin}/api/session/join?s=${state.sid}&to=/parent`;
                try {
                  await navigator.clipboard.writeText(url);
                  setCopied(true);
                  window.setTimeout(() => setCopied(false), 2500);
                } catch {
                  window.prompt("Copy this link", url);
                }
              }}
            >
              {copied ? "Link copied" : "Copy a link to the parent view"}
              <span className="block text-xs font-normal text-[var(--color-ink-2)]">Open this same family on a phone</span>
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function Shell({ initialView }: { initialView: View }) {
  const { state, notice, clearNotice, setMode, loadError, busy } = useDemo();
  const [view, setView] = useState<View>(initialView);
  const [hood, setHood] = useState<{ open: boolean; tab: HoodTab }>({ open: false, tab: "paypal" });
  const pending = state?.approvals.filter((a) => a.status === "pending").length ?? 0;

  useEffect(() => {
    // Side by side needs room. On a narrow screen fall back to one role.
    const fit = () => {
      if (window.innerWidth < 1024) setView((v) => (v === "both" ? "teen" : v));
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, []);

  useEffect(() => {
    if (!notice || notice.tone === "error") return;
    const t = window.setTimeout(clearNotice, 4500);
    return () => window.clearTimeout(t);
  }, [notice, clearNotice]);

  const roles: { id: View; label: string; wide?: boolean }[] = [
    { id: "teen", label: `${state?.family.teen.name ?? "Leo"} (teen)` },
    { id: "parent", label: `${state?.family.parent.name ?? "Dana"} (parent)` },
    { id: "both", label: "Side by side", wide: true },
  ];
  const replay = state?.mode === "replay";

  return (
    <div className="flex flex-col" style={{ height: "calc(100dvh / var(--alw-zoom, 1))" }}>
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded-lg focus:bg-white focus:px-3 focus:py-2">
        Skip to content
      </a>
      <header className="z-30 border-b border-[var(--color-line)] bg-white">
        <div className="mx-auto flex max-w-[1500px] flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2 sm:px-4">
          <div className="flex items-center gap-2">
            <KipHead size={34} />
            <div className="leading-tight">
              <p className="font-display text-lg font-extrabold">Allowance</p>
              <p className="hidden text-[11px] text-[var(--color-ink-2)] sm:block">An agent that pays inside your rules</p>
            </div>
          </div>

          <div className="order-3 flex w-full justify-center sm:order-none sm:w-auto sm:flex-1">
            <div className="flex rounded-full border border-[var(--color-line)] bg-[var(--color-sand)] p-1" role="radiogroup" aria-label="Whose view">
              {roles.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  role="radio"
                  aria-checked={view === r.id}
                  onClick={() => setView(r.id)}
                  data-testid={`role-${r.id}`}
                  className={`relative rounded-full px-3 py-1.5 text-sm font-bold ${r.wide ? "hidden lg:block" : ""} ${view === r.id ? "bg-white text-[var(--color-ink)] shadow" : "text-[var(--color-ink-2)]"}`}
                >
                  {r.label}
                  {r.id === "parent" && pending > 0 ? (
                    <span className="ml-1.5 rounded-full bg-[var(--color-ask)] px-1.5 py-0.5 text-[11px] text-white" data-testid="pending-badge">
                      {pending}
                      <span className="sr-only"> waiting for approval</span>
                    </span>
                  ) : null}
                </button>
              ))}
            </div>
          </div>

          <div className="ml-auto flex items-center gap-2">
            <div className="flex rounded-full border border-[var(--color-line)] bg-[var(--color-sand)] p-0.5 text-xs font-bold" role="radiogroup" aria-label="Data source">
              <button type="button" role="radio" aria-checked={!replay} disabled={busy === "mode"} onClick={() => replay && void setMode("live")} className={`rounded-full px-2.5 py-1.5 ${!replay ? "bg-white shadow" : "text-[var(--color-ink-2)]"}`} data-testid="mode-live">
                Live
              </button>
              <button type="button" role="radio" aria-checked={replay} disabled={busy === "mode"} onClick={() => !replay && void setMode("replay")} className={`rounded-full px-2.5 py-1.5 ${replay ? "bg-[var(--color-ink)] text-white shadow" : "text-[var(--color-ink-2)]"}`} data-testid="mode-replay">
                Replay
              </button>
            </div>
            <button type="button" className="btn btn-quiet btn-sm hidden sm:inline-flex" onClick={() => setHood({ open: true, tab: "paypal" })} data-testid="hood-open">
              Under the hood
            </button>
            <Menu onHood={() => setHood({ open: true, tab: "paypal" })} />
          </div>
        </div>
        {replay ? (
          <p className="bg-[var(--color-ink)] px-4 py-1.5 text-center text-[13px] font-semibold text-white" role="status" data-testid="replay-banner">
            Replay mode: recorded PayPal sandbox, Channel3 and AI responses. The rules are still checked live in code. Switch to Live to use the real sandbox.
          </p>
        ) : null}
      </header>

      <div aria-live="assertive" className="pointer-events-none fixed inset-x-0 bottom-5 z-40 flex justify-center px-3">
        {notice ? (
          <div className={`pointer-events-auto flex max-w-xl items-start gap-3 rounded-2xl border px-4 py-3 text-sm font-semibold shadow-lg ${notice.tone === "error" ? "border-[#efb9b2] bg-[var(--color-stop-soft)] text-[var(--color-stop)]" : "border-[#b9e4c5] bg-[var(--color-ok-soft)] text-[var(--color-ok)]"}`} role={notice.tone === "error" ? "alert" : "status"} data-testid="notice-toast">
            <span>{notice.text}</span>
            <button type="button" className="underline" onClick={clearNotice}>
              Dismiss
            </button>
          </div>
        ) : null}
      </div>

      <main id="main" className="min-h-0 flex-1">
        {loadError && !state ? (
          <div className="mx-auto max-w-md p-8 text-center">
            <p className="font-display text-lg font-extrabold">The demo could not load</p>
            <p className="mt-1 text-sm text-[var(--color-ink-2)]">{loadError}</p>
          </div>
        ) : view === "both" ? (
          <div className="mx-auto grid h-full max-w-[1500px] grid-cols-[minmax(380px,460px)_1fr]">
            <section className="flex min-h-0 flex-col border-r border-[var(--color-line)]" aria-label="Teen view">
              <TeenChat compact />
            </section>
            <section className="scroll-soft min-h-0 overflow-y-auto" aria-label="Parent view">
              <ParentDashboard onOpenHood={(t) => setHood({ open: true, tab: t as HoodTab })} />
            </section>
          </div>
        ) : view === "teen" ? (
          <section className="h-full" aria-label="Teen view">
            <TeenChat />
          </section>
        ) : (
          <section className="scroll-soft h-full overflow-y-auto" aria-label="Parent view">
            <ParentDashboard onOpenHood={(t) => setHood({ open: true, tab: t as HoodTab })} />
          </section>
        )}
      </main>

      <UnderTheHood open={hood.open} tab={hood.tab} onTab={(tab) => setHood({ open: true, tab })} onClose={() => setHood((h) => ({ ...h, open: false }))} />
    </div>
  );
}

export function DemoApp({ initialView = "both" }: { initialView?: View }) {
  return (
    <DemoProvider>
      <Shell initialView={initialView} />
    </DemoProvider>
  );
}
