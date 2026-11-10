# Allowance (working name)

**PayPal AI Hackathon** (paypalaihackathon.devpost.com). Built in Claude Code web from this repo. This file is the
whole brief: read all of it, including the shared rules at the end, before you start.

**Prize targets:** Best Use of Agentic Commerce, the grand prizes. Sponsor prize: **Channel3** (also eligible for
APIMatic).

## The idea

A shopping agent for teenagers that pays with the family's PayPal, but only inside rules a parent sets.

Today a teen either borrows a parent's card (no limits) or asks before every purchase (the parent becomes the
bottleneck). PayPal's pitch for this hackathon is AI that actually transacts, not just recommends. Families need a way
to let an agent pay without handing it the card. Allowance is that layer: a signed spending mandate, an agent that
shops across real retailers, and a parent who only gets pinged when it matters.

**Who it's for:** parents of 13 to 17 year olds who already give an allowance or pay for school things, and the teens
themselves.

## The flow

1. **Parent setup (about 2 minutes).**
   - The parent saves their PayPal once for future agent purchases (PayPal Vault; the parent approves in PayPal's window).
   - The parent writes the rules in plain English, for example: "Up to $60 a week. School supplies and books any time.
     Clothes up to $40 an item. No gaming or gift cards. Anything over $25 from a store we haven't used before needs my
     OK."
   - The AI turns that into a structured **mandate**: weekly budget, allowed and blocked categories, per-item caps,
     merchant rules, approval thresholds, expiry. The parent reviews it as a readable card and signs it.
   - Store the mandate as signed JSON (HMAC with `MANDATE_SIGNING_SECRET`), and show the version and signature on the
     card. This is the "intent mandate" idea from agent payment protocols such as AP2; say so in the README, without
     claiming AP2 compliance.
2. **The teen asks Kip** (the capybara buddy), by chat: "I need a graphing calculator for algebra, the cheaper the
   better". Kip searches **Channel3** with filters taken from the mandate (price cap, in stock), compares two or three
   options (price, retailer, key specs) and explains the pick.
   - Image search: the teen snaps a friend's backpack and asks for "something like this under $40".
3. **Policy check, in code, not the model.** The code checks the category, item price, the budget left this week, and
   the merchant rules. There are three outcomes:
   - **Auto-approved.** Kip pays at once with the saved PayPal: Orders v2 with `payment_source.paypal.vault_id`, then
     capture, with no popup. The receipt says which rule allowed it ("Paid under rule 2: school supplies").
   - **Needs parent OK.** The parent view gets an approval card with Kip's reasoning and the exact rule it would break.
     The parent taps Approve or Decline, or "Approve and add a rule".
   - **Blocked.** Kip explains kindly, quotes the rule and suggests something within the rules.
4. **Ledger:** every agent purchase, with the mandate rule it relied on, the PayPal order and capture ids, and a weekly
   budget bar. The parent gets an **Undo** for 24 hours, which refunds through PayPal.
5. **Pause:** a parent kill switch revokes the mandate instantly. Kip says so and stops buying.
6. A weekly summary for the parent, written by the AI from the ledger.

**Merchant of record, said honestly.** In this prototype, Allowance charges the family's saved PayPal through its own
sandbox merchant account. It then hands off to the retailer through Channel3's buy link. The retailer order step is
simulated and labeled as simulated. In production, this is where PayPal's agentic commerce services would let the agent
pay retailers directly. Say this plainly in the README.

## PayPal integration
- **Vault v3** for the parent's saved PayPal: setup tokens and payment tokens, or save-with-purchase through Orders
  `payment_source.paypal.attributes.vault`. Check the toolkit references for the current recommended flow and for JS
  SDK v6 support.
- **Orders v2:** create with `vault_id`, capture, and get.
- **Refunds:** for Undo.
- **Webhooks:** `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.REFUNDED`, `VAULT.PAYMENT-TOKEN.CREATED`, and anything
  else you use.
- **Agent Toolkit tools** (`create_order`, `get_order`, `create_refund`), wrapped so the model cannot reach
  `create_order` without the mandate check passing in code.

## Channel3 (the sponsor prize)
- Package `@channel3/sdk`; the key is in `CHANNEL3_API_KEY`. REST is `POST https://api.trychannel3.com/v1/search` with
  an `x-api-key` header. Docs index: https://channel3.ai/docs/llms.txt.
- Use the following, each visibly in the product:
  - text search with price and availability filters set from the mandate
  - image search
  - similar products, to suggest an alternative inside the rules
  - product details: offers across retailers, buy links
- The sponsor's bar: Channel3 must be a meaningful, called part of the experience. Show "Results from Channel3" in the
  UI.
- Credits: 1,000 free a month plus a hackathon promo on this key. Cache responses in development and in fixtures.
- Pick searches whose results don't put famous logos in frame for the video: calculator, notebooks, water bottle, desk
  lamp, rain jacket. Keep product images modest in size.

## AI
- Turn the rules into a mandate: the LLM proposes JSON, a Zod schema validates it, and the parent confirms it.
- Understand the request, compare products and write the explanation.
- Classify each product into mandate categories with a confidence score. Low confidence means it needs the parent's OK.
- Write the weekly summary.
- All of it runs on the W&B models in the shared rules.

## Mascot
**Kip**, a young capybara in a bucket hat with a tiny backpack. Casual with the teen, polite and precise with the
parent. Kip is used across the app: the chat persona, loading states ("Kip is checking the rules"), success states
and empty states.

## Screens
- The teen's chat (mobile first).
- The parent's dashboard: the mandate card, approvals, the ledger, the budget, pause.
- The Under the hood drawer.
- A way to switch between parent and teen in one browser for the demo, such as a role switcher or two panes.

## Demo data
- A fictional family: parent Dana and teen Leo, 15. The sandbox buyer is Dana's PayPal.
- `pnpm seed` saves the vault token by approving once with Playwright, and creates two or three past purchases so the
  ledger isn't empty.

## The aha (first 40 seconds of the video)
The same teen makes three requests in 30 seconds:
- Notebooks are bought instantly with the saved PayPal, with no popup and the rule quoted.
- $55 sneakers wait for Dana's tap on her phone, then get paid.
- A gaming top-up is declined kindly, with the rule quoted.

## Video outline
1. Cold open on the problem.
2. Dana writes rules in plain English, and the mandate card appears.
3. Leo asks Kip. Channel3 results arrive, and Kip pays (PayPal order captured, with Under the hood showing the calls).
4. The over-limit item, Dana's approval, then the capture.
5. The blocked request.
6. Dana's Undo, then the refund.
7. One limitation: the retailer handoff is simulated.
8. End card.

## Keys for this build
- `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` (sandbox app `hack-pp-allowance`, with Vault enabled),
  `NEXT_PUBLIC_PAYPAL_CLIENT_ID` (same value as the client id), `PAYPAL_ENVIRONMENT=sandbox`.
- `PAYPAL_SANDBOX_BUYER_EMAIL`, `PAYPAL_SANDBOX_BUYER_PASSWORD`: Dana's PayPal. Playwright uses it for the one-time
  save, and judges can use it.
- `CHANNEL3_API_KEY`.
- `OPENAI_BASE_URL`, `OPENAI_API_KEY`, `OPENAI_MODEL`, `OPENAI_VISION_MODEL`, `OPENAI_FALLBACK_MODEL`.
- `ELEVENLABS_API_KEY`.
- Generate these yourself: `MANDATE_SIGNING_SECRET`, `DEMO_ADMIN_TOKEN`.

## Risks and fallbacks
- If vaulting a PayPal wallet fails in the sandbox, write it in `docs/needs-user.md` (the user may need to tick a
  feature on the app). Meanwhile, build the agent path against a vaulted sandbox test card and say so in the README.
- If Channel3 is slow or out of credits, serve cached results and label them.
- **Cut first if short on time:** image search, the weekly summary, polish on the pause flow.

---

## Shared rules (all six PayPal builds)

Six different builds from the same team share these rules. Stay inside this build's idea.

### Deadline and split
- Devpost submissions close **Thu Nov 12 2026, 12:00 PM PT**. Push the finished app, README, screenshots, Devpost
  drafts and the video to `main` by **Wed Nov 11, 9:00 PM PT**. If something isn't done by then, push what works and keep
  going; the local session takes the last push before 6:00 AM PT Thu.
- Suggested order: **Mon Nov 9** the PayPal flow working end to end in the sandbox, the seed script and the AI core;
  **Tue Nov 10** the sponsor tool, the full UI and Replay mode; **Wed Nov 11** polish, tests, screenshots, video, docs.
- You (cloud) build and test everything, record the video and write the docs. The local session deploys to Vercel,
  registers the webhook, uploads the video to YouTube, makes the repo public and submits on Devpost. Don't make the repo
  public, don't deploy and don't submit.
- If you are blocked on something only the user can do (a PayPal dashboard setting, a manual sandbox step), write it at
  the top of `docs/needs-user.md`, mention it in your next message, and carry on with everything else.

### What the hackathon requires
- Meaningful use of at least one PayPal developer technology in the **sandbox**, and meaningful use of AI. A working
  prototype: judges must be able to run or click it (we provide a hosted URL; the README also has full run
  instructions). A design mockup or static prototype doesn't count.
- Public repo with all source, assets and run instructions, and an open-source license GitHub detects. `LICENSE`
  (AGPL-3.0) is already in the repo; add `TRADEMARKS.md` reserving the product name and mascot.
- A demo video under 3 minutes that shows the project working end to end, with no third-party trademarks and no
  copyrighted music. PayPal's own UI is fine (PayPal is the sponsor). Keep other brands' logos out of frame.
- Stage one is pass/fail: the project fits the theme and really uses PayPal. Stage two scores, equally weighted:
  **Technological Implementation** (thorough, skillful, non-trivial use of PayPal and AI), **Design** (a complete,
  coherent product, not a proof of concept), **Potential Impact** (a credible, specific problem for a real audience,
  shown being solved), **Innovation**, and **Presentation** (the video shows it working end to end and says who it's for
  and why it matters).
- A project can win one main prize plus one sponsor prize. Every build also uses APIMatic (below), so it stays eligible
  for that sponsor prize on top of its own.
- Sandbox only. Never use live PayPal credentials or real money, and don't sign up for paid services.

### PayPal, done the way PayPal's judges will look for it
- Before writing PayPal code, read the PayPal AI Toolkit: `git clone https://github.com/paypal/AI-Toolkit
  /tmp/paypal-ai-toolkit` and read its skills, especially `paypal-best-practices` and the SDK v5 and v6 references.
- Install APIMatic's PayPal Context Plugin skills for TypeScript into this repo and use them while building the PayPal
  integration: `npx skills add https://github.com/context-plugins/plugin-marketplace/tree/main/plugins/paypal/skills/typescript`
  (if that fails: `npx context-plugins install paypal`, or clone `context-plugins/plugin-marketplace` and read
  `plugins/paypal`). The APIMatic prize is for builds that used the Context Plugin, so say in the README how you used it.
- Server calls: `@paypal/paypal-server-sdk` (2.5.x, generated by APIMatic) wherever it covers the API; plain REST with
  the same OAuth token helper for anything it doesn't (Disputes, Payouts, Invoicing, Subscriptions, Webhooks as needed).
  Base URL `https://api-m.sandbox.paypal.com`. Send a `PayPal-Request-Id` on every POST.
- The agent's PayPal tools come from `@paypal/agent-toolkit` (1.11.x) where it has them (orders, refunds, invoices,
  disputes, subscriptions, shipment tracking, transactions). Wrap any tool that moves money so it enforces this app's
  rules in code before PayPal is called. Write your own tools for the rest.
- Browser checkout: PayPal **JS SDK v6** where it supports the flow. If a flow isn't in v6 yet (check the toolkit's
  references), use v5 for that flow and say why in the README.
- Webhooks: `/api/paypal/webhook` with signature verification (`POST /v1/notifications/verify-webhook-signature`) and
  idempotent handlers, plus `pnpm paypal:webhook <public-url>`, which registers the URL and this build's event types
  through the API and prints the webhook id (the local session runs it after deploying). Never depend on delivery
  alone: also poll PayPal whenever a screen needs fresh state, so everything works without a public URL.
- Seed data: `pnpm seed` creates this build's realistic sandbox data through the API (idempotent, safe to re-run) and
  prints what it made. Where a step needs the buyer to approve in PayPal's window, automate it with Playwright using
  the sandbox buyer login. Sandbox facts: transaction search lags up to about 3 hours; authorizations are honored for 3
  days and valid for 29 (reauthorize when capturing after day 3); a payout to an email with no PayPal account stays
  UNCLAIMED.
- Make the PayPal work visible: an **Under the hood** drawer listing every PayPal call the current session made (method,
  path, status, `PayPal-Debug-Id`, which feature triggered it), and a small "AI" tag on every AI-produced output naming
  the model.

### AI
- Free W&B Inference, OpenAI-compatible: `OPENAI_BASE_URL`, `OPENAI_API_KEY`, `OPENAI_MODEL` (`Qwen/Qwen3.8-27B`; tool
  calling works), `OPENAI_VISION_MODEL` (`google/gemma-4-31B-it`), and `OPENAI_FALLBACK_MODEL`
  (`zai-org/GLM-5.3-Flash`; it always returns `reasoning`, so budget `max_tokens` and handle `content: null`). Both Chat
  Completions and the Responses API answer. Server-side only, `maxRetries: 4`, 60 s timeout (about 1 call in 20 fails
  without retries); fall back to the fallback model after repeated failures.
- Use the Vercel AI SDK (or the OpenAI SDK) with tool calling. Money decisions stay deterministic: the model proposes,
  code checks the rules, and a person approves wherever this brief says so. Log each agent step so the UI can show its
  reasoning trail.
- Rate-limit AI routes per IP on the hosted demo.

### Hosting and state (the local session deploys to Vercel)
- Next.js (App Router) + TypeScript + **pnpm**, deployable to Vercel as is: no long-running processes, webhooks and jobs
  are API routes, and browser-only components (Bryntum, cameras) load with `dynamic(..., { ssr: false })`.
- Persist app state through one small `lib/store.ts` (JSON documents by key): files under `.data/` in development,
  Vercel Blob (`@vercel/blob`) when `BLOB_READ_WRITE_TOKEN` is set (the local session creates the store when deploying).
  PayPal stays the source of truth for money: store PayPal ids and re-read status from PayPal.
- A protected `POST /api/admin/reset` (header `x-admin-token`, checked against `DEMO_ADMIN_TOKEN`) that restores the
  seeded demo state, so judges land on a clean demo.
- A clearly labeled **Replay** mode that runs the main flow from recorded real sandbox and AI responses (fixtures in the
  repo), for when the sandbox or the model is down. Live is the default.

### Keys (environment variables, never in the repo)
- The keys for this build are listed in its section above. Everything is server-side except `NEXT_PUBLIC_*`. Generate
  any secrets the brief says to generate yourself, and keep them only in `.env.local`.
- `.env*` is git-ignored; `.env.example` lists the names only, with a comment on where each comes from.
- Before the last push, check the whole history for every key value in your environment:
  `for v in $(env | grep -E '^(PAYPAL_CLIENT_SECRET|PAYPAL_SANDBOX_BUYER_PASSWORD|OPENAI_API_KEY|ELEVENLABS_API_KEY|CHANNEL3_API_KEY|AG_STUDIO_LICENSE)=' | cut -d= -f2-); do git grep -nF "$v" $(git rev-list --all) && echo LEAK; done`
  must print nothing.

### Git
- Before the first commit: `git config user.name "chinesepowered"` and
  `git config user.email "22500229+chinesepowered@users.noreply.github.com"`. No `Co-Authored-By` or other AI
  attribution lines in commit messages.
- Commit to `main` and push to `origin main` at least every couple of hours. If the session makes you work on a
  `claude/*` branch, merge it into `main` at the end and delete the branch.

### Writing and quality
- **No em dashes** anywhere: UI, README, docs, commit messages, narration.
- Statistics only with a fetched, cited source (list the sources in the README). All people, businesses and products are
  fictional; stock photos only with a license that allows it, credited in `docs/CREDITS.md`.
- Mobile-first and responsive. Accessible to WCAG 2.2 AA (contrast, focus states, labels, keyboard use, live regions
  for async updates); say what you did in the README.
- `pnpm build`, `pnpm lint` and `pnpm test` (Vitest, covering the deterministic money rules) must pass.
- Keep `docs/build-log.md`: dated notes of PayPal and sponsor-tool surprises, walls and workarounds. It feeds the
  Devpost "challenges" section.

### Mascot
- An original capybara character, drawn as SVG by you. No third-party art, and nothing resembling Kapibara-san or any
  other existing character. It has a job in the product (persona, voice, empty, loading and success states) and its
  own name and look, described in this build's section. On business screens, keep it a light touch.

### Deliverables
1. The working app, live against the sandbox, plus Replay mode.
2. `README.md` for judges: a one-line pitch; the problem and who it's for; the aha; a 60-second tour with screenshots;
   how it works (a Mermaid architecture diagram); **every PayPal API and feature used, endpoint by endpoint, and where
   in the code**; the AI: which models, for what, and the guardrails; the sponsor tools (APIMatic plus this build's
   sponsor tool, if any) and how they were used; how to run it locally (sandbox app setup, env vars, `pnpm seed`);
   sandbox test logins for judges (sandbox only, no real money); limitations and what's next; credits; license.
3. `docs/screenshots/*.png`: 6 or more real app states at 1440x960.
4. `docs/devpost.md`: project name; a tagline under 200 characters; inspiration; what it does; how we built it;
   challenges; accomplishments; what we learned; what's next; a built-with list; "Tools: which AI models and services
   were used and how"; PayPal products used; sponsor tools used.
5. **The video:** `demo/video.mp4` (1920x1080 H.264, under 3:00, aim for 2:20 to 2:45, under 50 MB) plus
   `demo/thumb.png` (1200x800) and `demo/narration.txt`.
   - Record real runs of the app with Playwright (headless Chromium, `recordVideo`). Render title and caption cards
     from HTML. Compose with ffmpeg.
   - Narrate with ElevenLabs (`ELEVENLABS_API_KEY`, model `eleven_multilingual_v2` or newer, narrator voice
     `cgSgspJ2msm6clMCkdW9`). The mascot may speak short lines in a different premade voice.
   - Structure: a 10-second cold open on the problem; who it's for; the flow end to end with money visibly moving in
     PayPal; the AI doing work a person would otherwise do; PayPal APIs named on screen as they're used; the sponsor
     tool on screen; one honest limitation; an end card with the name.
   - No music, unless you generate it with ElevenLabs on this key; keep any music quiet under the voice.
   - Budget: **under 15,000 ElevenLabs characters for this build in total**. Pre-render the mascot's in-product voice
     lines into `public/audio/`, so the hosted demo never calls ElevenLabs.
   - If you can't produce the video, write `docs/demo-script.md` instead (scenes, exact clicks, narration per scene)
     and put stable `data-testid` attributes on everything it touches.
6. Your last message: what works and what doesn't; how to deploy (env vars, Blob, `pnpm seed`, `pnpm paypal:webhook`);
   which sandbox accounts the seed uses; ElevenLabs characters used; where the video is.
