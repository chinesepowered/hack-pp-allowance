/**
 * pnpm seed
 *
 * Creates this build's sandbox data through the PayPal API and saves the
 * demo template that every new session is cloned from. Safe to re-run.
 *
 *  1. Saves Dana's PayPal: Vault v3 setup token, approved once in PayPal's
 *     own window by Playwright with the sandbox buyer login, then exchanged
 *     for a payment token.
 *  2. Makes three past purchases with that token (real sandbox captures),
 *     so the ledger is not empty.
 *
 * Writes to .data/ locally, or to Vercel Blob when BLOB_READ_WRITE_TOKEN is
 * set (run it once with the production token after deploying).
 */
import "./lib/load-env";
import { evaluatePurchase, UNDO_WINDOW_MS } from "../lib/mandate/policy";
import type { Category } from "../lib/mandate/categories";
import { PayPalError } from "../lib/paypal/core";
import { capturedOf, chargeVaultViaSdk, getCapture } from "../lib/paypal/orders";
import { approveLink, createPaymentToken, createSetupToken, getPaymentToken, toVaultInfo } from "../lib/paypal/vault";
import { defaultMandate, getTemplate, saveTemplate, type Template, type TemplatePurchase } from "../lib/session";
import { store } from "../lib/store";
import type { LedgerEntry, VaultInfo } from "../lib/types";
import { approveVaultSetup } from "./lib/paypal-approve";

const RETURN_URL = "https://example.com/allowance/return";
const CANCEL_URL = "https://example.com/allowance/cancel";

/** Fictional stores and products for the seeded history. */
const PAST: { slug: string; ageHours: number; title: string; price: number; category: Category; merchant: string; request: string; reason: string }[] = [
  { slug: "novel", ageHours: 9 * 24 + 3, title: "Paperback novel for English class", price: 11.49, category: "books", merchant: "cornerbooks.example", request: "I need the book for English class", reason: "It is the edition on the class list, and the cheapest copy in stock." },
  { slug: "graph-paper", ageHours: 3 * 24 + 5, title: "Graph paper notebooks, 3 pack", price: 8.75, category: "school_supplies", merchant: "papertrail.example", request: "Graph paper notebooks for geometry", reason: "Three notebooks for less than the single ones, with quad ruled pages." },
  { slug: "tshirt", ageHours: 26, title: "Plain cotton T-shirt, navy", price: 14.5, category: "clothing", merchant: "northfield-basics.example", request: "A plain navy T-shirt for PE", reason: "Plain navy as the PE kit asks, and well under the clothes cap." },
];

async function ensureVault(existing: VaultInfo | null): Promise<{ vault: VaultInfo; created: boolean }> {
  if (existing && existing.kind === "paypal") {
    const live = await getPaymentToken(existing.paymentTokenId);
    if (live) return { vault: { ...toVaultInfo(live, "seed"), savedAt: existing.savedAt }, created: false };
    console.log("  saved token no longer exists at PayPal, vaulting again");
  }
  const setup = await createSetupToken({ returnUrl: RETURN_URL, cancelUrl: CANCEL_URL });
  const link = approveLink(setup);
  if (!link) throw new Error(`Setup token ${setup.id} has no approve link (status ${setup.status}).`);
  console.log(`  setup token ${setup.id} created, approving in PayPal's window as the sandbox buyer`);
  await approveVaultSetup(link, RETURN_URL);
  const vault = await createPaymentToken(setup.id, "seed");
  return { vault, created: true };
}

async function ensurePurchase(p: (typeof PAST)[number], vault: VaultInfo, existing: TemplatePurchase | undefined, runId: string): Promise<{ purchase: TemplatePurchase; created: boolean }> {
  if (existing?.entry.paypal.captureId) {
    try {
      const cap = await getCapture(existing.entry.paypal.captureId);
      if (cap.status === "COMPLETED") return { purchase: existing, created: false };
      console.log(`  ${p.slug}: capture ${cap.id} is ${cap.status}, making a new one`);
    } catch (err) {
      if (!(err instanceof PayPalError)) throw err;
    }
  }
  const mandate = defaultMandate();
  const now = new Date();
  const createdAt = new Date(now.getTime() - p.ageHours * 3600000).toISOString();
  const decision = evaluatePurchase({ mandate, paused: false, product: { title: p.title, price: p.price, merchant: p.merchant }, classification: { category: p.category, confidence: 0.97 }, ledger: [], now });
  const ledgerId = `led_seed_${p.slug.replace(/[^a-z]/g, "")}`;
  const invoiceId = `ALW-SEED-${p.slug.toUpperCase()}-${runId}`;
  const res = await chargeVaultViaSdk({
    vaultId: vault.paymentTokenId,
    ledgerId,
    invoiceId,
    title: p.title,
    description: "Allowance: Leo's purchase via Kip (seeded demo history)",
    price: p.price,
    // Same id on a re-run of the same seed run, so a retry cannot double charge.
    requestId: `alw-seed-${p.slug}-${runId}`,
  });
  const order = res.body;
  const capture = capturedOf(order);
  if (!capture || capture.status !== "COMPLETED") throw new Error(`Seed purchase ${p.slug}: order ${order.id} is ${order.status} with no completed capture.`);
  const entry: LedgerEntry = {
    id: ledgerId,
    createdAt,
    requestText: p.request,
    product: { id: `seed_${p.slug}`, title: p.title, brand: null, image: null, merchant: p.merchant, buyUrl: null, price: p.price },
    amount: { value: p.price.toFixed(2), currency: "USD" },
    category: p.category,
    status: "paid",
    decision,
    approvedBy: "mandate",
    approvalId: null,
    paypal: {
      orderId: order.id,
      captureId: capture.id,
      orderStatus: order.status,
      captureStatus: capture.status,
      refundId: null,
      refundStatus: null,
      payerEmail: order.payment_source?.paypal?.email_address ?? null,
      invoiceId,
      lastSyncedAt: now.toISOString(),
      via: "server-sdk",
    },
    retailerHandoff: { simulated: true, buyUrl: null, note: "Seeded demo history. The store and product are fictional; the PayPal capture is a real sandbox capture." },
    kipReason: p.reason,
    undoUntil: new Date(Date.parse(createdAt) + UNDO_WINDOW_MS).toISOString(),
    seeded: true,
    replaySlug: null,
    events: [],
  };
  return { purchase: { ageHours: p.ageHours, entry }, created: true };
}

async function main() {
  console.log(`Seeding Allowance demo data (store: ${store().kind})`);
  const template = (await getTemplate("live")) ?? ({ createdAt: new Date().toISOString(), vault: null, purchases: [] } as Template);
  const runId = Date.now().toString(36).toUpperCase();

  console.log("1. Dana's saved PayPal (Vault v3)");
  let vault: VaultInfo;
  try {
    const v = await ensureVault(template.vault);
    vault = v.vault;
    console.log(`  ${v.created ? "saved" : "already saved"}: payment token ...${vault.paymentTokenId.slice(-4)} for ${vault.payerEmail ?? "the sandbox buyer"}`);
  } catch (err) {
    console.error("  Could not vault the PayPal wallet:", (err as Error).message);
    console.error("  If this is a Vault permission error, enable Vault on the sandbox app (see docs/needs-user.md).");
    process.exitCode = 1;
    return;
  }
  template.vault = vault;
  await saveTemplate(template);

  console.log("2. Past purchases with the saved PayPal (Orders v2, vault_id)");
  const purchases: TemplatePurchase[] = [];
  for (const p of PAST) {
    const existing = template.purchases.find((x) => x.entry.product.id === `seed_${p.slug}`);
    const r = await ensurePurchase(p, vault, existing, runId);
    purchases.push(r.purchase);
    console.log(`  ${r.created ? "created" : "kept"}: ${p.title}, $${p.price.toFixed(2)}, order ${r.purchase.entry.paypal.orderId}, capture ${r.purchase.entry.paypal.captureId}`);
  }
  template.purchases = purchases;
  template.createdAt = new Date().toISOString();
  await saveTemplate(template);

  console.log("\nDone. New demo sessions start with:");
  console.log(`  parent Dana, teen Leo (15), saved PayPal ${vault.payerEmail ?? ""}`);
  console.log(`  mandate v1 signed from the default rules, ${purchases.length} past purchases in the ledger`);
  console.log("Sandbox buyer used: PAYPAL_SANDBOX_BUYER_EMAIL (Dana's PayPal). No real money moved.");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
