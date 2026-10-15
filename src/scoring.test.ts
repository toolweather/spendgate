import { describe, expect, it } from "vitest";
import { amountPenalty, parseSpendBody, scoreSpend, type NormalizedSpend } from "./scoring.js";

const NOW = new Date("2026-10-15T12:00:00.000Z");

function spend(over: Partial<NormalizedSpend> = {}): NormalizedSpend {
  return {
    amount: 1,
    currency: "USDC",
    category: "saas",
    purpose: null,
    merchant: "https://api.openai.com/v1",
    agentId: "agent_test",
    dailyBudgetRemaining: null,
    monthlyBudgetRemaining: null,
    riskHints: [],
    ...over,
  };
}

function judge(over: Partial<NormalizedSpend> = {}, micro = 1) {
  return scoreSpend(spend(over), { now: NOW, checkId: "chk_test", microThresholdUsd: micro });
}

describe("amount penalty", () => {
  it("rises with the amount and then caps", () => {
    expect(amountPenalty(0)).toBe(0);
    expect(amountPenalty(1)).toBe(8);
    expect(amountPenalty(25)).toBe(35);
    expect(amountPenalty(10_000)).toBe(75);
    const amounts = [1, 4, 10, 25, 100, 1000];
    const penalties = amounts.map(amountPenalty);
    const sorted = [...penalties].sort((a, b) => a - b);
    expect(penalties).toEqual(sorted);
  });
});

describe("verdicts", () => {
  it("approves a non-micro low-to-medium spend at a known merchant", () => {
    const result = judge({ amount: 4, category: "api_call" });
    expect(result.verdict).toBe("approve");
    expect(result.score).toBe(71);
    expect(result.micro_approved).toBe(false);
    expect(result.recommended_action.startsWith("Pay.")).toBe(true);
  });

  it("approves under the free micro threshold even when the category is high risk", () => {
    const result = judge({
      amount: 0.4,
      category: "crypto_transfer",
      merchant: "https://pay.unknown-wallet.example/send",
    });
    expect(result.verdict).toBe("approve");
    expect(result.score).toBe(80);
    expect(result.micro_approved).toBe(true);
    expect(result.raw_score).toBeLessThan(80);
    expect(result.reasons[0]).toMatch(/free micro threshold/);
  });

  it("asks a human for a mid-size SaaS charge", () => {
    const result = judge({ amount: 25, category: "saas" });
    expect(result.verdict).toBe("ask_human");
    expect(result.score).toBe(53);
    expect(result.recommended_action).toMatch(/Ask a human/);
  });

  it("blocks a large gift card at an unknown merchant", () => {
    const result = judge({
      amount: 40,
      category: "gift_card",
      merchant: "https://cards.example.com/buy",
    });
    expect(result.verdict).toBe("block");
    expect(result.score).toBe(12);
    expect(result.merchant_status).toBe("unknown");
    expect(result.recommended_action).toMatch(/Do not pay/);
  });

  it("blocks when the amount is over a supplied budget, including micro spends", () => {
    const daily = judge({ amount: 30, dailyBudgetRemaining: 10, category: "infra" });
    expect(daily.verdict).toBe("block");
    expect(daily.budget_blocked).toBe(true);
    expect(daily.score).toBeLessThanOrEqual(24);

    const micro = judge({ amount: 0.2, dailyBudgetRemaining: 0.1, category: "status_check" });
    expect(micro.verdict).toBe("block");
    expect(micro.micro_approved).toBe(false);
    expect(micro.reasons.some((reason) => reason.includes("daily budget"))).toBe(true);

    const monthly = judge({ amount: 80, monthlyBudgetRemaining: 50, category: "saas" });
    expect(monthly.verdict).toBe("block");
    expect(monthly.reasons.some((reason) => reason.includes("monthly budget"))).toBe(true);
  });

  it("allows a spend that exactly matches the remaining budget", () => {
    const result = judge({ amount: 10, dailyBudgetRemaining: 10, category: "saas" });
    expect(result.budget_blocked).toBe(false);
    expect(result.verdict).not.toBe("block");
  });

  it("scores an unknown merchant below a known one, and high risk below low risk", () => {
    const known = judge({ amount: 25, category: "saas", merchant: "https://billing.stripe.com" });
    const unknown = judge({ amount: 25, category: "saas", merchant: "https://pay.example.com/checkout" });
    expect(unknown.score).toBeLessThan(known.score);
    expect(known.merchant_status).toBe("known");

    const low = judge({ amount: 8, category: "status_check" });
    const high = judge({ amount: 8, category: "gift_card" });
    expect(high.score).toBeLessThan(low.score);
    expect(low.verdict).toBe("approve");
    expect(high.verdict).toBe("ask_human");
  });

  it("penalizes an insecure URL and a non-USD currency", () => {
    const https = judge({ amount: 25, category: "saas", merchant: "https://pay.example.com" });
    const http = judge({ amount: 25, category: "saas", merchant: "http://pay.example.com" });
    expect(http.score).toBeLessThan(https.score);

    const usdc = judge({ amount: 25, currency: "USDC" });
    const eth = judge({ amount: 25, currency: "ETH" });
    expect(eth.score).toBeLessThan(usdc.score);
  });

  it("treats a bare allowlisted host as known", () => {
    const result = judge({ amount: 4, category: "api_call", merchant: "api.openai.com" });
    expect(result.merchant_status).toBe("known");
    expect(result.paycheck_verdict).toBeNull();
    expect(result.penalties.merchant).toBe(0);
    expect(result.score).toBe(71);
  });

  it("maps PayCheck trusted to a known merchant and does not auto-trust unknown", () => {
    const local = judge({ amount: 4, category: "api_call", merchant: "https://api.perplexity.ai/chat" });
    const viaPaycheck = scoreSpend(
      spend({ amount: 4, category: "api_call", merchant: "https://api.perplexity.ai/chat" }),
      { now: NOW, checkId: "chk_test", microThresholdUsd: 1 },
      "trusted",
    );
    expect(local.merchant_status).toBe("unknown");
    expect(viaPaycheck.merchant_status).toBe("known");
    expect(viaPaycheck.paycheck_verdict).toBe("trusted");
    expect(viaPaycheck.penalties.merchant).toBe(0);
    expect(viaPaycheck.score).toBe(local.score + 18);
    expect(viaPaycheck.reasons.some((reason) => reason.includes("PayCheck verdict is trusted."))).toBe(true);

    const hinted = scoreSpend(
      spend({
        amount: 4,
        category: "api_call",
        merchant: "https://pay.example.com/checkout",
        riskHints: ["known_merchant"],
      }),
      { now: NOW, checkId: "chk_test", microThresholdUsd: 1 },
      "unknown",
    );
    expect(hinted.merchant_status).toBe("known");
    expect(hinted.paycheck_verdict).toBe("unknown");
  });

  it("penalizes PayCheck suspicious more than unknown and blocks a PayCheck block", () => {
    const unknown = judge({ amount: 25, category: "saas", merchant: "https://pay.example.com/checkout" });
    const suspicious = scoreSpend(
      spend({ amount: 25, category: "saas", merchant: "https://pay.example.com/checkout" }),
      { now: NOW, checkId: "chk_test", microThresholdUsd: 1 },
      "suspicious",
    );
    expect(unknown.penalties.merchant).toBe(18);
    expect(suspicious.penalties.merchant).toBe(30);
    expect(suspicious.score).toBeLessThan(unknown.score);
    expect(suspicious.merchant_status).toBe("unknown");
    expect(suspicious.verdict).toBe("block");

    const hinted = scoreSpend(
      spend({
        amount: 4,
        category: "api_call",
        merchant: "https://pay.example.com/checkout",
        riskHints: ["known_merchant"],
      }),
      { now: NOW, checkId: "chk_test", microThresholdUsd: 1 },
      "suspicious",
    );
    expect(hinted.merchant_status).toBe("unknown");
    expect(hinted.penalties.merchant).toBe(30);

    const blocked = scoreSpend(
      spend({ amount: 0.2, category: "status_check", merchant: "https://opena1.com" }),
      { now: NOW, checkId: "chk_test", microThresholdUsd: 1 },
      "block",
    );
    expect(blocked.verdict).toBe("block");
    expect(blocked.micro_approved).toBe(false);
    expect(blocked.score).toBeLessThanOrEqual(24);
    expect(blocked.penalties.merchant).toBe(42);
    expect(blocked.recommended_action).toMatch(/PayCheck blocked/);

    const httpBlocked = scoreSpend(
      spend({ amount: 0.2, category: "status_check", merchant: "http://203.0.113.10/pay" }),
      { now: NOW, checkId: "chk_test", microThresholdUsd: 1 },
      "block",
    );
    expect(httpBlocked.verdict).toBe("block");
    expect(httpBlocked.penalties.merchant).toBe(54);
    expect(httpBlocked.reasons.some((reason) => reason.includes("not a public https"))).toBe(true);
  });

  it("is deterministic and echoes the check time", () => {
    const a = judge({ amount: 25, riskHints: ["new_payee", "within_policy"] });
    const b = judge({ amount: 25, riskHints: ["new_payee", "within_policy"] });
    expect(a.score).toBe(b.score);
    expect(a.verdict).toBe(b.verdict);
    expect(a.checked_at).toBe("2026-10-15T12:00:00.000Z");
    expect(a.reasons.length).toBeGreaterThan(0);
  });
});

describe("parseSpendBody", () => {
  it("defaults currency to USDC and accepts aliases", () => {
    const parsed = parseSpendBody({
      amount: "12.5",
      endpoint: "https://api.github.com",
      purpose: "status_check",
      agent: "agent_ci",
      daily_remaining: 20,
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.spend.currency).toBe("USDC");
    expect(parsed.spend.merchant).toBe("https://api.github.com");
    expect(parsed.spend.category).toBeNull();
    expect(parsed.spend.purpose).toBe("status_check");
    expect(parsed.spend.agentId).toBe("agent_ci");
    expect(parsed.spend.dailyBudgetRemaining).toBe(20);
  });

  it("rejects a missing amount without producing a verdict", () => {
    const parsed = parseSpendBody({ category: "saas" });
    expect(parsed.ok).toBe(false);
  });
});
