import FlightExperience from "@/components/FlightExperience";
import { config, hostBySlug, resolveEvent } from "@/lib/flight";

export const dynamic = "force-dynamic";

// "/" boards with the default host. ?e=<event tag> forces an event (testing).
export default async function Page({ searchParams }: { searchParams: Promise<{ e?: string }> }) {
  const { e } = await searchParams;
  const host = hostBySlug(config.defaultHost);
  if (!host) throw new Error(`flight.config.ts: defaultHost "${config.defaultHost}" is not in hosts`);
  return <FlightExperience mode="board" hostSlug={config.defaultHost} host={host} event={resolveEvent(new Date(), e)} />;
}
