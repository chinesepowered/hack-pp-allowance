# PayPal integration plan and contract sheet

This file follows the format of APIMatic's PayPal Context Plugin (`.claude/skills/typescript-integrate-paypal`): a
contract sheet with no open lookups, plus the tables for durable writes, cross-operation invariants, optional fields and
refusals.

**Order of work, honestly.** The plugin asks for this sheet before any project file is touched. This build did the
plugin's read-only prerequisites first (survey, credentials check, sandbox smoke of every operation, lookups in the
installed SDK source), then wrote the PayPal layer from those lookups, and only then wrote the sheet up in this form.
The tables were then used as a review checklist against the code: that pass added the tests in
`tests/payments.test.ts`, the fixed message for unmapped errors, and the "honest limit" note below.

**One difference from the plugin, stated up front.** The plugin's lookup layer (`typescript-getting-started`) documents
APIMatic's newer generated package `paypal` (client `PaypalClient`, built from `context-plugins/paypal-typescript-sdk`,
not on npm). This build is required to use `@paypal/paypal-server-sdk` 2.5.x, which is also APIMatic-generated but an
earlier generation with a different surface (`Client`, controller classes, `ApiResponse`, `ApiError`). So:

- the plugin's **method** is used as written: contract sheet, durable-write tables, optional-field table, refusal table,
  required reading, no SDK fact from memory;
- every **SDK fact** below was looked up in the installed `@paypal/paypal-server-sdk@2.5.0` source
  (`node_modules/@paypal/paypal-server-sdk/src/controllers/*.ts` and `src/models/*.ts`), not in the plugin's map;
- each in-scope operation was smoke-tested against the sandbox credential before the sheet was closed (the plugin's
  "read-only smoke" step, extended to the reversible writes).

## Host decision

Sandbox only. `Environment.Sandbox` for the server SDK and `https://api-m.sandbox.paypal.com` for plain REST, fixed in
code (`lib/env.ts`, `lib/paypal/core.ts`). `assertSandbox()` refuses to build a client when `PAYPAL_ENVIRONMENT` is
anything else, so a live credential cannot be aimed at this app by configuration.

## Client

Built once and held (`sdk()` in `lib/paypal/core.ts`): the OAuth token cache lives on the client. No `logging` block:
in this SDK `logLevel` is the level every request is logged at, not a threshold, and request bodies carry payer data.
The app logs its own summary per call instead (method, path, status, `PayPal-Debug-Id`, feature).

Retries: the SDK default (`maxNumberOfRetries: 0` in `src/defaultConfiguration.ts`) is kept, so the SDK sends a write
once. The app's own single re-send after an unknown outcome reuses the same `PayPal-Request-Id`.

## Operations in scope

| # | Operation | How it is called | Where |
| --- | --- | --- | --- |
| 1 | `POST /v3/vault/setup-tokens` | `VaultController.createSetupToken({ body, paypalRequestId })` | `lib/paypal/vault.ts` `createSetupToken` |
| 2 | `POST /v3/vault/payment-tokens` | `VaultController.createPaymentToken({ body, paypalRequestId })` | `lib/paypal/vault.ts` `createPaymentToken` |
| 3 | `GET /v3/vault/payment-tokens/{id}` | `VaultController.getPaymentToken(id)` | `lib/paypal/vault.ts` `getPaymentToken` (used by `pnpm seed`) |
| 4 | `POST /v2/checkout/orders` (vaulted PayPal) | Agent Toolkit tool `create_order`, wrapped; fallback and seed: `OrdersController.createOrder` | `lib/paypal/orders.ts` `chargeVaultViaToolkit`, `chargeVaultViaSdk` |
| 5 | `POST /v2/checkout/orders/{id}/capture` | `OrdersController.captureOrder({ id, paypalRequestId, prefer })` | `lib/paypal/orders.ts` `captureOrder` (only if a create comes back uncaptured) |
| 6 | `GET /v2/checkout/orders/{id}` | Agent Toolkit tool `get_order`; fallback `OrdersController.getOrder({ id })` | `lib/paypal/orders.ts` `getOrder` |
| 7 | `GET /v2/payments/captures/{id}` | `PaymentsController.getCapturedPayment({ captureId })` | `lib/paypal/orders.ts` `getCapture` |
| 8 | `POST /v2/payments/captures/{id}/refund` | Agent Toolkit tool `create_refund`; fallback `PaymentsController.refundCapturedPayment` | `lib/paypal/orders.ts` `refundCapture` |
| 9 | `POST /v1/oauth2/token` (client credentials) | plain REST, cached | `lib/paypal/core.ts` `accessToken` |
| 10 | `POST /v1/oauth2/token` (`response_type=client_token`) | plain REST | `lib/paypal/vault.ts` `createClientToken` |
| 11 | `POST /v1/notifications/verify-webhook-signature` | plain REST | `lib/paypal/webhooks.ts` `verifyWebhookSignature` |
| 12 | `GET`, `POST`, `PATCH /v1/notifications/webhooks` | plain REST | `lib/paypal/webhooks.ts` `registerWebhook` |

Rows 9 to 12 use plain REST because the server SDK has no Webhooks controller and its OAuth controller does not model
the `client_token` response.

### Facts looked up, per operation

- **1** request model `SetupTokenRequest { customer?, paymentSource }`; `paymentSource.paypal` is
  `VaultPaypalWalletRequest { description?, usagePattern?, shipping?, permitMultiplePaymentTokens?, usageType?,
  customerType?, billingPlan?, experienceContext? }`; `experienceContext` is `VaultExperienceContext { brandName?,
  locale?, returnUrl?, cancelUrl?, shippingPreference?, vaultInstruction? ... }`. Enums used:
  `PaypalPaymentTokenUsageType.Merchant`, `PaypalPaymentTokenCustomerType.Consumer`, `UsagePattern.Immediate`,
  `ExperienceContextShippingPreference.NoShipping`, `VaultInstructionAction.OnPayerApproval`. Response read: `id`,
  `status` (`PAYER_ACTION_REQUIRED` then `APPROVED`), `links[rel=approve]`.
- **2** request `PaymentTokenRequest { paymentSource: { token: { id, type: VaultTokenRequestType.SetupToken } } }`.
  Response read: `id`, `customer.id`, `payment_source.paypal.{email_address, name}`.
- **4** `OrderRequest { intent: CheckoutPaymentIntent.Capture, paymentSource: { paypal: { vaultId } }, purchaseUnits:
  [{ customId, invoiceId, description, amount: { currencyCode, value, breakdown.itemTotal }, items: [{ name, quantity,
  unitAmount, category: ItemCategory.PhysicalGoods }] }] }`, header options `paypalRequestId`, `prefer`.
  Response read: `id`, `status`, `payment_source.paypal.email_address`, `purchase_units[0].payments.captures[0].{id,status}`.
- **8** `RefundRequest { amount?, customId?, invoiceId?, noteToPayer?, paymentInstruction? }`. Response read: `id`, `status`.
- Errors: every controller rejects with `ApiError` (`statusCode`, `headers`, `body`, `result`). `sdkCall()` reads
  `details[0].issue` and `details[0].description` from the body and the `paypal-debug-id` header.

### Sandbox smoke results (Nov 10 2026, sandbox app `hack-pp-allowance`)

| Operation | Result |
| --- | --- |
| 1 setup token | 201, `PAYER_ACTION_REQUIRED`, approve link present. Vault is enabled on the app. |
| buyer approval | Playwright logged in as the sandbox buyer and pressed "Save and Continue"; setup token became `APPROVED`. |
| 2 payment token | 201 on first use; 200 with the same token id on a repeat for the same payer (`permit_multiple_payment_tokens: false`). |
| 4 create with `vault_id` | 201 and `status: COMPLETED` in the create response, capture included. No separate capture call. |
| 6 get order | 200 `COMPLETED`. |
| 8 refund | 201 `COMPLETED`. |
| 10 client token | 200 without `domains[]` on localhost; `domains[]=localhost` answers `invalid_domain`. |

## DURABLE WRITES

### Duplicate claims

| Write | Where the claim is stored | What rejects the second one | Where that rejection is caught | Where in the code |
| --- | --- | --- | --- | --- |
| Charge the saved PayPal (auto approved) | the ledger entry, written with status `paying` before the call | one `create_order` per chat turn is enforced in the agent loop; the `PayPal-Request-Id` is derived from the ledger entry id, so a retry of the same claim cannot charge twice | `handleTeenMessage` (second `create_order` in a turn is refused); PayPal's idempotency for retries | `lib/agent/guard.ts` `requestPurchase`, `pay`; `lib/agent/kip.ts` |
| Charge after parent approval | the approval record, flipped `pending` to `approved` inside one serialized store update | the update throws when the approval is no longer `pending` | `resolveApproval` (the second caller gets "Already approved") | `lib/actions.ts` `resolveApproval` |
| Refund (Undo) | the ledger entry, flipped `paid` to `refund_pending` inside one serialized store update | the update throws when the entry is not `paid` | `undoPurchase` | `lib/actions.ts` `undoPurchase` |
| Create payment token | the setup token id itself: `PayPal-Request-Id` is `alw-ptoken-<setup token id>` | PayPal returns the first result for the same id; with `permit_multiple_payment_tokens: false` the same payer also maps to the same token | n/a (no second resource is created) | `lib/paypal/vault.ts` `createPaymentToken` |
| Webhook handling | the event id, added to `webhooks/seen` before handling | `claimEvent` returns false for an id already present | `handleWebhookEvent` returns "duplicate, ignored" | `lib/paypal/webhooks.ts` |

The claim is released when PayPal refuses: a failed charge sets the entry to `failed`, and a failed approval payment
puts the approval back to `pending` so the parent can try again.

Honest limit: the store serializes updates inside one process (`update()` in `lib/store.ts`). Across serverless
instances the last writer wins, so two approvals tapped in the same instant on two instances could both pass the
claim. The derived `PayPal-Request-Id` is the backstop there: both attempts send the same id and PayPal charges once.

### Unknown outcomes

| Write | The operation you re-read with | The reference you search by | Where in the code | The test that fails the connection |
| --- | --- | --- | --- | --- |
| Charge the saved PayPal | the same `create_order` request again | the same `PayPal-Request-Id` (`alw-live-order-<ledger id>`), for which PayPal returns the original result | `lib/agent/guard.ts` `pay` (catch `PayPalUnknownOutcome`, retry once, otherwise leave the entry `paying` and say the outcome is unknown) | `tests/payments.test.ts` "asks again with the same PayPal-Request-Id", "reports unknown, not failed" |
| Refund | `GET /v2/payments/captures/{id}` after one retry with the same `PayPal-Request-Id` | the capture id on the ledger entry | `lib/actions.ts` `undoPurchase` | `tests/payments.test.ts` "re-reads the capture when the refund outcome is unknown", "keeps the refund marked as in progress" |

A write that never left gets a different outcome and no re-read: no saved PayPal, a product no search returned, a
blocked or unapproved purchase. `tests/payments.test.ts` asserts PayPal is not called in each of those cases.

## CROSS-OPERATION INVARIANTS

| Invariant | Where the legal set comes from | Enforced where | The test that proves it |
| --- | --- | --- | --- |
| Kip may only buy a product Channel3 returned in this session | `session.seen`, filled by search, image search and similar results | `requestPurchase` (before any claim) | `tests/payments.test.ts` "never calls PayPal for a product no search returned" |
| The amount charged is the Channel3 offer price, never a number from the model | the offer re-read from Channel3 product detail, same store as shown, new and in stock only | `requestPurchase` builds the amount; the model's tool call carries only a product id | `tests/replay.test.ts` "buys notebooks at once ..." (asserts charge equals the offer price) |
| A purchase is paid only with `auto_approved`, or `needs_approval` plus a parent approval for that product at that price or less | the policy decision and the approval record | `authorizePayment` inside `pay` | `tests/policy.test.ts` "the gate in front of PayPal" |
| Only this session's own captures can be refunded, and only for 24 hours | the session's ledger | `undoPurchase`, `canUndo` | `tests/policy.test.ts` "undo", `tests/payments.test.ts` "refunds once" |
| The vault id is never taken from a request or from the model | the session's saved vault record | `pay` reads it from state; the toolkit interceptor attaches it | n/a (no input path exists) |

## OPTIONAL REQUEST FIELDS

| Operation | Field | What requires it | Set it? |
| --- | --- | --- | --- |
| 1 | `paypalRequestId` | idempotency for a durable write | yes |
| 1 | `usageType`, `customerType`, `usagePattern` | the product: the merchant charges later with the payer absent, for immediate purchases | yes |
| 1 | `permitMultiplePaymentTokens: false` | one saved PayPal per parent | yes |
| 1 | `experienceContext.returnUrl`, `cancelUrl` | PayPal requires them for the approval step | yes |
| 1 | `experienceContext.brandName`, `locale`, `shippingPreference`, `vaultInstruction` | the brief: the parent approves in PayPal's window, nothing is shipped by Allowance | yes |
| 1 | `customer`, `shipping`, `billingPlan` | nothing | left out |
| 2 | `paypalRequestId` | Duplicate claims row "Create payment token" | yes |
| 2 | `customer` | nothing | left out |
| 4 | `PayPal-Request-Id` | Duplicate claims and Unknown outcomes rows for the charge | yes |
| 4 | `Prefer: return=representation` | the capture id is read from the create response | yes |
| 4 | `custom_id`, `invoice_id` | matching a webhook or a PayPal report line back to the ledger entry | yes |
| 4 | `description`, `items` | the receipt in the payer's PayPal activity | yes |
| 4 | `payer`, `application_context`, `payee`, `soft_descriptor`, `shipping` | nothing | left out |
| 8 | `PayPal-Request-Id` | Duplicate claims and Unknown outcomes rows for the refund | yes |
| 8 | `note_to_payer` | tells the parent why money came back | yes |
| 8 | `amount` | nothing: Undo is a full refund, and omitting it refunds the full capture | left out |

The Agent Toolkit builds the order body itself, so two fields it adds are not this app's choice: an empty tax and
shipping breakdown, and a `payment_source.paypal.experience_context` that the wrapper replaces with the vaulted source.
Its `create_refund` also sends `capture_id` in the body; PayPal accepts it.

## WHEN THE API SAYS NO

Implemented once in `errorResponse()` (`lib/http.ts`), used by every route.

| status from PayPal | this app answers | the caller reads |
| --- | --- | --- |
| 4xx other than 401, 403, 429 | the same 4xx | PayPal's own reason (`details[0].description`), plus the debug id |
| 422 `INSTRUMENT_DECLINED` on a charge | the purchase is marked not charged | "PayPal declined the saved payment method", no retry |
| 401, 403 | 502 | a fixed message about this app's credentials |
| 429 | 503 | a fixed message about rate limiting |
| 5xx | 502 | a fixed message |
| no response, on a write | per Unknown outcomes | "unknown", never "failed" |
| no response, on a read | 502 | a fixed message |

## Observability and sensitive data

- Every call is recorded with method, path, status, `PayPal-Debug-Id`, the feature that triggered it and how it was
  made (server SDK, Agent Toolkit or REST). The Under the hood drawer shows this list per session.
- Request and response bodies are never logged. The vault token id stays on the server; the browser gets a masked hint.
- The debug id is included in any PayPal error shown to a person.

## Required reading (which plugin skills were read, and what they changed)

| Skill | Read | What it changed here |
| --- | --- | --- |
| `typescript-integrate-paypal` | in full | this sheet; claim, call, record for every write; smoke tests before coding; the tests that read the store from inside the faked PayPal call |
| `typescript-getting-started` | identity and install sections | the finding that the plugin documents the `paypal` package, not `@paypal/paypal-server-sdk`, so lookups went to the installed SDK source instead |
| `typescript-configuration-resilience` | "Making a write safe under retries" | the idempotency key is created once per logical action and derived from the claim, never per attempt; reconcile after a transport failure; a claim always has a release |
| `typescript-error-handling` | "Presenting failures at your boundary" | one error ladder in `lib/http.ts`: 401, 403 and 429 are ours (5xx), other 4xx pass PayPal's own reason through, and no SDK message goes on the wire |
| `typescript-client-initialization` | "Inbound webhooks" and client lifetime | the raw body is captured before any JSON parsing and verified with PayPal; one client built once |
| `typescript-testing` | headings only | not applied in detail: its fake-`fetch` helpers target the `paypal` package, so tests here fake at the function boundary instead |
| `typescript-calling-endpoints`, `typescript-models` | not read | their content is specific to the `paypal` package's generated surface |

## Assumptions and blockers

- Assumption: a deployment runs on one PayPal sandbox app. No multi-merchant handling.
- No blocker. The one thing only a person can do is register the webhook after deploying (see `docs/deploy.md`).
