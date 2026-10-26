import { NextResponse } from "next/server";
import { hostBySlug } from "@/lib/flight";

// The "save contact" download, built from the host's contact block in
// flight.config.ts. vCard 3.0, which every phone imports.
const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/([,;])/g, "\\$1");

export async function GET(_req: Request, { params }: { params: Promise<{ host: string }> }) {
  const { host: slug } = await params;
  const host = hostBySlug(slug);
  if (!host) return new NextResponse("Not found", { status: 404 });
  const c = host.contact;
  const lines = [
    "BEGIN:VCARD",
    "VERSION:3.0",
    `N:${esc(c.lastName ?? "")};${esc(c.firstName)};;;`,
    `FN:${esc([c.firstName, c.lastName].filter(Boolean).join(" "))}`,
    c.org && `ORG:${esc(c.org)}`,
    c.title && `TITLE:${esc(c.title)}`,
    c.email && `EMAIL;TYPE=INTERNET:${c.email}`,
    c.phone && `TEL;TYPE=CELL:${c.phone}`,
    c.url && `URL:${c.url}`,
    c.linkedin && `X-SOCIALPROFILE;TYPE=linkedin:${c.linkedin}`,
    c.x && `X-SOCIALPROFILE;TYPE=twitter:${c.x}`,
    "END:VCARD",
  ].filter(Boolean);
  const file = [c.firstName, c.lastName].filter(Boolean).join("-").toLowerCase().replace(/[^a-z0-9-]/g, "") || "contact";
  return new NextResponse(lines.join("\r\n") + "\r\n", {
    headers: {
      "Content-Type": "text/vcard; charset=utf-8",
      "Content-Disposition": `attachment; filename="${file}.vcf"`,
    },
  });
}
