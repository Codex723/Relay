"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import type { OrderView, PaymentInit } from "@relay/shared";
import { TrackingMap } from "@/components/maps";
import { EmptyState, ErrorState, Skeleton } from "@/components/ui";
import { ApiError } from "@/lib/apiClient";
import { useAuth } from "@/lib/auth";
import { formatKm, formatNaira } from "@/lib/money";
import { STEPS, isFinal, statusMessage, stepIndex, type OrderStatus } from "@/lib/orderStatus";
import { useOrderLive, type RiderPosition } from "@/lib/useOrderLive";

export default function OrderPage({ params }: { params: { id: string } }) {
  const { status: authStatus, client } = useAuth();
  const router = useRouter();
  const search = useSearchParams();
  const reference = search.get("reference") ?? search.get("trxref");
  const paymentUnavailable = search.get("payment") === "unavailable";

  const [order, setOrder] = useState<OrderView | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [liveStatus, setLiveStatus] = useState<OrderStatus | null>(null);
  const [rider, setRider] = useState<RiderPosition | null>(null);
  const [verify, setVerify] = useState<"idle" | "checking" | "slow">("idle");
  const [payBusy, setPayBusy] = useState(false);
  const [payError, setPayError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await client.get<{ order: OrderView }>(`/orders/${params.id}`);
      setOrder(r.order);
      setLiveStatus(null);
      setError(null);
    } catch (err) {
      setError(err as ApiError);
    }
  }, [client, params.id]);

  useEffect(() => {
    if (authStatus === "anon") {
      const here = `/orders/${params.id}${search.toString() ? `?${search.toString()}` : ""}`;
      router.replace(`/login?next=${encodeURIComponent(here)}`);
    }
    if (authStatus === "authed") void load();
  }, [authStatus, load, params.id, router, search]);

  const status: OrderStatus | null = liveStatus ?? order?.status ?? null;

  const { connected } = useOrderLive({
    orderId: params.id,
    enabled: authStatus === "authed" && order !== null && !isFinal(status ?? "PENDING_PAYMENT"),
    onStatus: setLiveStatus,
    onLocation: setRider,
    poll: load,
  });

  // After Paystack sends the customer back, ask the server to confirm the payment in case the webhook is slow.
  useEffect(() => {
    if (!reference || !order || status !== "PENDING_PAYMENT" || authStatus !== "authed") return;
    let cancelled = false;
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout>;
    setVerify("checking");
    const tick = async () => {
      attempts++;
      try {
        const r = await client.get<{ orderStatus: OrderStatus }>(`/payments/verify/${encodeURIComponent(reference)}`);
        if (cancelled) return;
        if (r.orderStatus !== "PENDING_PAYMENT") {
          setLiveStatus(r.orderStatus);
          setVerify("idle");
          return;
        }
      } catch {
        // keep trying
      }
      if (cancelled) return;
      if (attempts >= 10) setVerify("slow");
      else timer = setTimeout(tick, 3000);
    };
    timer = setTimeout(tick, 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [reference, order, status, authStatus, client]);

  async function payNow() {
    setPayBusy(true);
    setPayError(null);
    try {
      const r = await client.post<{ payment: PaymentInit }>(`/orders/${params.id}/pay`);
      window.location.assign(r.payment.authorizationUrl);
    } catch (err) {
      setPayError(err instanceof ApiError ? err.message : "Could not start the payment.");
      setPayBusy(false);
    }
  }

  if (error?.status === 404) {
    return (
      <EmptyState title="Order not found">
        <p>We could not find that order. It may belong to another account.</p>
        <Link href="/orders" className="btn-primary mt-6">My orders</Link>
      </EmptyState>
    );
  }
  if (error && !order) return <ErrorState message={error.message} onRetry={load} />;
  if (!order || !status) return <Skeleton className="h-96" />;

  const msg = statusMessage(status);
  const idx = stepIndex(status);
  const tracking = status === "ASSIGNED" || status === "PICKED_UP";

  return (
    <div>
      <Link href="/orders" className="text-sm text-muted hover:text-ink">← My orders</Link>
      <h1 className="mt-2 font-display text-4xl tracking-wide sm:text-6xl">Order from {order.vendorName}</h1>

      {paymentUnavailable && status === "PENDING_PAYMENT" && (
        <p role="status" className="mt-4 rounded-2xl border border-accent p-4">We could not start your payment just now. Your order is saved; try paying again below.</p>
      )}

      <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_420px]">
        {/* On a phone the order reads top to bottom: status, payment, map, details. On a wide screen the map sits in the right column. */}
        <div className="space-y-6 lg:col-start-1">
          <section className="glass p-6" aria-labelledby="status-heading">
            <h2 id="status-heading" className="sr-only">Order status</h2>
            <div aria-live="polite">
              <p data-testid="status-title" className="text-2xl font-semibold">{msg.title}</p>
              <p className="mt-1 text-muted">{msg.detail}</p>
            </div>
            {verify === "checking" && <p className="mt-3 text-sm text-accent">Confirming your payment…</p>}
            {verify === "slow" && <p className="mt-3 text-sm text-muted">We have not received confirmation yet. This page updates by itself as soon as we do.</p>}
            {idx >= 0 && (
              <ol className="mt-6 space-y-3" aria-label="Progress">
                {STEPS.map((s, i) => (
                  <li key={s.label} aria-current={i === idx ? "step" : undefined} className="flex items-center gap-3">
                    <span className={`h-3 w-3 shrink-0 rounded-full ${i < idx || status === "DELIVERED" ? "bg-success" : i === idx ? "bg-accent" : "border border-line"}`} />
                    <span className={i <= idx ? "text-ink" : "text-muted"}>{s.label}</span>
                  </li>
                ))}
              </ol>
            )}
            {!isFinal(status) && !connected && <p className="mt-4 text-xs text-muted">Live updates are reconnecting. We check for changes every few seconds meanwhile.</p>}
          </section>

          {status === "PENDING_PAYMENT" && (
            <section className="glass p-6">
              <h2 className="text-lg font-semibold">Complete your payment</h2>
              <p className="mt-1 text-sm text-muted">Pay {formatNaira(order.totalKobo)} with Paystack to send your order to the vendor.</p>
              {payError && <p role="alert" className="mt-3 text-sm text-danger">{payError}</p>}
              <button type="button" className="btn-primary mt-4" onClick={payNow} disabled={payBusy}>{payBusy ? "Opening Paystack…" : `Pay ${formatNaira(order.totalKobo)}`}</button>
            </section>
          )}

        </div>
        <section className="glass h-fit p-4 lg:col-start-2 lg:row-span-2 lg:row-start-1" aria-labelledby="map-heading">
          <h2 id="map-heading" className="mb-3 px-2 text-lg font-semibold">{tracking ? "Track your rider" : "Map"}</h2>
          <TrackingMap vendor={{ lat: order.vendorLat, lng: order.vendorLng }} drop={{ lat: order.dropLat, lng: order.dropLng }} rider={tracking ? rider : null} />
          <p className="mt-3 px-2 text-sm text-muted" data-testid="rider-note">
            {tracking ? (rider ? `Rider last seen ${new Date(rider.at).toLocaleTimeString()}` : "Waiting for your rider's location…") : "Blue is the vendor, green is your drop-off."}
          </p>
        </section>
        <div className="space-y-6 lg:col-start-1">
          <section className="glass p-6" aria-labelledby="details-heading">
            <h2 id="details-heading" className="text-lg font-semibold">Your order</h2>
            <ul className="mt-3 space-y-1 text-sm">
              {order.lines.map((l) => (
                <li key={l.itemId} className="flex justify-between gap-3"><span>{l.quantity} × {l.name}</span><span className="text-muted">{formatNaira(l.unitPriceKobo * l.quantity)}</span></li>
              ))}
            </ul>
            <hr className="my-3 border-line" />
            <div className="space-y-1 text-sm">
              <div className="flex justify-between"><span className="text-muted">Subtotal</span><span>{formatNaira(order.subtotalKobo)}</span></div>
              <div className="flex justify-between"><span className="text-muted">Delivery ({formatKm(order.distanceM)})</span><span>{formatNaira(order.deliveryFeeKobo)}</span></div>
              <div className="flex justify-between text-base font-semibold"><span>Total</span><span data-testid="order-total">{formatNaira(order.totalKobo)}</span></div>
            </div>
            <p className="mt-4 text-sm text-muted">Delivering to: {order.dropAddress}</p>
          </section>
        </div>
      </div>
    </div>
  );
}
