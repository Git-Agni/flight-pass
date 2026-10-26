import "server-only";

// 5 boardings per minute per IP. With UPSTASH_REDIS_REST_URL and
// UPSTASH_REDIS_REST_TOKEN set it counts in Redis (shared by every server
// instance); without them it counts in memory, which is per instance but
// enough to slow a script down. Fails open: a limiter outage never costs a lead.

const LIMIT = 5;
const WINDOW_S = 60;
const memory = new Map<string, { n: number; until: number }>();

function memoryOk(key: string): boolean {
  const now = Date.now();
  const hit = memory.get(key);
  if (!hit || hit.until < now) {
    if (memory.size > 5000) memory.clear();
    memory.set(key, { n: 1, until: now + WINDOW_S * 1000 });
    return true;
  }
  hit.n++;
  return hit.n <= LIMIT;
}

export async function rateLimitOk(ip: string): Promise<boolean> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return memoryOk(ip);
  const key = `flight-pass:rl:${ip}:${Math.floor(Date.now() / 1000 / WINDOW_S)}`;
  try {
    const res = await fetch(`${url}/pipeline`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify([["INCR", key], ["EXPIRE", key, String(WINDOW_S)]]),
      signal: AbortSignal.timeout(1500),
    });
    const data = (await res.json()) as { result?: number }[];
    return (data?.[0]?.result ?? 0) <= LIMIT;
  } catch {
    return true;
  }
}
