// The pass permalink (/p/<token>) carries everything the pass shows, so it
// works with no database: passenger name, host, event and issue date, as
// base64url JSON. It never holds the email. Anyone can mint one, which is fine:
// a pass is a souvenir, not a credential.

export interface PassData {
  n: string; // passenger name
  h: string; // host slug
  e: string; // event tag
  d: string; // issued, YYYY-MM-DD
}

const toB64Url = (s: string) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64Url = (s: string) => atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));

export function encodePass(p: PassData): string {
  const bytes = new TextEncoder().encode(JSON.stringify(p));
  let bin = "";
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return toB64Url(bin);
}

export function decodePass(token: string): PassData | null {
  if (!token || token.length > 600 || !/^[A-Za-z0-9_-]+$/.test(token)) return null;
  try {
    const bin = fromB64Url(token);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    const v = JSON.parse(new TextDecoder().decode(bytes)) as Partial<PassData>;
    if (typeof v.n !== "string" || typeof v.h !== "string" || typeof v.e !== "string" || typeof v.d !== "string") return null;
    return { n: v.n.slice(0, 80), h: v.h, e: v.e, d: v.d.slice(0, 10) };
  } catch {
    return null;
  }
}
