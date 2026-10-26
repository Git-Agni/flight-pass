import "server-only";
import type { LeadAdapter } from "./types";

// Customer.io Track API: identify the guest (keyed by email) with their
// details, then track a "flight_boarded" event you can trigger a campaign on.
// Set CUSTOMERIO_REGION=eu for an EU workspace: a US endpoint answers an EU
// workspace with a bare 401.
export const customerio: LeadAdapter = {
  name: "customerio",
  enabled: () => !!(process.env.CUSTOMERIO_SITE_ID && process.env.CUSTOMERIO_API_KEY),
  async send(lead) {
    const base = process.env.CUSTOMERIO_REGION === "eu" ? "https://track-eu.customer.io/api/v1" : "https://track.customer.io/api/v1";
    const auth = "Basic " + Buffer.from(`${process.env.CUSTOMERIO_SITE_ID}:${process.env.CUSTOMERIO_API_KEY}`).toString("base64");
    const id = encodeURIComponent(lead.email);
    const call = async (method: string, path: string, body: unknown) => {
      const res = await fetch(base + path, {
        method,
        headers: { Authorization: auth, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(4000),
      });
      if (!res.ok) throw new Error(`customer.io ${method} -> ${res.status}`);
    };
    await call("PUT", `/customers/${id}`, {
      email: lead.email,
      first_name: lead.name.split(/\s+/)[0] || lead.name,
      building: lead.building,
      host: lead.host,
      event: lead.event,
      pass_url: lead.passUrl,
      source: "flight-pass",
    });
    await call("POST", `/customers/${id}/events`, {
      name: "flight_boarded",
      data: { host: lead.host, host_name: lead.hostName, event: lead.event, building: lead.building, pass_url: lead.passUrl },
    });
  },
};
