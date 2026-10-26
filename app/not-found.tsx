import Link from "next/link";
import { config } from "@/lib/flight";

// An unknown host or a broken pass link.
export default function NotFound() {
  return (
    <main className="gate404">
      <p className="k">{config.airline.toUpperCase()}</p>
      <h1>this gate is empty.</h1>
      <p className="s">that boarding pass could not be found.</p>
      <Link href="/" className="go">board a new flight</Link>
    </main>
  );
}
