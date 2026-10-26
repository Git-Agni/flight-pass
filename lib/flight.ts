import config from "@/flight.config";
import type { FlightEvent, FlightHost } from "./types";

export { config };

// Slugs Next.js already routes, so a host can never be called one of these.
const RESERVED = new Set(["p", "api", "vcard", "flight"]);

export function hostBySlug(slug: string | undefined | null): FlightHost | null {
  if (!slug || RESERVED.has(slug)) return null;
  return Object.prototype.hasOwnProperty.call(config.hosts, slug) ? config.hosts[slug] : null;
}

export const KNOWN_EVENT_TAGS = new Set<string>([...config.events.map((e) => e.tag), config.evergreen.tag]);

export function eventByTag(tag: string | undefined | null): FlightEvent | null {
  if (!tag) return null;
  if (tag === config.evergreen.tag) return config.evergreen;
  return config.events.find((e) => e.tag === tag) ?? null;
}

// Which event a scan belongs to. ?e=<tag> wins (for testing); otherwise the
// event whose date window contains today; otherwise evergreen. ISO date
// strings compare correctly as plain strings.
export function resolveEvent(now: Date, override?: string | null): FlightEvent {
  const forced = eventByTag(override);
  if (forced) return forced;
  const today = now.toISOString().slice(0, 10);
  return config.events.find((e) => e.window && today >= e.window[0] && today <= e.window[1]) ?? config.evergreen;
}

export const flightStrip = (e: FlightEvent) => `FLIGHT ${e.flight} · ${e.origin} → ${config.pass.dest}`;

// First name for "save Ada's contact".
export const contactFirstName = (host: FlightHost) => host.contact.firstName || host.name.split(/\s+/)[0];

// "OCT 07" for the DATE cell, from the day the pass was issued.
export function passDate(iso?: string | null): string {
  const d = iso ? new Date(iso) : new Date();
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", { month: "short", day: "2-digit", timeZone: "UTC" }).toUpperCase();
}

// First name for the headline: "welcome to Mars, Malik."
export function firstName(full: string | undefined | null): string {
  const f = (full || "").trim().split(/\s+/)[0] || "";
  if (!f) return "";
  return f.charAt(0).toUpperCase() + f.slice(1).toLowerCase();
}

export function initials(full: string | undefined | null): string {
  const parts = (full || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "YS";
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}
