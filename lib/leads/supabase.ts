import "server-only";
import type { LeadAdapter } from "./types";

// Upsert each lead into the flight_leads table (supabase/schema.sql) through
// Supabase's REST API. A repeat boarding with the same email at the same event
// updates the row instead of adding one. Needs the service role key: the table
// is locked to everyone else by RLS. Never expose that key to the browser.
export const supabase: LeadAdapter = {
  name: "supabase",
  enabled: () => !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY),
  async send(lead) {
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
    const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/flight_leads?on_conflict=email,event`, {
      method: "POST",
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify({
        name: lead.name,
        email: lead.email,
        building: lead.building,
        host: lead.host,
        event: lead.event,
        pass_url: lead.passUrl,
        user_agent: lead.userAgent,
        updated_at: lead.boardedAt,
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`supabase -> ${res.status} ${await res.text().catch(() => "")}`);
  },
};
