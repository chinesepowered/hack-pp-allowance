"use client";

/**
 * The teen's view: a chat with Kip. Mobile first.
 */
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { EXTRA_PROMPTS, SCRIPTED_PROMPTS } from "@/lib/demo/defaults";
import type { ClientState } from "@/lib/session";
import type { ChatCard, ChatMessage, ProductCard } from "@/lib/types";
import { useDemo } from "./demo-context";
import { Kip, type KipMood } from "./Kip";
import { AiTag, OutcomeBadge, Spinner, StatusBadge, clock, usd, useSafeText } from "./ui";

type ProductsCard = Extract<ChatCard, { type: "products" }>;

async function fileToJpegBase64(file: File): Promise<{ base64: string; mime: string }> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("That file is not an image."));
      el.src = url;
    });
    const scale = Math.min(1, 800 / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const g = canvas.getContext("2d");
    if (!g) throw new Error("This browser cannot read the photo.");
    g.fillStyle = "#fff";
    g.fillRect(0, 0, canvas.width, canvas.height);
    g.drawImage(img, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.82);
    return { base64: dataUrl.slice(dataUrl.indexOf(",") + 1), mime: "image/jpeg" };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function BudgetPill({ state }: { state: ClientState }) {
  const { limit, spent, remaining } = state.budget;
  const pct = limit > 0 ? Math.min(100, Math.round((spent / limit) * 100)) : 0;
  return (
    <div className="min-w-[132px] text-right" data-testid="teen-budget">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-ink-3)]">Left this week</p>
      <p className="font-display text-lg font-extrabold leading-tight">
        {usd(remaining)} <span className="text-xs font-semibold text-[var(--color-ink-3)]">of {usd(limit)}</span>
      </p>
      <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-[var(--color-sand)]" role="progressbar" aria-label="Weekly budget used" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
        <div className="h-full rounded-full bg-[var(--color-pond)]" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function ProductTile({ p, card, onAsk, disabled }: { p: ProductCard; card: ProductsCard; onAsk: (p: ProductCard) => void; disabled: boolean }) {
  const safeText = useSafeText();
  const { safe } = useDemo();
  const policy = card.policy[p.id];
  const picked = card.pickId === p.id;
  const title = safeText(p.title);
  return (
    <li
      className={`flex w-[220px] shrink-0 snap-start flex-col rounded-2xl border bg-white p-3 ${picked ? "border-[var(--color-pond)] ring-2 ring-[var(--color-pond)]" : "border-[var(--color-line)]"}`}
      data-testid="product-tile"
      data-picked={picked ? "true" : "false"}
    >
      <div className="flex items-start gap-3">
        <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-[var(--color-sand)]">
          {p.image ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={p.image} alt="" className="h-full w-full object-contain" loading="lazy" referrerPolicy="no-referrer" />
          ) : (
            <span className="text-xs text-[var(--color-ink-3)]">No photo</span>
          )}
        </div>
        <div className="min-w-0">
          {picked ? <p className="mb-0.5 text-[11px] font-extrabold uppercase tracking-wide text-[var(--color-pond)]">Kip&apos;s pick</p> : null}
          <p className="line-clamp-3 text-[13px] font-semibold leading-snug" title={title}>
            {title}
          </p>
        </div>
      </div>
      <p className="mt-2 font-display text-xl font-extrabold">{p.best ? usd(p.best.price) : "n/a"}</p>
      <p className="text-xs text-[var(--color-ink-2)]">
        {p.best ? safeText(p.best.domain) : ""}
        {p.offers.length > 1 ? ` · ${p.offers.length} offers` : ""}
        {p.rating ? ` · ${p.rating.average} stars (${p.rating.count})` : ""}
      </p>
      {!safe && p.brand ? <p className="text-xs text-[var(--color-ink-3)]">{p.brand}</p> : null}
      {p.keyFeatures[0] ? <p className="mt-1 line-clamp-2 text-xs text-[var(--color-ink-2)]">{safeText(p.keyFeatures[0])}</p> : null}
      <div className="mt-2 flex flex-1 flex-col justify-end gap-2">
        {policy ? <OutcomeBadge outcome={policy.outcome} label={policy.label} /> : null}
        {policy && policy.outcome !== "blocked" ? (
          <button type="button" className="btn btn-quiet btn-sm w-full" onClick={() => onAsk(p)} disabled={disabled} aria-label={`Ask Kip to get ${title} for ${p.best ? usd(p.best.price) : ""}`}>
            Ask Kip to get this
          </button>
        ) : null}
      </div>
    </li>
  );
}

function ProductsBlock({ card, onAsk, disabled }: { card: ProductsCard; onAsk: (p: ProductCard) => void; disabled: boolean }) {
  const heading = card.mode === "image" ? "Looks like your photo" : card.mode === "similar" ? "Similar, and inside the rules" : `Results for "${card.query}"`;
  return (
    <section className="rise mt-2" aria-label={heading} data-testid={`products-${card.mode}`}>
      <div className="mb-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
        <p className="text-[13px] font-bold">{heading}</p>
        <span className="inline-flex items-center gap-1 rounded-full bg-[var(--color-pond-soft)] px-2 py-0.5 text-[11px] font-bold text-[var(--color-pond-deep)]" data-testid="channel3-badge">
          Results from Channel3{card.mode === "image" ? " image search" : card.mode === "similar" ? " similar products" : ""}
        </span>
        {card.cached ? <span className="rounded-full bg-[var(--color-sand)] px-2 py-0.5 text-[11px] font-semibold text-[var(--color-ink-2)]">cached result</span> : null}
      </div>
      <p className="mb-2 text-xs text-[var(--color-ink-2)]">
        Filters from the mandate: in stock{card.filters.maxPrice !== null ? `, up to ${usd(card.filters.maxPrice)}` : ""}. Labels are computed by code from the rules.
      </p>
      <ul className="scroll-soft -mx-1 flex snap-x gap-3 overflow-x-auto px-1 pb-2" tabIndex={0} aria-label={`${card.products.length} products, scroll sideways`}>
        {card.products.map((p) => (
          <ProductTile key={p.id} p={p} card={card} onAsk={onAsk} disabled={disabled} />
        ))}
      </ul>
    </section>
  );
}

function ReceiptBlock({ ledgerId, state }: { ledgerId: string; state: ClientState }) {
  const safeText = useSafeText();
  const e = state.ledger.find((x) => x.id === ledgerId);
  if (!e) return null;
  const refunded = e.status === "refunded";
  return (
    <section className={`rise mt-2 rounded-2xl border p-3 ${refunded ? "border-[var(--color-line)] bg-white" : "border-[#b9e4c5] bg-[var(--color-ok-soft)]"}`} aria-label="Receipt" data-testid="receipt" data-status={e.status}>
      <div className="flex items-center justify-between gap-2">
        <p className="font-display text-base font-extrabold">
          {refunded ? "Refunded" : "Paid"} {usd(e.amount.value)}
        </p>
        <StatusBadge status={e.status} />
      </div>
      <p className="mt-0.5 text-[13px] font-semibold">{safeText(e.product.title)}</p>
      <p className="mt-1 text-[13px]" data-testid="receipt-rule">
        {e.approvedBy === "parent" ? `Approved by ${state.family.parent.name}. ` : ""}
        {e.approvedBy === "parent" ? safeText(e.decision.parentLine) : safeText(e.decision.summary)}
      </p>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-xs text-[var(--color-ink-2)]">
        <dt>PayPal order</dt>
        <dd className="mono break-all">{e.paypal.orderId ?? "none"}</dd>
        <dt>Capture</dt>
        <dd className="mono break-all">{e.paypal.captureId ?? "none"}</dd>
        {e.paypal.refundId ? (
          <>
            <dt>Refund</dt>
            <dd className="mono break-all">{e.paypal.refundId}</dd>
          </>
        ) : null}
        <dt>Paid with</dt>
        <dd>{state.family.parent.name}&apos;s saved PayPal, no popup</dd>
        <dt>Store</dt>
        <dd>
          {safeText(e.product.merchant)} <span className="rounded bg-white/70 px-1 font-semibold">retailer order simulated</span>
        </dd>
      </dl>
    </section>
  );
}

function ApprovalBlock({ approvalId, state }: { approvalId: string; state: ClientState }) {
  const safeText = useSafeText();
  const a = state.approvals.find((x) => x.id === approvalId);
  if (!a) return null;
  const parent = state.family.parent.name;
  const tone = a.status === "pending" ? "border-[#f3d28a] bg-[var(--color-ask-soft)]" : a.status === "approved" ? "border-[#b9e4c5] bg-[var(--color-ok-soft)]" : "border-[var(--color-line)] bg-white";
  return (
    <section className={`rise mt-2 rounded-2xl border p-3 ${tone}`} aria-label="Parent approval" data-testid="approval-wait" data-status={a.status}>
      <div className="flex items-center gap-2">
        {a.status === "pending" ? <Kip mood="wait" size={40} decorative /> : null}
        <div>
          <p className="font-display text-base font-extrabold">{a.status === "pending" ? `Waiting for ${parent}'s OK` : a.status === "approved" ? `${parent} approved it` : `${parent} said no this time`}</p>
          <p className="text-[13px] font-semibold">
            {safeText(a.product.title)} · {usd(a.amount.value)}
          </p>
        </div>
      </div>
      <p className="mt-1.5 text-[13px]">{safeText(a.decision.teenLine)}</p>
      {a.status === "pending" ? <p className="mt-1 text-xs text-[var(--color-ink-2)]">Nothing is charged until {parent} taps Approve.</p> : null}
    </section>
  );
}

function BlockedBlock({ card }: { card: Extract<ChatCard, { type: "blocked" }> }) {
  return (
    <section className="rise mt-2 rounded-2xl border border-[#efb9b2] bg-[var(--color-stop-soft)] p-3" aria-label="Blocked by the rules" data-testid="blocked">
      <p className="font-display text-base font-extrabold text-[var(--color-stop)]">{card.title}</p>
      {card.ruleText ? (
        <p className="mt-1 text-[13px]">
          {card.ruleN ? <span className="font-bold">Rule {card.ruleN}: </span> : null}
          <q>{card.ruleText}</q>
        </p>
      ) : null}
      <p className="mt-1 text-xs text-[var(--color-ink-2)]">Checked by code. Nothing was charged.</p>
    </section>
  );
}

function Message({ m, state, onAsk, disabled }: { m: ChatMessage; state: ClientState; onAsk: (p: ProductCard) => void; disabled: boolean }) {
  const safeText = useSafeText();
  if (m.role === "teen") {
    return (
      <li className="rise flex justify-end" data-testid="msg-teen">
        <div className="max-w-[85%]">
          {m.image ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={m.image} alt="Photo you attached" className="mb-1 ml-auto h-28 w-28 rounded-2xl border border-[var(--color-line)] object-cover" />
          ) : null}
          <p className="rounded-3xl rounded-br-lg bg-[var(--color-pond)] px-4 py-2.5 text-[15px] text-white">{m.text}</p>
          <p className="mt-0.5 text-right text-[11px] text-[var(--color-ink-3)]">
            <span className="sr-only">You, </span>
            {clock(m.at)}
          </p>
        </div>
      </li>
    );
  }
  return (
    <li className="rise flex items-start gap-2" data-testid="msg-kip">
      <Kip mood={(m.mood ?? "idle") as KipMood} size={44} className="mt-0.5 shrink-0" decorative />
      <div className="min-w-0 flex-1">
        <div className="inline-block max-w-full rounded-3xl rounded-tl-lg border border-[var(--color-line)] bg-white px-4 py-2.5">
          <p className="whitespace-pre-wrap text-[15px]">
            <span className="sr-only">Kip says: </span>
            {safeText(m.text)}
          </p>
          {m.ai ? <AiTag model={m.ai.model} className="mt-1.5" /> : null}
        </div>
        {m.cards.map((card, i) => {
          if (card.type === "products") return <ProductsBlock key={i} card={card} onAsk={onAsk} disabled={disabled} />;
          if (card.type === "receipt") return <ReceiptBlock key={i} ledgerId={card.ledgerId} state={state} />;
          if (card.type === "approval") return <ApprovalBlock key={i} approvalId={card.approvalId} state={state} />;
          if (card.type === "blocked") return <BlockedBlock key={i} card={card} />;
          return (
            <p key={i} className={`mt-2 rounded-2xl border px-3 py-2 text-[13px] ${card.tone === "warn" ? "border-[#f3d28a] bg-[var(--color-ask-soft)]" : "border-[var(--color-line)] bg-[var(--color-info-soft)]"}`} data-testid="notice">
              {card.text}
            </p>
          );
        })}
        <p className="mt-0.5 text-[11px] text-[var(--color-ink-3)]">{clock(m.at)}</p>
      </div>
    </li>
  );
}

export function TeenChat({ compact = false }: { compact?: boolean }) {
  const { state, working, send, sound } = useDemo();
  const [text, setText] = useState("");
  const [photo, setPhoto] = useState<{ base64: string; mime: string } | null>(null);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const lastSpoken = useRef<string | null>(null);
  const busy = Boolean(working);

  const count = state?.chat.length ?? 0;
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [count, working?.status, working?.steps.length]);

  // Kip's pre-rendered voice lines (public/audio). Never a live TTS call.
  useEffect(() => {
    const last = state?.chat[state.chat.length - 1];
    if (!last || last.role !== "kip" || !last.voice) return;
    if (lastSpoken.current === null) {
      lastSpoken.current = last.id;
      return;
    }
    if (lastSpoken.current === last.id) return;
    lastSpoken.current = last.id;
    if (sound) void new Audio(`/audio/kip-${last.voice}.mp3`).play().catch(() => undefined);
  }, [state?.chat, sound]);

  const prompts = useMemo(() => {
    const scripted = SCRIPTED_PROMPTS.map((p) => ({ label: p.label, text: p.text, slug: p.slug as string | null }));
    if (state?.mode === "replay") return scripted;
    return [...scripted, ...EXTRA_PROMPTS.map((t) => ({ label: t.length > 34 ? t.slice(0, 32) + "..." : t, text: t, slug: null as string | null }))];
  }, [state?.mode]);

  if (!state) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-[var(--color-ink-2)]">
        <Spinner label="Kip is waking up" />
      </div>
    );
  }

  const teen = state.family.teen.name;
  const parent = state.family.parent.name;
  const mood: KipMood = working ? (working.mood as KipMood) : state.paused ? "paused" : ((state.chat[state.chat.length - 1]?.mood ?? "idle") as KipMood);

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (busy) return;
    const t = text.trim();
    if (!t && !photo) return;
    void send(t, { image: photo });
    setText("");
    setPhoto(null);
  };

  const onAsk = (p: ProductCard) => {
    if (busy) return;
    void send(`Get me this one: ${p.title.slice(0, 80)} for ${p.best ? usd(p.best.price) : "the listed price"} (product ${p.id})`);
  };

  return (
    <div className={`flex h-full min-h-0 flex-col ${compact ? "" : "mx-auto w-full max-w-[520px]"}`} data-testid="teen-view">
      <header className="flex items-center justify-between gap-3 border-b border-[var(--color-line)] bg-white/70 px-4 py-3">
        <div className="flex items-center gap-3">
          <Kip mood={mood} size={52} className={working ? "kip-bob" : ""} />
          <div>
            <h2 className="font-display text-lg font-extrabold leading-tight">Kip</h2>
            <p className="text-xs text-[var(--color-ink-2)]">
              {teen}&apos;s shopping buddy. Pays with {parent}&apos;s PayPal, inside {parent}&apos;s rules.
            </p>
          </div>
        </div>
        <BudgetPill state={state} />
      </header>

      {state.paused ? (
        <p className="border-b border-[#f3d28a] bg-[var(--color-ask-soft)] px-4 py-2 text-[13px] font-semibold text-[var(--color-ask)]" role="status" data-testid="teen-paused">
          {parent} paused Kip&apos;s spending. Kip can still search and compare.
        </p>
      ) : null}

      <div ref={listRef} className="scroll-soft min-h-0 flex-1 overflow-y-auto px-4 py-4" tabIndex={0} aria-label="Conversation with Kip">
        {state.chat.length === 0 && !working ? (
          <div className="flex flex-col items-center gap-2 py-6 text-center">
            <Kip mood="happy" size={112} />
            <p className="font-display text-xl font-extrabold">Hey {teen}, I&apos;m Kip.</p>
            <p className="max-w-xs text-sm text-[var(--color-ink-2)]">
              Tell me what you need. I search real stores, compare a few options and pay with {parent}&apos;s saved PayPal when the rules allow it. If they don&apos;t, I ask {parent} for you.
            </p>
          </div>
        ) : null}
        <ol className="flex flex-col gap-4" role="log" aria-live="polite" aria-relevant="additions" aria-label="Messages">
          {state.chat.map((m) => (
            <Message key={m.id} m={m} state={state} onAsk={onAsk} disabled={busy} />
          ))}
          {working ? (
            <>
              {working.pendingText ? (
                <li className="flex justify-end">
                  <div className="max-w-[85%]">
                    {working.pendingImage ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={working.pendingImage} alt="Photo you attached" className="mb-1 ml-auto h-28 w-28 rounded-2xl border border-[var(--color-line)] object-cover" />
                    ) : null}
                    <p className="rounded-3xl rounded-br-lg bg-[var(--color-pond)] px-4 py-2.5 text-[15px] text-white">{working.pendingText}</p>
                  </div>
                </li>
              ) : null}
              <li className="flex items-start gap-2" data-testid="kip-working">
                <Kip mood={working.mood as KipMood} size={44} className="kip-bob mt-0.5 shrink-0" decorative />
                <div className="rounded-3xl rounded-tl-lg border border-[var(--color-line)] bg-white px-4 py-2.5">
                  <p className="text-[15px] font-semibold text-[var(--color-pond-deep)]" data-testid="kip-status">
                    <Spinner label={working.status} />
                  </p>
                  {working.steps.length > 0 ? (
                    <ul className="mt-1.5 space-y-0.5 text-xs text-[var(--color-ink-2)]" aria-label="What Kip has done so far">
                      {working.steps.slice(-4).map((s) => (
                        <li key={s.id} className="flex gap-1.5">
                          <span aria-hidden="true">·</span>
                          <span>{s.title}</span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              </li>
            </>
          ) : null}
        </ol>
      </div>

      <div className="border-t border-[var(--color-line)] bg-white/80 px-4 pb-4 pt-3">
        <div className="scroll-soft -mx-1 mb-2 flex gap-2 overflow-x-auto px-1 pb-1" role="group" aria-label="Things to ask Kip">
          {prompts.map((p) => (
            <button key={p.text} type="button" className="btn btn-quiet btn-sm shrink-0" disabled={busy} onClick={() => void send(p.text, { slug: p.slug })} data-testid={p.slug ? `prompt-${p.slug}` : undefined}>
              {p.label}
            </button>
          ))}
        </div>
        {photo ? (
          <div className="mb-2 flex items-center gap-2 text-xs text-[var(--color-ink-2)]">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={`data:${photo.mime};base64,${photo.base64}`} alt="Attached photo preview" className="h-12 w-12 rounded-lg border border-[var(--color-line)] object-cover" />
            <span>Photo attached. Kip will look for something like it.</span>
            <button type="button" className="font-semibold text-[var(--color-pond-deep)] underline" onClick={() => setPhoto(null)}>
              Remove
            </button>
          </div>
        ) : null}
        {photoError ? (
          <p className="mb-2 text-xs font-semibold text-[var(--color-stop)]" role="alert">
            {photoError}
          </p>
        ) : null}
        <form onSubmit={submit} className="flex items-end gap-2">
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="sr-only"
            id="kip-photo"
            data-testid="photo-input"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (!f) return;
              setPhotoError(null);
              try {
                setPhoto(await fileToJpegBase64(f));
              } catch (err) {
                setPhotoError((err as Error).message);
              }
            }}
          />
          <button type="button" className="btn btn-quiet h-11 w-11 shrink-0 !p-0" onClick={() => fileRef.current?.click()} disabled={busy || state.mode === "replay"} aria-label="Attach a photo so Kip can find something like it" title={state.mode === "replay" ? "Photo search is available in Live mode" : "Attach a photo"}>
            <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 8h3l2-3h6l2 3h3v11H4z" />
              <circle cx="12" cy="13" r="3.5" />
            </svg>
          </button>
          <label htmlFor="kip-input" className="sr-only">
            Message to Kip
          </label>
          <textarea
            id="kip-input"
            data-testid="chat-input"
            rows={1}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder={state.mode === "replay" ? "Replay: pick a request above" : "Ask Kip for something"}
            className="max-h-28 min-h-11 flex-1 resize-none rounded-3xl border-[1.5px] border-[var(--color-line)] bg-white px-4 py-2.5 text-[15px] placeholder:text-[var(--color-ink-3)]"
            maxLength={600}
          />
          <button type="submit" className="btn btn-primary h-11 shrink-0" disabled={busy || (!text.trim() && !photo)} data-testid="chat-send">
            Send
          </button>
        </form>
      </div>
    </div>
  );
}
