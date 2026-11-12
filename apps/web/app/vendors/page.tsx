import Link from "next/link";
import type { VendorSummary } from "@relay/shared";
import { EmptyState } from "@/components/ui";
import { serverGet } from "@/lib/server-api";

export const dynamic = "force-dynamic";
export const metadata = { title: "Vendors | RELAY" };

const CITIES = [
  { key: "ABUJA", label: "Abuja" },
  { key: "LAGOS", label: "Lagos" },
] as const;

export default async function VendorsPage({ searchParams }: { searchParams: { city?: string } }) {
  const city = searchParams.city === "LAGOS" ? "LAGOS" : "ABUJA";
  const { vendors } = await serverGet<{ vendors: VendorSummary[] }>(`/vendors?city=${city}`);

  return (
    <div>
      <h1 className="font-display text-4xl tracking-wide sm:text-6xl">Vendors</h1>
      <nav aria-label="City" className="mt-4 flex gap-2">
        {CITIES.map((c) => (
          <Link
            key={c.key}
            href={`/vendors?city=${c.key}`}
            aria-current={c.key === city ? "page" : undefined}
            className={`btn ${c.key === city ? "bg-accent text-bg" : "border border-line text-ink hover:bg-surface"}`}
          >
            {c.label}
          </Link>
        ))}
      </nav>

      {vendors.length === 0 ? (
        <div className="mt-8">
          <EmptyState title="No vendors here yet">Try the other city, or check back soon.</EmptyState>
        </div>
      ) : (
        <ul className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {vendors.map((v) => (
            <li key={v.id}>
              <Link href={`/vendors/${v.id}`} className={`glass block p-6 transition hover:border-accent ${v.isOpen ? "" : "opacity-60"}`}>
                <div className="flex items-start justify-between gap-3">
                  <h2 className="text-xl font-semibold">{v.name}</h2>
                  <span className={`pill ${v.isOpen ? "border-success text-success" : "text-muted"}`}>{v.isOpen ? "Open" : "Closed"}</span>
                </div>
                <p className="mt-2 text-sm text-muted">{v.address ?? "Address not listed"}</p>
                <p className="mt-4 text-sm text-accent">View menu →</p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
