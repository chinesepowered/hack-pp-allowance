# Devpost submission text

The text used for the Devpost submission.

## Project name

Allowance

## Tagline (under 200 characters)

A shopping agent for teens that pays with the family's PayPal, but only inside rules a parent signs. Inside the rules it buys at once. Outside them it asks, or says no.

## Links

- Hosted demo: https://hack-pp-allowance.vercel.app
- Video: https://youtu.be/NgeQTCp-CLY
- Repository: https://github.com/chinesepowered/hack-pp-allowance

## Inspiration

A teenager needs notebooks, a calculator, a pair of sneakers. A parent has two options today, and both are bad. Hand
over the card, and there are no limits. Or approve every purchase, and the parent becomes the bottleneck for a pack of
pens.

PayPal's theme for this hackathon is AI that actually transacts, not just recommends. That is exactly the thing a
family cannot use yet, because letting an agent pay means handing it the card. We wanted the missing layer: a way to
let an agent spend real money without trusting it with the decision.

## What it does

Allowance is a shopping agent for 13 to 17 year olds, with a parent in charge.

1. **The parent sets up once, in about two minutes.** They save their PayPal in PayPal's own window (PayPal Vault), then
   write the rules in plain English: "Up to $60 a week. School supplies and books any time. Clothes up to $40 an item.
   No gaming or gift cards. Anything over $25 from a store we haven't used before needs my OK." The AI turns that into
   a structured mandate, a schema validates it, and the parent signs it.
2. **The teen asks Kip,** a capybara in a bucket hat. Kip searches real retailers through Channel3 with the price cap
   taken from the mandate, compares two or three options and explains the pick. A photo works too: "something like
   this, under $40".
3. **Code checks the rules, not the model.** There are three outcomes.
   - Inside the rules: Kip pays at once with the saved PayPal. No popup. The receipt quotes the rule that allowed it.
   - Over a cap, a new store, or not covered: the parent gets an approval card with Kip's reasoning and the exact rule.
     Approve, Decline, or "Approve and add a rule".
   - Blocked: Kip explains kindly, quotes the rule, and suggests something the rules allow.
4. **The parent stays in charge.** A ledger shows every purchase with the rule it relied on and the PayPal order and
   capture ids. Undo refunds a purchase through PayPal for 24 hours. One switch pauses Kip instantly. Kip writes a
   weekly note from the ledger.

An Under the hood drawer shows every PayPal call the session made, with its `PayPal-Debug-Id`, and Kip's reasoning
trail including each policy check.

## How we built it

- **Next.js (App Router) and TypeScript**, deployable to Vercel as is. State is a small JSON document store: files in
  development, Vercel Blob in production. PayPal stays the source of truth for money.
- **PayPal.** Vault v3 setup tokens and payment tokens to save the parent's PayPal, approved through the JS SDK v6
  save-payment session. Orders v2 with `payment_source.paypal.vault_id` to charge it with no popup. Payments v2 refunds
  for Undo. Webhooks with signature verification and idempotent handlers, plus re-reading PayPal on every money screen
  so nothing depends on delivery.
- **The agent cannot pay.** Kip is a tool-calling loop. Its `create_order` tool accepts a product id and a sentence of
  reasoning, nothing else. The wrapper checks the product came from a Channel3 search, re-reads the price, classifies
  the product, and runs a deterministic policy check against the signed mandate. Only then does code call the PayPal
  Agent Toolkit's `create_order`, and the vaulted payment source is attached server-side by an interceptor. The model
  never sees it.
- **The mandate** is signed JSON (HMAC-SHA256 over its canonical form) and is verified before every purchase. It
  follows the intent mandate idea from agent payment protocols such as AP2, without claiming AP2 compliance.
- **Channel3** for text search with mandate filters, image search, similar products and product detail.
- **W&B Inference** for the models, through the OpenAI SDK.
- **Replay mode** runs the same code with recorded sandbox, Channel3 and model responses, for when a service is down.
  The same recordings drive an offline end-to-end test.
- **89 automated tests** cover the money rules, the mandate, the PayPal write path, webhooks and the whole flow.

## Challenges we ran into

- **Create and capture are one call.** An order created with a vaulted PayPal and intent CAPTURE comes back already
  completed, capture included. We planned for two calls and found one.
- **The Agent Toolkit's `create_order` has no vault field,** always adds a buyer-approval context, talks to a different
  host name than the Server SDK, never refreshes its token and never sends `PayPal-Request-Id` per call. We wrapped it:
  an interceptor on the toolkit's own axios instance swaps in the vaulted payment source after the mandate check, adds
  the idempotency key and captures the debug id.
- **A reasoning model with a small token budget returns nothing.** The text model spent its whole budget on reasoning
  and gave empty content. Turning reasoning off for labeling made classification four times faster.
- **With reasoning off, the model sometimes skipped tools,** answered from memory of the rules, and once imitated our own
  history notes with a fake "paid" line. Nothing was charged, because the guard refuses unknown products, but it told
  us the rule had to be: a blocked request is blocked by code whatever the model does. Every shopping request is now
  screened in code alongside the model's first turn.
- **Product detail lists second-hand offers.** Kip briefly charged $5 for a $17 calculator because a used offer was
  cheapest. Kip now buys only new, in-stock offers from the store the teen was shown.
- **The client token rejects localhost** as a domain, and Playwright sends localhost through a proxy unless told not to.
- **The APIMatic Context Plugin documents a newer generated package** than the Server SDK we were pinned to, so we used
  its method (the contract sheet) and looked the SDK facts up in the installed source.

## Accomplishments that we're proud of

- The agent really transacts in the PayPal sandbox, and there is no path by which the model can move money on its own.
- A parent can read the mandate as a card, and an engineer can read it as signed JSON, and they say the same thing.
- Every receipt says which rule allowed it. Every refusal quotes the rule that stopped it.
- The whole aha runs offline in a test, against real recorded responses.
- Kip. A capybara in a bucket hat turned out to be the right tone for telling a fifteen year old "not this one".

## What we learned

- Put the money decision in code and let the model argue for a product, not for a payment.
- Idempotency keys belong to the thing being paid, not to the attempt.
- "No answer" from a payment API means unknown, not failed, and has to be re-read before anything else happens.
- Agent payment mandates are easier to trust when the person can read them in their own words.

## What's next for Allowance

- Pay retailers directly through PayPal's agentic commerce services, so the simulated retailer step becomes real.
- Parent sign-in with passkeys and a mandate signed by a key the parent holds.
- Push notifications for approvals, more than one teen per family, savings goals.
- Returns, partial refunds, shipping and tax inside the policy check.

## Built with

Next.js, React, TypeScript, Tailwind CSS, PayPal Vault v3, PayPal Orders v2, PayPal Payments v2, PayPal Webhooks,
PayPal JS SDK v6, PayPal Agent Toolkit, PayPal Server SDK, APIMatic PayPal Context Plugin, Channel3, W&B Inference,
OpenAI SDK, Zod, Vercel, Vercel Blob, Vitest, Playwright, ElevenLabs, FFmpeg

## Tools: which AI models and services were used, and how

| Tool | How it was used |
| --- | --- |
| `Qwen/Qwen3.8-27B` on W&B Inference | Kip's tool-calling loop, turning rules into a mandate draft, classifying products into mandate categories with a confidence score, the note to the parent, the weekly note |
| `google/gemma-4-31B-it` on W&B Inference | describing the teen's photo before image search |
| `zai-org/GLM-5.3-Flash` on W&B Inference | fallback when the main model keeps failing |
| Channel3 | product search with price and stock filters from the mandate, image search, similar products, product detail with offers across retailers |
| ElevenLabs | the video narration and Kip's short voice lines, pre-rendered. The app never calls it. |
| Claude Code | AI coding agent used to build the app, tests, docs and video pipeline from a written brief, with the APIMatic PayPal Context Plugin skills |
| Playwright | approves the one-time PayPal save in the seed script, and records the demo video from real runs |

The AI never decides a payment. It proposes; code checks the signed mandate; a parent approves when the rules say so.

## PayPal products used

- **Vault v3**: setup tokens and payment tokens for the parent's saved PayPal wallet
- **JS SDK v6**: the save-payment session and `<paypal-button>` for approving in PayPal's window
- **Orders v2**: create with `payment_source.paypal.vault_id`, get, and capture as a fallback
- **Payments v2**: capture lookup and refunds
- **Webhooks**: `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.DENIED`, `PAYMENT.CAPTURE.REFUNDED`,
  `PAYMENT.CAPTURE.REVERSED`, `VAULT.PAYMENT-TOKEN.CREATED`, `VAULT.PAYMENT-TOKEN.DELETED`, with signature verification
- **Agent Toolkit** (`@paypal/agent-toolkit`): `create_order`, `get_order`, `create_refund`, wrapped behind the mandate
  check
- **Server SDK** (`@paypal/paypal-server-sdk`)

Everything runs in the sandbox. In this prototype Allowance charges the family's PayPal through its own sandbox
merchant account, and the retailer order step is simulated and labeled as simulated.

## Sponsor tools used

- **Channel3**: the catalog behind every shopping turn. Text search with filters from the mandate, image search,
  similar products to offer an alternative inside the rules, and product detail for offers and buy links. The UI marks
  its results "Results from Channel3".
- **APIMatic**: the PayPal Server SDK it generates carries the Vault calls, seed purchases and lookups. The PayPal
  Context Plugin's TypeScript skills are in the repository, and its integration workflow produced the contract sheet in
  `paypal-plan.md`: durable writes, unknown outcomes, optional request fields and the error mapping.

## Testing instructions for judges

- Open the hosted demo. It starts with a saved PayPal and a signed mandate, so no login is needed.
- Ask Kip for "Notebooks for school", then "Sneakers, about $55", then "Game top-up". Switch to Dana (parent) to
  approve, undo and pause. Open "Under the hood" for the PayPal calls.
- To try the parent setup: Demo menu, "Start from an empty family", then "Save PayPal", and log in to PayPal's sandbox
  window with the sandbox test buyer given in the Devpost submission's testing instructions (the login is not in the
  repository).
- If the sandbox or the model is down, switch to Replay (top right).
- Sandbox only. No real money moves.
