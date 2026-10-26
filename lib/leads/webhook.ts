import "server-only";
import { createHmac } from "node:crypto";
import type { LeadAdapter } from "./types";

// POST each lead as JSON to LEAD_WEBHOOK_URL (Zapier, Make, n8n, Slack
// workflow, your own API). With LEAD_WEBHOOK_SECRET set, the body is signed:
// x-flight-pass-signature: sha256=<hex HMAC of the raw body>.
export const webhook: LeadAdapter = {
  name: "webhook",
  enabled: () => !!process.env.LEAD_WEBHOOK_URL,
  async send(lead) {
    const body = JSON.stringify({ type: "flight.boarded", lead });
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const secret = process.env.LEAD_WEBHOOK_SECRET;
    if (secret) headers["x-flight-pass-signature"] = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
    const res = await fetch(process.env.LEAD_WEBHOOK_URL!, { method: "POST", headers, body, signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`webhook -> ${res.status}`);
  },
};
