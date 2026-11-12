import Link from "next/link";
import { notFound } from "next/navigation";
import type { ItemSummary, VendorSummary } from "@relay/shared";
import { ApiError } from "@/lib/apiClient";
import { serverGet } from "@/lib/server-api";
import { MenuList } from "./MenuList";

export const dynamic = "force-dynamic";

export default async function VendorPage({ params }: { params: { id: string } }) {
  let vendor: VendorSummary | undefined;
  let items: ItemSummary[];
  try {
    const [vendors, menu] = await Promise.all([
      serverGet<{ vendors: VendorSummary[] }>("/vendors"),
      serverGet<{ items: ItemSummary[] }>(`/vendors/${encodeURIComponent(params.id)}/items`),
    ]);
    vendor = vendors.vendors.find((v) => v.id === params.id);
    items = menu.items;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) notFound();
    throw err;
  }
  if (!vendor) notFound();

  return (
    <div>
      <Link href={`/vendors?city=${vendor.city}`} className="text-sm text-muted hover:text-ink">← All vendors</Link>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <h1 className="font-display text-4xl tracking-wide sm:text-6xl">{vendor.name}</h1>
        <span className={`pill ${vendor.isOpen ? "border-success text-success" : "text-muted"}`}>{vendor.isOpen ? "Open" : "Closed"}</span>
      </div>
      <p className="mt-1 text-muted">{vendor.address}</p>
      {!vendor.isOpen && <p role="status" className="mt-4 rounded-2xl border border-line p-4 text-muted">This vendor is closed right now. You can look at the menu, but you cannot order yet.</p>}
      <MenuList vendor={{ id: vendor.id, name: vendor.name, city: vendor.city, lat: vendor.lat, lng: vendor.lng }} isOpen={vendor.isOpen} items={items} />
    </div>
  );
}
