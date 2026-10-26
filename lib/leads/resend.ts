import "server-only";
import type { Lead, LeadAdapter } from "./types";

// Email through Resend. RESEND_NOTIFY_TO gets a "new passenger" note for every
// boarding. RESEND_SEND_CONFIRMATION=true also emails the guest their pass
// link; turn that on only if your copy.closing tells them to expect it.
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

async function send(to: string, subject: string, html: string, replyTo?: string) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: process.env.RESEND_FROM, to: [to], subject, html, ...(replyTo && { reply_to: replyTo }) }),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`resend -> ${res.status}`);
}

export const resend: LeadAdapter = {
  name: "resend",
  enabled: () =>
    !!(process.env.RESEND_API_KEY && process.env.RESEND_FROM) &&
    (!!process.env.RESEND_NOTIFY_TO || process.env.RESEND_SEND_CONFIRMATION === "true"),
  async send(lead: Lead) {
    const jobs: Promise<void>[] = [];
    if (process.env.RESEND_NOTIFY_TO) {
      jobs.push(
        send(
          process.env.RESEND_NOTIFY_TO,
          `New passenger: ${lead.name}`,
          `<p><b>${esc(lead.name)}</b> &lt;${esc(lead.email)}&gt; boarded with ${esc(lead.hostName)} (${esc(lead.event)}).</p>` +
            (lead.building ? `<p>Building: ${esc(lead.building)}</p>` : "") +
            `<p><a href="${esc(lead.passUrl)}">Their pass</a></p>`,
          lead.email,
        ),
      );
    }
    if (process.env.RESEND_SEND_CONFIRMATION === "true") {
      const first = esc(lead.name.split(/\s+/)[0] || lead.name);
      jobs.push(
        send(
          lead.email,
          "your boarding pass",
          `<p>Hi ${first},</p><p>Good to meet you. Here is your boarding pass:</p><p><a href="${esc(lead.passUrl)}">${esc(lead.passUrl)}</a></p><p>${esc(lead.hostName)}</p>`,
        ),
      );
    }
    await Promise.all(jobs);
  },
};
