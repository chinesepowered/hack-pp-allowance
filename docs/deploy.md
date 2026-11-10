# Hosted demo: how it was deployed

The hosted demo is https://hack-pp-allowance.vercel.app. Everything runs against the PayPal sandbox.

## Steps

1. A Vercel project from this repository (Next.js, pnpm). No build settings changed.
2. A private Vercel Blob store connected to the project, which sets `BLOB_READ_WRITE_TOKEN`. `BLOB_ACCESS=private`.
3. Every variable from `.env.example` set on Vercel, except the sandbox buyer login and `ELEVENLABS_API_KEY`. The
   running app uses neither.
4. `pnpm seed`, run once from a machine with the same variables plus the production Blob token. It saves the sandbox
   buyer's PayPal (Playwright approves in PayPal's window) and makes three small sandbox purchases. Safe to re-run.
5. `pnpm paypal:webhook https://hack-pp-allowance.vercel.app`, then `PAYPAL_WEBHOOK_ID` set on Vercel and a redeploy.
6. `GET /api/health` reports `"store":"blob"`, `"seeded":true` and `"webhookId":true`.

## Checked on the hosted demo

- The main flow, live against the sandbox: a purchase inside the rules, a parent approval, a blocked request and an
  undo, which is a PayPal refund.
- A real PayPal webhook delivery, with its signature verified.
- The parent setup from an empty family: PayPal's save window on the real domain, then drafting and signing a mandate.

## Known gap

The PayPal Agent Toolkit does not load in the Vercel function yet (`Cannot find module '@paypal/agent-toolkit/openai'`
in the function logs), so hosted purchases take the Server SDK path behind the same mandate check.

## Sandbox buyer login

The sandbox buyer's email and password are not in this repository. Judges get them in the Devpost submission's
testing instructions. The main flow needs no login.
