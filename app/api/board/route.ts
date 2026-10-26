import { after, NextRequest, NextResponse } from "next/server";
import { dispatchLead } from "@/lib/leads";
import { hostBySlug } from "@/lib/flight";
import { encodePass } from "@/lib/pass-token";
import { rateLimitOk } from "@/lib/ratelimit";
import { validateBoarding } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Boarding capture. POST only, in this order:
 *   1. honeypot filled -> a decoy 200 (bots learn nothing)
 *   2. 5 per minute per IP -> 429
 *   3. validate -> 400
 *   4. answer with the pass token at once; hand the lead to every configured
 *      adapter after the response (lib/leads), so the flight never waits.
 */
export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }

  if (String(body.company ?? "").trim()) {
    return NextResponse.json({ pass_id: "decoy" });
  }

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "anon";
  if (!(await rateLimitOk(ip))) {
    return NextResponse.json({ error: "Slow down a moment." }, { status: 429 });
  }

  const parsed = validateBoarding(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const { name, email, building, host, event } = parsed.value;

  const boardedAt = new Date().toISOString();
  const token = encodePass({ n: name, h: host, e: event, d: boardedAt.slice(0, 10) });
  const passUrl = `${req.nextUrl.origin}/p/${token}`;

  after(() =>
    dispatchLead({
      id: crypto.randomUUID(),
      name,
      email,
      building,
      host,
      hostName: hostBySlug(host)!.name,
      event,
      passUrl,
      userAgent: req.headers.get("user-agent")?.slice(0, 500) ?? null,
      boardedAt,
    }),
  );

  return NextResponse.json({ pass_id: token, pass_url: passUrl });
}
