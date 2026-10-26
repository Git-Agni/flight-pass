import "server-only";
import { customerio } from "./customerio";
import { resend } from "./resend";
import { supabase } from "./supabase";
import type { Lead, LeadAdapter } from "./types";
import { webhook } from "./webhook";

export type { Lead } from "./types";

// Every adapter whose env vars are set gets every lead. Add your own by
// writing a LeadAdapter and listing it here.
const ADAPTERS: LeadAdapter[] = [supabase, webhook, customerio, resend];

export const enabledAdapters = () => ADAPTERS.filter((a) => a.enabled());

// Runs after the response is sent, so a slow or failing service never delays
// the flight. One adapter failing never stops the others.
export async function dispatchLead(lead: Lead): Promise<void> {
  const on = enabledAdapters();
  if (!on.length) {
    if (process.env.NODE_ENV !== "production") console.info(`[flight-pass] boarded: ${lead.name} <${lead.email}> (no lead adapters configured)`);
    return;
  }
  const results = await Promise.allSettled(on.map((a) => a.send(lead)));
  results.forEach((r, i) => {
    if (r.status === "rejected") console.error(`[flight-pass] ${on[i].name}:`, (r.reason as Error)?.message ?? r.reason);
  });
}
