import type { FlightConfig } from "./lib/types";

// Everything you change to make flight-pass yours. Hosts are the people a
// guest can meet: each one gets a route (/ada, /grace) for its own QR code,
// and "/" boards with defaultHost.

const config: FlightConfig = {
  airline: "Your Spacelines",
  siteLabel: "flight.example.com",
  defaultHost: "ada",

  hosts: {
    ada: {
      name: "Ada Lovelace",
      shortName: "Ada",
      pilot: "ADA",
      footer: "@ada",
      vehicle: "rocket",
      contact: {
        firstName: "Ada",
        lastName: "Lovelace",
        org: "Analytical Engines",
        title: "Founder",
        email: "ada@example.com",
        url: "https://example.com",
        linkedin: "https://www.linkedin.com/in/example",
      },
      links: [
        { label: "Ada on X", href: "https://x.com/example", icon: "x" },
        { label: "Ada on LinkedIn", href: "https://www.linkedin.com/in/example", icon: "linkedin" },
        { label: "What we build", href: "https://example.com", emoji: "🚀" },
      ],
    },
    grace: {
      name: "Grace Hopper",
      shortName: "Grace",
      pilot: "GRACE",
      footer: "@grace",
      vehicle: "horse",
      contact: { firstName: "Grace", lastName: "Hopper", org: "Analytical Engines", email: "grace@example.com" },
      links: [{ label: "Grace on LinkedIn", href: "https://www.linkedin.com/in/example", icon: "linkedin" }],
    },
  },

  events: [
    {
      tag: "launch-week-2026",
      flight: "YSL-001",
      origin: "SFO",
      originCity: "SAN FRANCISCO",
      name: "Launch Week",
      window: ["2026-11-02", "2026-11-06"],
    },
  ],
  evergreen: { tag: "evergreen", flight: "YSL-000", origin: "EARTH", originCity: "HOME", name: "Your Spacelines", window: null },

  pass: { dest: "MARS", destCity: "RED PLANET", gate: "42", seat: "1A", cls: "FIRST" },

  copy: {
    boardLine: "now board.",
    boardButton: "board the flight",
    closing: "see you on the next flight.",
  },

  // Optional big type over the flight, e.g.
  // { at: 0.22, text: "we help *founders* ship faster." },
  thesis: [],

  // Fly your own model with vehicle: "custom" on a host.
  // customVehicle: { model: "/flight/my-model.glb", uprightRoll: 90, padImage: "/flight/my-model.png" },

  journeyMs: 10000,
  credit: true,
};

export default config;
