# Build log

Dated notes of what surprised us, what blocked us and how we got around it. PayPal and sponsor tools first.

## Tue Nov 10 2026

### PayPal

- **Vaulting a PayPal wallet works on the sandbox app as provided.** `POST /v3/vault/setup-tokens` returned 201 with an
  approve link on the first try, so the "vaulted test card" fallback in the brief was not needed.
- **Playwright can approve in PayPal's own window, headless, with no captcha.** The sandbox login is two steps (`#email`,
  Next, `#password`, Log In), then a consent page with `#consentButton` ("Save and Continue"). `pnpm seed` uses the approve
  link directly; the app itself uses the JS SDK v6 popup and the same helper drives it for the video.
- **An order created with `payment_source.paypal.vault_id` and intent CAPTURE is captured in the create call.** The
  response is already `COMPLETED` with the capture inside, in about 2.3 seconds. There is no separate capture request,
  so the brief's "create, then capture" is one call here. The code still handles an `APPROVED` order by capturing it,
  and it re-reads the order (`get_order`) before telling anyone it is paid.
- **The payment token is stable per payer.** With `permit_multiple_payment_tokens: false`, exchanging a second approved
  setup token for the same buyer returns 200 and the same payment token id. That makes `pnpm seed` and the parent's
  "save again" naturally idempotent.
- **JS SDK v6 supports the save-PayPal flow**, so no v5 fallback was needed: `createInstance({ clientToken })`,
  `findEligibleMethods({ paymentFlow: "VAULT_WITHOUT_PAYMENT" })`, `createPayPalSavePaymentSession`, and
  `session.start({ presentationMode: "auto" }, promiseOfSetupToken)`. The promise has to be created inside the click and
  passed un-awaited, or the popup loses its user activation.
- **The client token request rejects `localhost`.** `domains[]=localhost` (with or without a port) answers
  `invalid_domain: Domain format not valid`. The app now binds the token to a domain only when it runs on a real one and
  omits `domains[]` in local development.
- **`@paypal/agent-toolkit` 1.11 surprises:**
  - Its `create_order` tool has no field for a vaulted payment source, and it always adds
    `payment_source.paypal.experience_context` with return and cancel URLs, which makes PayPal answer
    `PAYER_ACTION_REQUIRED`. Our wrapper replaces the payment source with `{ paypal: { vault_id } }` in an axios request
    interceptor, after the mandate check passes. The model never sees the token.
  - It talks to `api.sandbox.paypal.com`, not `api-m.sandbox.paypal.com`. Our first interceptor matched only the `api-m`
    host, silently did nothing, and the order came back needing buyer approval. The host check now accepts both.
  - It caches its OAuth token on the instance and never refreshes it. We rebuild the toolkit every four hours.
  - It never sends `PayPal-Request-Id` unless a single id is put in its context, which would be shared by every call.
    The interceptor sets a per-purchase id instead.
  - Its `create_refund` posts the tool arguments, including `capture_id`, as the request body. PayPal accepts it.
  - The refund tools are enabled under `payments: { createRefund, getRefunds }`, not under `refunds`.
  - The toolkit requires its own copy of axios (CommonJS build). The interceptor has to be installed on that exact
    module instance, so we resolve axios from the toolkit's location with `createRequire` instead of importing it.
- **`@paypal/paypal-server-sdk` logging.** `logLevel` is the level each request is logged at, not a threshold. Setting
  `LogLevel.Error` printed every request as an error line. We removed the logging block entirely.
- **APIMatic's PayPal Context Plugin documents a different package.** Its skills describe the generated `paypal`
  package (`PaypalClient`, not on npm), while this build is pinned to `@paypal/paypal-server-sdk` 2.5. We used the
  plugin's workflow (the contract sheet in `paypal-plan.md`, the durable-write and refusal tables) and took every SDK
  fact from the installed SDK source. `npx skills add` could not run in the cloud sandbox, so the skill files were
  copied from a clone of the marketplace repository into `.claude/skills/`.
- **Webhooks cannot be received in the cloud sandbox** (no public URL). The handler verifies and deduplicates, the
  registration script exists, and every money screen re-reads PayPal, so nothing depends on delivery. Real deliveries
  still need a check after deploying.

### Channel3

- The SDK's client class is `Channel3`, not `Channel3Client` as the README inside the package says.
- Search is fast (1.2 to 1.9 seconds) and the `price.max_price` and `availability: ["InStock"]` filters do what the
  mandate needs.
- **Product detail lists second-hand offers.** A calculator shown at $16.99 new came back from product detail with a
  $5.00 used offer first. Kip briefly charged $5.00. Now search asks for `conditions: ["new"]`, and at purchase time
  Kip only accepts a new, in-stock offer from the same store the teen was shown.
- Image search works with a base64 image. Our sample "photo" is an illustration drawn for the demo, and it still found
  matching green backpacks.
- Results are real products from real retailers, so brand and store names appear. The demo video is recorded with
  `?safe=1`, which masks store domains and strips brand names from titles. The live app shows real names.
- Some titles come back in another language even with `language: "en"` and `country: "US"` set.
- Responses are cached per request (one minute in production, a day in development). A failed call falls back to the
  last good response for the same request and the UI labels it "cached result".

### AI (W&B Inference)

- **The text model is a reasoning model.** With `max_tokens: 700` and no other hint it spent all 700 tokens on
  `reasoning` and returned empty content. `reasoning_effort: "none"` brings a classification from 4.1 seconds to under
  1 second; `"low"` is used where the model has to plan (rules to mandate).
- **With reasoning off the model sometimes skipped tools** and answered from the rules in its prompt, or wrote text
  that imitated our own bracketed history notes, including a fake "[paid: ...]". Nothing was charged (there was no tool
  call, and the guard refuses unknown product ids), but the text was wrong. Fixes: history notes moved out of the
  assistant's past messages into a system note, bracketed text stripped from replies, `tool_choice: "required"` on the
  first turn of a shopping request, and a retry with reasoning on when the tool call is malformed.
- **A blocked request must be blocked by code whatever the model does.** In one recording run the model's first tool
  was not `search_products`, so the request-level policy check never ran. Every shopping request is now labeled and
  screened in code in parallel with the model's first turn.
- The model wrote "his budget" about Leo. Prompts now say to refer to the teen by name only.

### Tooling

- Chromium under Playwright sends `localhost` through a configured proxy unless `bypass` is set. The first browser
  check hung for that reason.
- Next.js 16 lint rules (React Compiler era) reject refs written during render and `setState` directly in an effect.

### Video, screenshots and accessibility

- The first recording drifted: the page itself scrolled by a few pixels whenever a pane was scrolled into view, because
  the body had a minimum height that the recording zoom made taller than the window. The page no longer scrolls at all;
  only the panes do.
- PayPal's window is a separate page, so Playwright records it as a second video. The composer shows it over a dimmed
  frame of the app and blurs the band where the login pages print the sandbox buyer's email.
- "Around $55" used to return cheaper sneakers that fit the rules, which made the approval scene a coin toss. A price
  window (80% of the named price up to the cap) is now sent to Channel3 as `min_price` and `max_price`.
- Recording mode (`?safe=1`) first only stripped the listed brand. One title still carried a shoe model name, so
  recording mode now shows the catalog category instead of the product title.
- An axe-core scan found list items under a `log` role, two names that did not match their visible text, a stray menu
  role and a dimmed heading. All fixed; `pnpm a11y` now reports no violations in ten states.
- The first Replay recording kept the sandbox buyer's email as PayPal returned it. The recorder now replaces it with a
  placeholder before writing a fixture (see `docs/needs-user.md` for the one commit where it remains in history).
- The narrator was changed to a young female voice (Jessica) after the first cut. Only the twelve narrator lines were
  generated again; Kip's lines and the footage are the same. The new voice paces the opening differently, so the first
  card's length is now taken from the pauses in the audio instead of a fixed number, and the composer checks that every
  line is whole in the final mix (no overlap, nothing past the end of a scene, peak below 0 dB).
