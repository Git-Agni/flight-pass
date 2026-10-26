import { notFound } from "next/navigation";
import FlightExperience from "@/components/FlightExperience";
import { config, eventByTag, hostBySlug } from "@/lib/flight";
import { decodePass } from "@/lib/pass-token";

// The pass permalink: renders straight to the boarding pass from the token
// (lib/pass-token.ts), so share links and emails work with no database.
export default async function Page({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const pass = decodePass(token);
  if (!pass) notFound();
  const slug = hostBySlug(pass.h) ? pass.h : config.defaultHost;
  const host = hostBySlug(slug)!;
  return (
    <FlightExperience
      mode="arrival"
      hostSlug={slug}
      host={host}
      event={eventByTag(pass.e) ?? config.evergreen}
      passengerName={pass.n}
      passToken={token}
      issuedAt={pass.d}
    />
  );
}
