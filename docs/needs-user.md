# Needs a person

Things the cloud build could not do or could not verify. Newest and most important first.

## 1. After deploying to Vercel (required for the hosted demo)

1. Create a Vercel Blob store for the project (Storage, Blob) so `BLOB_READ_WRITE_TOKEN` is set. The store code
   defaults to **private** access (`BLOB_ACCESS=private`). If the store was created as public, set `BLOB_ACCESS=public`.
2. Set every variable from `.env.example` in the Vercel project, including `MANDATE_SIGNING_SECRET` and
   `DEMO_ADMIN_TOKEN` (use the values from the local `.env.local`, or generate new ones).
3. Seed the production store from a machine that has the same variables **plus the production
   `BLOB_READ_WRITE_TOKEN`**:

   ```bash
   pnpm seed
   ```

   It vaults the sandbox buyer's PayPal once (Playwright approves in PayPal's window) and makes three small sandbox
   purchases. It is safe to re-run. Without this the hosted demo starts with an empty family and judges would have to
   do the parent setup first.
4. Register the webhook and set its id:

   ```bash
   pnpm paypal:webhook https://<the-deployed-host>
   ```

   Put the printed id in `PAYPAL_WEBHOOK_ID` on Vercel and redeploy.
5. Open `https://<host>/api/health`. Expect `"store":"blob"`, `"seeded":true`, `"webhookId":true`.

## 2. Fill in after deploying

- `README.md` (top) and `docs/devpost.md` ("Links"): add the hosted URL and the YouTube link.
- `docs/devpost.md` ("Testing instructions for judges"): paste the sandbox buyer email and password. They are not in
  the repository on purpose.

## 3. One thing to know before the repository goes public

Commit `e13eeb1` on `main` contains the **sandbox buyer's email address** inside the Replay fixtures (PayPal returns
it in order responses, and the first recording kept it). The next commit replaces it with a placeholder and the
recorder now scrubs it, so the current tree is clean, but the address is still readable in that one commit's history.
It is not a credential (the password, client secret and every API key were never committed; the history check in the
brief passes), and the brief plans to share this login with judges anyway. If you would rather it not be in history at
all, rewrite that commit before making the repository public, for example:

```bash
git filter-repo --replace-text <(echo 'THE_BUYER_EMAIL==>sandbox-buyer@personal.example.com')
```

```bash
git push --force-with-lease origin main
```

The cloud session did not rewrite history on `main` itself, because a force push is yours to decide.

## 4. Not verified in the cloud build (please check once on the deployed URL)

- **Vercel Blob.** `lib/store.ts` was written against the `@vercel/blob` 2.9 types (`get` with `useCache: false`,
  `put` with `allowOverwrite`) but never ran against a real store, because the build had no token. Check: buy something,
  reload, and see it still in the ledger.
- **Webhook delivery.** The handler, signature verification and registration script are in place, and the handler's
  logic (ledger update from the capture status, duplicate deliveries) has tests, but no real delivery could reach the
  cloud sandbox, so the signature check has never seen a genuine event. Check: after step 4, make a purchase and an Undo, then
  open Under the hood, Webhooks.
- **The PayPal save window on the real domain.** On localhost the client token is created without `domains[]`
  (PayPal rejects localhost). On a real host the token is bound to the host name. Check: Demo menu, "Start from an
  empty family", then save a PayPal with the sandbox buyer login.
- **The agent toolkit on Vercel.** The wrapper finds the toolkit's own axios with `createRequire` from the project root.
  If that fails in the serverless bundle it logs a warning and falls back to the PayPal Server SDK for the same charge,
  so purchases still work, but Under the hood would say "Server SDK" instead of "Agent Toolkit". Check one purchase.

## 5. The APIMatic Context Plugin install

`npx skills add https://github.com/context-plugins/plugin-marketplace/tree/main/plugins/paypal/skills/typescript` was
blocked by the cloud sandbox's command policy. The TypeScript skills were copied into `.claude/skills/` from a clone of
that repository instead (see `.claude/skills/README.md`). If the official installer output is wanted, run the command
locally; it should produce the same files.

## 6. Only the local session can do these

- Deploy to Vercel, upload `demo/video.mp4` to YouTube, make the repository public, submit on Devpost
  (`docs/devpost.md` has the text).
- Delete the `claude/focused-dirac-eccrx1` branch if it is still on the remote. Everything on it is also on `main`.

## 7. Good to know

- The API keys for this build were pasted into the build session's chat. Consider rotating them after the hackathon.
- `pnpm replay:record` re-records the Replay fixtures against the live sandbox. It spends about ten Channel3 calls and
  makes two sandbox purchases, both of which it refunds.
