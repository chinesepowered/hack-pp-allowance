"use client";

/**
 * "Save PayPal for Kip": the PayPal JS SDK v6 save-payment flow.
 *
 *   1. GET /api/paypal/client-token        browser-safe client token
 *   2. paypal.createInstance({ clientToken, components: ["paypal-payments"] })
 *   3. sdk.createPayPalSavePaymentSession({ onApprove })
 *   4. on click: session.start({ presentationMode: "auto" }, <promise of a
 *      vault setup token from POST /api/paypal/vault/setup-token>)
 *   5. the parent approves in PayPal's own window
 *   6. onApprove: POST /api/paypal/vault/payment-token exchanges the setup
 *      token for the payment token, which stays on the server
 *
 * No card or login detail ever touches this app.
 */
import { useEffect, useRef, useState } from "react";
import { useDemo } from "./demo-context";
import { Spinner } from "./ui";

type SaveSession = { start(opts: { presentationMode: string }, setupToken: Promise<{ vaultSetupToken: string }>): Promise<void> };
type Methods = { isEligible(method: string): boolean };
type SdkInstance = {
  findEligibleMethods(opts: { currencyCode: string; paymentFlow?: string }): Promise<Methods>;
  createPayPalSavePaymentSession(opts: { onApprove(data: { vaultSetupToken: string }): void | Promise<void>; onCancel?(): void; onError?(err: unknown): void }): SaveSession;
};
type PayPalGlobal = { createInstance(opts: { clientToken: string; components: string[]; pageType?: string; locale?: string }): Promise<SdkInstance> };

declare global {
  interface Window {
    paypal?: PayPalGlobal;
  }
}

const SDK_URL = "https://www.sandbox.paypal.com/web-sdk/v6/core";

function loadSdk(): Promise<PayPalGlobal> {
  return new Promise((resolve, reject) => {
    if (window.paypal?.createInstance) return resolve(window.paypal);
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${SDK_URL}"]`);
    const script = existing ?? document.createElement("script");
    const done = () => (window.paypal?.createInstance ? resolve(window.paypal) : reject(new Error("The PayPal SDK loaded without createInstance.")));
    script.addEventListener("load", done);
    script.addEventListener("error", () => reject(new Error("Could not load the PayPal SDK. Check the network and any content blockers.")));
    if (!existing) {
      script.src = SDK_URL;
      script.async = true;
      document.head.appendChild(script);
    }
  });
}

export function PayPalSaveButton({ onSaved }: { onSaved?: () => void }) {
  const { state, vaultSetupToken, vaultFinish } = useDemo();
  const [phase, setPhase] = useState<"loading" | "ready" | "window" | "saving" | "error" | "ineligible">("loading");
  const [message, setMessage] = useState<string | null>(null);
  const sessionRef = useRef<SaveSession | null>(null);
  const buttonRef = useRef<HTMLElement | null>(null);
  const startRef = useRef<() => void>(() => undefined);
  const savedRef = useRef(onSaved);
  const finishRef = useRef(vaultFinish);
  const replay = state?.mode === "replay";

  // Keep the latest callbacks reachable from the PayPal session, which is
  // created once.
  useEffect(() => {
    savedRef.current = onSaved;
    finishRef.current = vaultFinish;
  });

  useEffect(() => {
    if (replay) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/paypal/client-token", { cache: "no-store" });
        const data = (await res.json()) as { clientToken?: string; error?: string };
        if (!res.ok || !data.clientToken) throw new Error(data.error ?? "Could not start PayPal.");
        const paypal = await loadSdk();
        const sdk = await paypal.createInstance({ clientToken: data.clientToken, components: ["paypal-payments"], pageType: "checkout", locale: "en-US" });
        const methods = await sdk.findEligibleMethods({ currencyCode: "USD", paymentFlow: "VAULT_WITHOUT_PAYMENT" });
        if (cancelled) return;
        if (!methods.isEligible("paypal")) {
          setPhase("ineligible");
          setMessage("PayPal says saving a PayPal wallet is not available for this sandbox app. Vault may need to be enabled on the app.");
          return;
        }
        sessionRef.current = sdk.createPayPalSavePaymentSession({
          onApprove: async (approved) => {
            setPhase("saving");
            const ok = await finishRef.current(approved.vaultSetupToken);
            if (ok) savedRef.current?.();
            else {
              setPhase("error");
              setMessage("PayPal approved, but the payment token could not be created. Try again.");
            }
          },
          onCancel: () => {
            setPhase("ready");
            setMessage("You closed PayPal's window before saving. Nothing was saved.");
          },
          onError: (err) => {
            setPhase("error");
            setMessage(err instanceof Error ? err.message : "PayPal reported a problem. Nothing was saved.");
          },
        });
        setPhase("ready");
      } catch (err) {
        if (!cancelled) {
          setPhase("error");
          setMessage((err as Error).message);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [replay]);

  const start = async () => {
    setMessage(null);
    if (replay) {
      // Replay has no PayPal window: the two vault calls are answered from
      // the recorded tape.
      setPhase("saving");
      try {
        const id = await vaultSetupToken();
        if (await vaultFinish(id)) onSaved?.();
        else setPhase("ready");
      } catch (err) {
        setPhase("error");
        setMessage((err as Error).message);
      }
      return;
    }
    const session = sessionRef.current;
    if (!session) return;
    setPhase("window");
    try {
      // Pass the promise itself. Awaiting it first would lose the click's
      // user activation and the popup would be blocked.
      const tokenPromise = vaultSetupToken().then((id) => ({ vaultSetupToken: id }));
      await session.start({ presentationMode: "auto" }, tokenPromise);
    } catch (err) {
      setPhase("error");
      setMessage(err instanceof Error ? err.message : "PayPal's window could not be opened.");
    }
  };

  useEffect(() => {
    startRef.current = () => void start();
  });
  useEffect(() => {
    const el = buttonRef.current;
    if (!el || replay) return;
    const onClick = () => startRef.current();
    el.addEventListener("click", onClick);
    return () => el.removeEventListener("click", onClick);
  }, [replay, phase]);

  return (
    <div data-testid="paypal-save">
      {phase === "loading" && !replay ? (
        <p className="text-sm text-[var(--color-ink-2)]">
          <Spinner label="Loading PayPal" />
        </p>
      ) : null}
      {replay ? (
        <button type="button" onClick={() => void start()} disabled={phase === "saving"} className="btn btn-primary w-full max-w-[340px]" data-testid="paypal-save-button">
          {phase === "saving" ? "Saving" : "Save PayPal (replay, no window)"}
        </button>
      ) : (
        <div className={phase === "loading" || phase === "ineligible" ? "hidden" : ""}>
          <p className="mb-1.5 text-sm font-semibold" id="paypal-save-label">
            Save PayPal for Kip&apos;s purchases
          </p>
          {/* PayPal's own v6 web component. The click handler is attached in an effect. */}
          <paypal-button ref={buttonRef} className="paypal-gold" aria-labelledby="paypal-save-label" data-testid="paypal-save-button" />
          {phase === "window" || phase === "saving" ? (
            <p className="mt-2 text-sm font-semibold text-[var(--color-pond-deep)]" role="status">
              <Spinner label={phase === "window" ? "Waiting for you in PayPal's window" : "Saving"} />
            </p>
          ) : null}
        </div>
      )}
      <p className="mt-2 text-xs text-[var(--color-ink-2)]">
        {replay
          ? "Replay mode: PayPal's approval window is skipped and the recorded Vault responses are used."
          : "Opens PayPal's own window. You log in and approve there. This is the PayPal sandbox: use the sandbox test buyer login, never a real account."}
      </p>
      {message ? (
        <p className={`mt-2 text-sm font-semibold ${phase === "error" || phase === "ineligible" ? "text-[var(--color-stop)]" : "text-[var(--color-ink-2)]"}`} role={phase === "error" || phase === "ineligible" ? "alert" : "status"}>
          {message}
        </p>
      ) : null}
    </div>
  );
}
