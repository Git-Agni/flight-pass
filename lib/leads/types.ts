// One boarding, as every lead adapter receives it.
export interface Lead {
  id: string; // a fresh uuid per boarding
  name: string;
  email: string;
  building: string | null;
  host: string; // host slug from flight.config.ts
  hostName: string;
  event: string; // event tag
  passUrl: string;
  userAgent: string | null;
  boardedAt: string; // ISO
}

export interface LeadAdapter {
  name: string;
  enabled: () => boolean;
  send: (lead: Lead) => Promise<void>;
}
