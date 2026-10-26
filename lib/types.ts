// The shapes behind flight.config.ts. Everything a fork changes lives in that
// one file; nothing here is specific to any one person or event.

// What carries the passenger through the flight. "custom" flies your own glTF
// model (see FlightConfig.customVehicle).
export type Vehicle = "rocket" | "horse" | "gorilla" | "custom";

export interface FlightLink {
  label: string;
  href: string;
  // A brand glyph beside the label, or any emoji.
  icon?: "linkedin" | "x" | "github" | "instagram" | "link";
  emoji?: string;
}

// Fields for the downloadable contact card (.vcf). Only name is required.
export interface ContactCard {
  firstName: string;
  lastName?: string;
  org?: string;
  title?: string;
  email?: string;
  phone?: string;
  url?: string;
  // Extra profile URLs, saved on the card as social profiles.
  linkedin?: string;
  x?: string;
}

export interface FlightHost {
  // Display name of the person the guest met ("you met ___.").
  name: string;
  // Shorter name for the boarding headline so it fits on one phone line.
  shortName?: string;
  // Short name on the pass header ("PILOT: ADA").
  pilot: string;
  // Small line in the pass footer and on the shared PNG (a handle, a site).
  footer: string;
  vehicle: Vehicle;
  contact: ContactCard;
  // The "in-flight connections" row on the pass.
  links: FlightLink[];
}

export interface FlightEvent {
  // Stored with each lead. Keep it short and stable ("websummit-2026").
  tag: string;
  flight: string;
  // Big origin code on the pass ("SFO") and the city line under it.
  origin: string;
  originCity: string;
  name: string;
  // Inclusive [start, end] as YYYY-MM-DD. The event is picked automatically
  // while today is inside its window.
  window: [string, string] | null;
}

// Big type that appears over the flight at a point in it (at: 0..1 of the
// flight). Wrap a word in *stars* to set it in the accent colour. add: true
// stacks the line under the one showing instead of replacing it.
export interface ThesisLine {
  at: number;
  text: string;
  add?: boolean;
}

export interface CustomVehicle {
  // A .glb in /public (or any URL the browser can fetch). It should face +Z
  // with +Y up; rotate it with rotationY if it faces another way.
  model: string;
  rotationY?: number; // degrees
  // Roll (degrees) while it points straight up on the pad and at touchdown,
  // so its best side faces the camera. 0 for round things, 90 for a profile.
  uprightRoll?: number;
  // Nose-to-tail length in scene units. The rocket is about 3.6.
  length?: number;
  // Engine colour behind it.
  engine?: { core: string; edge: string };
  // A transparent PNG/WebP of the vehicle shown on the launch pad before the
  // flight. Falls back to the rocket sprite.
  padImage?: string;
}

export interface FlightConfig {
  // The airline on the stub and the pass ("YOUR SPACELINES").
  airline: string;
  // The address printed on the pass stub ("flight.example.com").
  siteLabel: string;
  // Which host "/" boards with. Every host is also at /<key>.
  defaultHost: string;
  hosts: Record<string, FlightHost>;
  events: FlightEvent[];
  // Used outside every event window.
  evergreen: FlightEvent;
  pass: {
    dest: string;
    destCity: string;
    gate: string;
    seat: string;
    cls: string;
  };
  copy: {
    boardLine: string;
    boardButton: string;
    // Under the pass. Promise an email only if you send one.
    closing: string;
  };
  thesis: ThesisLine[];
  customVehicle?: CustomVehicle;
  // Length of the WebGL flight in ms.
  journeyMs: number;
  // The small "made with flight-pass by Agniverse" line under the pass.
  credit: boolean;
}
