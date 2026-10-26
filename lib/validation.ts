import { KNOWN_EVENT_TAGS, hostBySlug } from "./flight";

// Server-side check of the boarding form: name, email, an optional "what are
// you building?", plus the host and event the page was opened with.

export interface ValidBoarding {
  name: string;
  email: string;
  building: string | null;
  host: string;
  event: string;
}

export type ValidationResult = { ok: true; value: ValidBoarding } | { ok: false; error: string };

// A pragmatic shape check. Delivery is the real test of an address.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateBoarding(body: Record<string, unknown>): ValidationResult {
  const name = String(body.name ?? "").trim();
  if (name.length < 1 || name.length > 80) return { ok: false, error: "Enter your name." };

  const email = String(body.email ?? "").trim().toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 254) return { ok: false, error: "Enter a valid email." };

  const buildingRaw = String(body.building ?? "").trim();
  if (buildingRaw.length > 200) return { ok: false, error: "Keep the build note under 200 characters." };

  const host = String(body.host ?? "");
  if (!hostBySlug(host)) return { ok: false, error: "Unknown boarding gate." };

  const event = String(body.event ?? "");
  if (!KNOWN_EVENT_TAGS.has(event)) return { ok: false, error: "Unknown flight." };

  return { ok: true, value: { name, email, building: buildingRaw || null, host, event } };
}
