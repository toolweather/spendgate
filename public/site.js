const policyNodes = document.querySelectorAll("[data-policy]");

async function loadPolicy() {
  if (!policyNodes.length) return;
  try {
    const response = await fetch("/v1/policy");
    if (!response.ok) return;
    const policy = await response.json();
    for (const node of policyNodes) {
      const key = node.getAttribute("data-policy");
      if (key && policy[key] != null) node.textContent = String(policy[key]);
    }
  } catch {
    /* The printed defaults stay in place if the API is down. */
  }
}

function checkedHints() {
  return [...document.querySelectorAll("input[name='hint']:checked")].map((node) => node.value);
}

function setResult(score) {
  const root = document.querySelector("#result");
  if (!root) return;
  root.className = "result";
  root.innerHTML = "";

  const tag = document.createElement("div");
  tag.className = "example-tag";
  tag.textContent = "Live check";

  const line = document.createElement("div");
  line.className = "scoreline";
  const num = document.createElement("div");
  num.className = "num";
  num.textContent = String(score.score);
  const pill = document.createElement("div");
  pill.className = `pill ${score.verdict}`;
  pill.textContent = score.verdict;
  line.append(num, pill);

  const action = document.createElement("p");
  action.textContent = score.recommended_action;

  const reasons = document.createElement("ul");
  reasons.className = "reasons";
  for (const reason of score.reasons ?? []) {
    const item = document.createElement("li");
    item.textContent = reason;
    reasons.append(item);
  }

  const when = document.createElement("p");
  when.className = "muted";
  when.textContent = score.checked_at ? `Checked ${score.checked_at}` : "";

  root.append(tag, line, action, reasons, when);
}

function setError(message) {
  const root = document.querySelector("#result");
  if (!root) return;
  root.innerHTML = "";
  const tag = document.createElement("div");
  tag.className = "example-tag";
  tag.textContent = "Not scored";
  const p = document.createElement("p");
  p.className = "error";
  p.textContent = message;
  root.append(tag, p);
}

function readForm(form) {
  const data = new FormData(form);
  const body = {
    amount: Number(data.get("amount")),
    currency: String(data.get("currency") || "USDC"),
    category: String(data.get("category") || ""),
    merchant: String(data.get("merchant") || ""),
    agent_id: String(data.get("agent_id") || "site_demo"),
    risk_hints: checkedHints(),
  };
  const daily = String(data.get("daily_budget_remaining") || "");
  const monthly = String(data.get("monthly_budget_remaining") || "");
  if (daily !== "") body.daily_budget_remaining = Number(daily);
  if (monthly !== "") body.monthly_budget_remaining = Number(monthly);
  return body;
}

function fill(preset) {
  const form = document.querySelector("#try");
  if (!form) return;
  form.amount.value = preset.amount;
  form.category.value = preset.category;
  form.merchant.value = preset.merchant;
  form.daily_budget_remaining.value = preset.daily ?? "";
  form.monthly_budget_remaining.value = preset.monthly ?? "";
}

const presets = {
  micro: { amount: "0.20", category: "status_check", merchant: "https://www.cloudflare.com/status", daily: "" },
  saas: { amount: "25", category: "saas", merchant: "https://api.openai.com/v1", daily: "40" },
  gift: { amount: "40", category: "gift_card", merchant: "https://cards.example.com/buy", daily: "" },
  budget: { amount: "18", category: "infra", merchant: "https://api.digitalocean.com", daily: "10" },
};

async function onSubmit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector("button[type='submit']");
  button.disabled = true;
  button.textContent = "Scoring…";
  try {
    const response = await fetch("/v1/score", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(readForm(form)),
    });
    const body = await response.json();
    if (!response.ok) {
      const message = body.error?.message || body.error || `Score failed (${response.status}).`;
      setError(typeof message === "string" ? message : "Score failed.");
      return;
    }
    setResult(body);
  } catch {
    setError("The score request did not reach the API.");
  } finally {
    button.disabled = false;
    button.textContent = "Score this spend";
  }
}

loadPolicy();
const form = document.querySelector("#try");
if (form) {
  form.addEventListener("submit", onSubmit);
  document.querySelectorAll("[data-preset]").forEach((button) => {
    button.addEventListener("click", () => {
      const name = button.getAttribute("data-preset");
      if (name && presets[name]) fill(presets[name]);
    });
  });
}
