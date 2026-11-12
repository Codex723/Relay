"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import type { OrderView } from "@relay/shared";
import { EmptyState, ErrorState, Skeleton } from "@/components/ui";
import { ApiError } from "@/lib/apiClient";
import { useAuth } from "@/lib/auth";
import { formatNaira } from "@/lib/money";
import { statusMessage, statusTone } from "@/lib/orderStatus";

export default function OrdersPage() {
  const { status, client } = useAuth();
  const router = useRouter();
  const [orders, setOrders] = useState<OrderView[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setOrders((await client.get<{ orders: OrderView[] }>("/orders/mine")).orders);
    } catch (err) {
      setError(err as ApiError);
    }
  }, [client]);

  useEffect(() => {
    if (status === "anon") router.replace("/login?next=/orders");
    if (status === "authed") void load();
  }, [status, router, load]);

  if (error) return <ErrorState message={error.message} onRetry={load} />;
  if (!orders) return <Skeleton className="h-48" />;

  return (
    <div>
      <h1 className="font-display text-4xl tracking-wide sm:text-6xl">My orders</h1>
      {orders.length === 0 ? (
        <div className="mt-8">
          <EmptyState title="No orders yet">
            <p>When you place an order it will show up here.</p>
            <Link href="/vendors" className="btn-primary mt-6">Browse vendors</Link>
          </EmptyState>
        </div>
      ) : (
        <ul className="mt-6 space-y-3">
          {orders.map((o) => (
            <li key={o.id}>
              <Link href={`/orders/${o.id}`} className="glass flex flex-wrap items-center justify-between gap-3 p-5 hover:border-accent">
                <div>
                  <p className="font-semibold">{o.vendorName}</p>
                  <p className="text-sm text-muted">{new Date(o.createdAt).toLocaleString()}</p>
                </div>
                <div className="flex items-center gap-4">
                  <span className={`pill ${statusTone(o.status)}`}>{statusMessage(o.status).title}</span>
                  <span>{formatNaira(o.totalKobo)}</span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
