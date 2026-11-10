/**
 * pnpm replay:record
 *
 * Runs the main demo flow once against the live PayPal sandbox, Channel3
 * and the model, and records every outside response to fixtures/replay/.
 * Replay mode then runs the same application code with those responses.
 *
 * Needs a seeded store (`pnpm seed`) and all keys in .env.local.
 */
import "./lib/load-env";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { refreshSummary, resolveApproval, undoPurchase } from "../lib/actions";
import { handleTeenMessage } from "../lib/agent/kip";
import { draftMandate } from "../lib/ai/mandate-parser";
import { newContext, runWithContext } from "../lib/context";
import { DEFAULT_RULES_TEXT, SCRIPTED_PROMPTS } from "../lib/demo/defaults";
import { approveLink, createPaymentToken, createSetupToken } from "../lib/paypal/vault";
import { newTape, type Tape } from "../lib/replay/vcr";
import { flushLogs, getTemplate, loadSession, resetSession, type Template } from "../lib/session";
import { approveVaultSetup } from "./lib/paypal-approve";

process.env.CHANNEL3_CACHE = "off";
const OUT = path.join(process.cwd(), "fixtures", "replay");
const SID = "replayrecorder";
const REDACTED_TOKEN = "replay0vault0token";

async function record<T>(scenario: string, note: string, fn: () => Promise<T>): Promise<{ tape: Tape; value: T }> {
  const c = newContext({ sid: SID, mode: "live", feature: `record ${scenario}` });
  const tape = newTape(scenario, note);
  c.tape = { mode: "record", tape };
  const value = await runWithContext(c, async () => {
    const v = await fn();
    await flushLogs();
    return v;
  });
  console.log(`  ${scenario}: ${tape.exchanges.length} exchanges (${tape.exchanges.map((e) => `${e.svc}:${e.op}`).join(", ")})`);
  return { tape, value };
}

const LONG_DASH = new RegExp("[" + String.fromCharCode(0x2014, 0x2013) + "]", "g");

function save(tape: Tape) {
  // Catalog descriptions are third-party text; normalize their dashes so
  // the repository keeps to its own writing rules.
  writeFileSync(path.join(OUT, `${tape.scenario}.json`), JSON.stringify(tape, null, 1).replace(LONG_DASH, "-") + "\n");
}

async function attempt(): Promise<Tape[] | null> {
  const tapes: Tape[] = [];
  const prompt = (slug: string) => SCRIPTED_PROMPTS.find((p) => p.slug === slug)!.text;
  await runWithContext(newContext({ sid: SID, mode: "live", feature: "record" }), async () => {
    await resetSession(SID, "live");
  });

  const vault = await record("vault-save", "Vault v3: setup token, approved in PayPal's window by the sandbox buyer, then exchanged for a payment token. The token id is redacted.", async () => {
    const setup = await createSetupToken({ returnUrl: "https://example.com/allowance/return", cancelUrl: "https://example.com/allowance/cancel" });
    await approveVaultSetup(approveLink(setup)!, "https://example.com/allowance/return");
    await createPaymentToken(setup.id, "replay");
  });
  for (const e of vault.tape.exchanges) {
    const res = e.res as { body?: { id?: string; links?: unknown } };
    if (e.op === "vault.createPaymentToken" && res.body) {
      res.body.id = REDACTED_TOKEN;
      delete res.body.links;
    }
  }
  tapes.push(vault.tape);

  tapes.push((await record("mandate-draft", "The model turns Dana's plain-English rules into a mandate draft.", () => draftMandate(DEFAULT_RULES_TEXT))).tape);

  const notebooks = await record("chat-notebooks", "Leo asks for notebooks. Auto-approved and paid with the saved PayPal.", () => handleTeenMessage({ text: prompt("notebooks"), slug: "notebooks" }));
  const paid = notebooks.value.ledger.find((e) => e.replaySlug === "notebooks" && e.status === "paid");
  if (!paid) {
    console.log("  notebooks was not paid this time, retrying the whole recording");
    return null;
  }
  tapes.push(notebooks.tape);

  const sneakers = await record("chat-sneakers", "Leo asks for sneakers around $55. Needs Dana's OK.", () => handleTeenMessage({ text: prompt("sneakers"), slug: "sneakers" }));
  const approval = sneakers.value.approvals.find((a) => a.replaySlug === "sneakers" && a.status === "pending");
  if (!approval || approval.decision.code !== "over_item_cap") {
    console.log(`  sneakers did not hit the clothes cap this time (${approval?.decision.code ?? "no approval"}), retrying the whole recording`);
    return null;
  }
  tapes.push(sneakers.tape);

  tapes.push((await record("approve-sneakers", "Dana approves. The saved PayPal is charged.", () => resolveApproval(approval.id, "approve"))).tape);

  const gaming = await record("chat-gaming", "Leo asks for a gaming gift card. Blocked by the rules, nothing is searched or charged.", () => handleTeenMessage({ text: prompt("gaming"), slug: "gaming" }));
  if (!gaming.value.chat.at(-1)?.cards.some((c) => c.type === "blocked")) {
    console.log("  gaming was not blocked through the tool path, retrying the whole recording");
    return null;
  }
  tapes.push(gaming.tape);

  tapes.push((await record("undo-notebooks", "Dana taps Undo on the notebooks. A full PayPal refund.", () => undoPurchase(paid.id))).tape);
  tapes.push((await record("summary", "The weekly note, written by the model from the ledger.", () => refreshSummary())).tape);

  // Undo the sneakers too: it gives Replay a second Undo, and the sandbox
  // buyer is not left paying for a recording.
  const before = await runWithContext(newContext({ sid: SID, mode: "live", feature: "record" }), () => loadSession(SID, "live"));
  const extra = before.ledger.find((e) => e.replaySlug === "sneakers" && e.status === "paid");
  if (!extra) {
    console.log("  the approved sneakers purchase is missing, retrying the whole recording");
    return null;
  }
  tapes.push((await record("undo-sneakers", "Dana taps Undo on the approved sneakers. A full PayPal refund.", () => undoPurchase(extra.id))).tape);
  return tapes;
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const template = await getTemplate("live");
  if (!template?.vault) throw new Error("No seeded template. Run `pnpm seed` first.");
  console.log("Recording Replay fixtures against the live sandbox");
  let tapes: Tape[] | null = null;
  for (let i = 1; i <= 4 && !tapes; i++) {
    console.log(`attempt ${i}`);
    tapes = await attempt();
  }
  if (!tapes) throw new Error("Could not record a clean run in four attempts.");
  for (const t of tapes) save(t);

  const replayTemplate: Template = {
    createdAt: new Date().toISOString(),
    vault: { ...template.vault, paymentTokenId: REDACTED_TOKEN, customerId: "replay", source: "replay", savedAt: template.vault.savedAt },
    purchases: template.purchases,
  };
  writeFileSync(path.join(OUT, "template.json"), JSON.stringify(replayTemplate, null, 1) + "\n");
  console.log(`\nSaved ${tapes.length} tapes and template.json to fixtures/replay/`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
