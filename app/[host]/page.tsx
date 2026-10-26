import { notFound } from "next/navigation";
import FlightExperience from "@/components/FlightExperience";
import { hostBySlug, resolveEvent } from "@/lib/flight";

export const dynamic = "force-dynamic";

// /<host> - one route per host in flight.config.ts, for each person's QR code.
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ host: string }>;
  searchParams: Promise<{ e?: string }>;
}) {
  const [{ host: slug }, { e }] = await Promise.all([params, searchParams]);
  const host = hostBySlug(slug);
  if (!host) notFound();
  return <FlightExperience mode="board" hostSlug={slug} host={host} event={resolveEvent(new Date(), e)} />;
}
