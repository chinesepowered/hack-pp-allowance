/**
 * Shared domain types for Allowance.
 */
import type { Category } from "./mandate/categories";

export type Money = { value: string; currency: "USD" };

/* ----------------------------- mandate ----------------------------- */

export type BudgetRule = {
  kind: "budget";
  n: number;
  text: string;
  weeklyLimit: number;
};

export type AllowRule = {
  kind: "allow";
  n: number;
  text: string;
  categories: Category[];
  /** Per-item price cap in USD. Above it the parent has to approve. */
  perItemCap: number | null;
};

export type BlockRule = {
  kind: "block";
  n: number;
  text: string;
  categories: Category[];
  /** Blocked store domains, for example "example-games.com". */
  merchants: string[];
};

export type ApprovalRule = {
  kind: "approval";
  n: number;
  text: string;
  /** Items above this price need the parent's OK. Null means any price. */
  overAmount: number | null;
  /** "new_merchant": only for stores the family has not used before. */
  when: "always" | "new_merchant";
  /** Empty means every category. */
  categories: Category[];
};

export type Rule = BudgetRule | AllowRule | BlockRule | ApprovalRule;

export type MandateBody = {
  id: string;
  version: number;
  kind: "intent-mandate";
  parent: { name: string };
  teen: { name: string; age: number };
  agent: { name: string };
  currency: "USD";
  /** The parent's own words, kept verbatim. */
  rulesText: string;
  weeklyBudget: number;
  rules: Rule[];
  /** Stores the parent trusts on top of the ones already bought from. */
  trustedMerchants: string[];
  /** What happens when no rule covers a purchase. Always ask the parent. */
  defaultAction: "ask_parent";
  createdAt: string;
  expiresAt: string;
};

export type MandateSignature = {
  alg: "HMAC-SHA256";
  keyId: string;
  /** SHA-256 of the canonical JSON of the body. */
  digest: string;
  value: string;
  signedAt: string;
  signedBy: string;
};

export type SignedMandate = MandateBody & { signature: MandateSignature };

/* ----------------------------- products ----------------------------- */

export type Offer = {
  domain: string;
  url: string;
  price: number;
  compareAtPrice: number | null;
  currency: string;
  availability: string;
  /** "new", "used" or "refurbished" as Channel3 reports it. */
  condition: string | null;
};

export type ProductCard = {
  id: string;
  title: string;
  brand: string | null;
  image: string | null;
  description: string | null;
  sourceCategory: string | null;
  keyFeatures: string[];
  offers: Offer[];
  /** Cheapest in-stock offer, the one Kip would buy. */
  best: Offer | null;
  rating: { average: number; count: number } | null;
};

export type Classification = {
  productId: string;
  category: Category;
  confidence: number;
  /** "ai" when the model classified it, "lookup" for the offline table. */
  source: "ai" | "lookup";
  model: string | null;
};

/* ----------------------------- policy ----------------------------- */

export type Outcome = "auto_approved" | "needs_approval" | "blocked";

export type PolicyCheck = {
  name:
    | "mandate_active"
    | "signature"
    | "expiry"
    | "blocked_category"
    | "blocked_merchant"
    | "classification"
    | "allowed_category"
    | "item_cap"
    | "merchant_rule"
    | "weekly_budget";
  pass: boolean;
  detail: string;
  ruleN: number | null;
};

export type Decision = {
  outcome: Outcome;
  /** Machine-readable reason. */
  code:
    | "ok"
    | "mandate_paused"
    | "mandate_missing"
    | "mandate_expired"
    | "signature_invalid"
    | "blocked_category"
    | "blocked_merchant"
    | "low_confidence"
    | "category_not_covered"
    | "over_item_cap"
    | "approval_rule"
    | "over_budget"
    | "price_changed";
  ruleN: number | null;
  ruleText: string | null;
  /** One line a person can read, for example "Paid under rule 2: School supplies and books any time". */
  summary: string;
  /** What Kip tells the teen. Plain and kind. */
  teenLine: string;
  /** What the approval card tells the parent. */
  parentLine: string;
  checks: PolicyCheck[];
  budget: { limit: number; spent: number; remaining: number; afterPurchase: number };
  category: Category;
  confidence: number;
  price: number;
  merchant: string;
  mandateVersion: number;
  evaluatedAt: string;
};

/* ----------------------------- ledger ----------------------------- */

export type LedgerStatus = "paying" | "paid" | "refunded" | "refund_pending" | "pending_approval" | "declined" | "blocked" | "failed";

export type PayPalRefs = {
  orderId: string | null;
  captureId: string | null;
  orderStatus: string | null;
  captureStatus: string | null;
  refundId: string | null;
  refundStatus: string | null;
  payerEmail: string | null;
  invoiceId: string | null;
  lastSyncedAt: string | null;
  via: "agent-toolkit" | "server-sdk" | null;
};

export type LedgerEntry = {
  id: string;
  createdAt: string;
  requestText: string;
  product: {
    id: string;
    title: string;
    brand: string | null;
    image: string | null;
    merchant: string;
    buyUrl: string | null;
    price: number;
  };
  amount: Money;
  category: Category;
  status: LedgerStatus;
  decision: Decision;
  /** Who let it through: the mandate alone, or the parent. */
  approvedBy: "mandate" | "parent" | null;
  approvalId: string | null;
  paypal: PayPalRefs;
  /** The retailer order step is simulated in this prototype. */
  retailerHandoff: { simulated: true; buyUrl: string | null; note: string };
  kipReason: string | null;
  undoUntil: string | null;
  seeded: boolean;
  /** Set in Replay mode: which recorded scenario this entry belongs to. */
  replaySlug: string | null;
  events: { at: string; text: string }[];
};

export type Approval = {
  id: string;
  createdAt: string;
  status: "pending" | "approved" | "declined";
  resolvedAt: string | null;
  requestText: string;
  product: LedgerEntry["product"];
  amount: Money;
  category: Category;
  decision: Decision;
  kipReasoning: string;
  aiModel: string | null;
  /** A rule the parent can add with one tap, built in code from the decision. */
  suggestedRule: { text: string; patch: RulePatch } | null;
  ledgerId: string | null;
  replaySlug: string | null;
};

export type RulePatch =
  | { type: "raise_cap"; category: Category; cap: number }
  | { type: "trust_merchant"; merchant: string }
  | { type: "allow_category"; category: Category; cap: number | null }
  | { type: "raise_budget"; weeklyLimit: number };

/* ----------------------------- chat ----------------------------- */

export type ChatCard =
  | {
      type: "products";
      source: "channel3";
      mode: "text" | "image" | "similar";
      query: string;
      filters: { maxPrice: number | null; minPrice?: number | null; availability: string[] };
      cached: boolean;
      products: ProductCard[];
      pickId: string | null;
      /** The policy preview per product, computed in code. */
      policy: Record<string, PolicyPreview>;
    }
  | { type: "receipt"; ledgerId: string }
  | { type: "approval"; approvalId: string }
  | { type: "blocked"; ruleN: number | null; ruleText: string | null; title: string }
  | { type: "notice"; tone: "info" | "warn"; text: string };

export type PolicyPreview = {
  outcome: Outcome;
  ruleN: number | null;
  label: string;
  category: Category;
  confidence: number;
};

export type ChatMessage = {
  id: string;
  at: string;
  role: "teen" | "kip";
  text: string;
  image: string | null;
  cards: ChatCard[];
  /** Set on AI-written text. Deterministic lines carry no tag. */
  ai: { model: string } | null;
  /** Kip's pose for this message. */
  mood: "idle" | "happy" | "thinking" | "sorry" | "wait" | "paused" | null;
  /** Pre-rendered voice line under public/audio, if one fits. */
  voice: string | null;
};

/* ----------------------------- under the hood ----------------------------- */

export type PayPalCall = {
  id: string;
  at: string;
  method: string;
  path: string;
  status: number;
  debugId: string | null;
  feature: string;
  via: "server-sdk" | "agent-toolkit" | "rest" | "js-sdk";
  ms: number;
  requestId: string | null;
  replay: boolean;
  note: string | null;
};

export type AgentStep = {
  id: string;
  at: string;
  turn: string;
  kind: "model" | "tool" | "policy" | "channel3" | "paypal" | "note";
  title: string;
  detail: string;
  ms: number | null;
  model: string | null;
  data?: unknown;
};

export type Channel3Call = {
  id: string;
  at: string;
  endpoint: string;
  summary: string;
  status: number;
  ms: number;
  cached: boolean;
  results: number;
};

export type WebhookRecord = {
  id: string;
  at: string;
  eventType: string;
  resourceId: string | null;
  verified: boolean;
  handled: string;
};

/* ----------------------------- session ----------------------------- */

export type VaultInfo = {
  paymentTokenId: string;
  customerId: string | null;
  payerEmail: string | null;
  payerName: string | null;
  savedAt: string;
  source: "seed" | "parent-setup" | "replay";
  kind: "paypal" | "card";
};

export type Mode = "live" | "replay";

export type SessionState = {
  sid: string;
  mode: Mode;
  rev: number;
  createdAt: string;
  updatedAt: string;
  family: { parent: { name: string }; teen: { name: string; age: number } };
  vault: VaultInfo | null;
  mandate: SignedMandate | null;
  mandateHistory: { version: number; signedAt: string; digest: string; note: string }[];
  paused: { at: string; by: string } | null;
  ledger: LedgerEntry[];
  approvals: Approval[];
  chat: ChatMessage[];
  paypalCalls: PayPalCall[];
  agentSteps: AgentStep[];
  channel3Calls: Channel3Call[];
  webhooks: WebhookRecord[];
  summary: { text: string; model: string; at: string; facts: Record<string, string | number> } | null;
  /** Products Channel3 returned in this session. Kip can only buy these. */
  seen: Record<string, SeenProduct>;
};

export type SeenProduct = {
  card: ProductCard;
  classification: Classification | null;
  seenAt: string;
};
