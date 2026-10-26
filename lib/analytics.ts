"use client";

// Every flight event goes to PostHog when its snippet is on the page
// (window.posthog), and is also dispatched as a "flight-pass" DOM event so you
// can wire any other analytics: window.addEventListener("flight-pass", (e) => ...).
export type FlightEventName =
  | "flight_scan_landed"
  | "flight_boarding_submitted"
  | "flight_pass_viewed"
  | "flight_vcard_downloaded"
  | "flight_pass_shared";

type Props = Record<string, string | number | boolean | null>;

export function flightTrack(event: FlightEventName, props: Props) {
  try {
    (window as unknown as { posthog?: { capture: (e: string, p?: Props) => void } }).posthog?.capture(event, props);
  } catch {
    // analytics never breaks the page
  }
  try {
    window.dispatchEvent(new CustomEvent("flight-pass", { detail: { event, ...props } }));
  } catch {
    // ignore
  }
}
