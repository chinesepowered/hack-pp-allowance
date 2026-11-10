/**
 * Developer check: run Kip from the terminal against the live sandbox.
 *
 *   pnpm tsx scripts/try-kip.ts "I need notebooks for school"
 *   pnpm tsx scripts/try-kip.ts --approve | --decline | --approve-rule | --undo | --reset
 */
import "./lib/load-env";
import { handleTeenMessage } from "../lib/agent/kip";
import { resolveApproval, undoPurchase } from "../lib/actions";
import { newContext, runWithContext } from "../lib/context";
import { flushLogs, loadSession, resetSession } from "../lib/session";

async function main() {
  const args = process.argv.slice(2);
  const sid = "devcheck";
  const c = newContext({ sid, mode: "live", feature: "teen chat" });
  c.emit = (ev) => {
    if (ev.type === "status") console.log("   .. " + ev.text);
    if (ev.type === "step") console.log("   [" + ev.step.kind + "] " + ev.step.title + (ev.step.ms ? " (" + ev.step.ms + " ms)" : "") + ": " + ev.step.detail.slice(0, 200));
    if (ev.type === "paypal") console.log("   [paypal " + ev.call.via + "] " + ev.call.method + " " + ev.call.path + " " + ev.call.status + " debug=" + ev.call.debugId + " " + ev.call.ms + " ms");
    if (ev.type === "channel3") console.log("   [channel3] " + ev.call.endpoint + " " + ev.call.summary + " " + ev.call.status + " " + ev.call.ms + " ms cached=" + ev.call.cached);
  };
  await runWithContext(c, async () => {
    if (args[0] === "--reset") {
      await resetSession(sid, "live");
      console.log("reset");
      return;
    }
    if (args[0] === "--approve" || args[0] === "--decline" || args[0] === "--approve-rule") {
      const s = await loadSession(sid, "live");
      const a = s.approvals.find((x) => x.status === "pending");
      if (!a) return console.log("no pending approval");
      const t0 = Date.now();
      const r = await resolveApproval(a.id, args[0] === "--approve" ? "approve" : args[0] === "--decline" ? "decline" : "approve_and_add_rule");
      await flushLogs();
      console.log("resolved in " + (Date.now() - t0) + " ms:", r.result?.status, r.state.chat.at(-1)?.text);
      return;
    }
    if (args[0] === "--undo") {
      const s = await loadSession(sid, "live");
      const e = s.ledger.find((x) => x.status === "paid" && !x.seeded);
      if (!e) return console.log("nothing to undo");
      const st = await undoPurchase(e.id);
      await flushLogs();
      console.log("undo:", st.ledger.find((x) => x.id === e.id)?.status, st.chat.at(-1)?.text);
      return;
    }
    const t0 = Date.now();
    const s = await handleTeenMessage({ text: args.join(" ") });
    await flushLogs();
    const reply = s.chat.at(-1);
    console.log("\nKip (" + (Date.now() - t0) + " ms, mood " + reply?.mood + ", ai " + (reply?.ai?.model ?? "no") + "): " + reply?.text);
    for (const card of reply?.cards ?? []) {
      if (card.type === "products") {
        console.log("  card products[" + card.mode + "] " + card.products.length + " pick=" + card.pickId + ":");
        for (const p of card.products) console.log("     " + p.id + " | " + p.title.slice(0, 50) + " | $" + p.best?.price + " " + p.best?.domain + " => " + card.policy[p.id]?.label + " (" + card.policy[p.id]?.category + " " + card.policy[p.id]?.confidence + ")");
      } else if (card.type === "receipt") {
        const e = s.ledger.find((x) => x.id === card.ledgerId);
        console.log("  card receipt: " + e?.status + " " + e?.amount.value + " order=" + e?.paypal.orderId + " capture=" + e?.paypal.captureId + " via=" + e?.paypal.via + " :: " + e?.decision.summary);
      } else if (card.type === "approval") {
        const a = s.approvals.find((x) => x.id === card.approvalId);
        console.log("  card approval: " + a?.status + " :: " + a?.decision.parentLine + " :: note: " + a?.kipReasoning + " :: suggest: " + a?.suggestedRule?.text);
      } else console.log("  card", JSON.stringify(card));
    }
  });
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
