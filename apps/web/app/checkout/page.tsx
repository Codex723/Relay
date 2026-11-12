"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { OrderView, PaymentInit, QuoteView } from "@relay/shared";
import { DropoffMap } from "@/components/maps";
import { EmptyState, Skeleton } from "@/components/ui";
import { ApiError } from "@/lib/apiClient";
import { useAuth } from "@/lib/auth";
import { useCart } from "@/lib/cartContext";
import { formatKm, formatNaira } from "@/lib/money";

interface Pin {
  lat: number;
  lng: number;
}

function friendly(err: unknown): string {
  if (!(err instanceof ApiError)) return "Something went wrong. Please try again.";
  switch (err.code) {
    case "CITY_MISMATCH":
      return "That pin is in a different city from the vendor. Move it to an address in the same city.";
    case "OUTSIDE_SERVICE_AREA":
      return "We do not deliver to that location yet. Pick a spot in Abuja or Lagos.";
    case "VENDOR_CLOSED":
      return "This vendor is closed right now. Try again later or choose another vendor.";
    default:
      return err.message;
  }
}

export default function CheckoutPage() {
  const { status, user, client } = useAuth();
  const { cart, ready, clear } = useCart();
  const router = useRouter();

  const [address, setAddress] = useState("");
  const [pin, setPin] = useState<Pin | null>(null);
  const [quote, setQuote] = useState<QuoteView | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [placing, setPlacing] = useState(false);
  const [placeError, setPlaceError] = useState<string | null>(null);
  const [geoError, setGeoError] = useState<string | null>(null);
  const quoteSeq = useRef(0);

  useEffect(() => {
    if (status === "anon") router.replace("/login?next=/checkout");
  }, [status, router]);

  const orderBody = cart.vendor && pin
    ? {
        vendorId: cart.vendor.id,
        items: cart.lines.map((l) => ({ itemId: l.itemId, quantity: l.quantity })),
        dropAddress: address.trim(),
        dropLat: pin.lat,
        dropLng: pin.lng,
      }
    : null;
  const canQuote = status === "authed" && orderBody !== null && address.trim().length >= 5;

  // Price the order on the server whenever the address, pin or cart changes (after a short pause in typing).
  useEffect(() => {
    setQuote(null);
    setQuoteError(null);
    if (!canQuote || !orderBody) return;
    const id = ++quoteSeq.current;
    const timer = setTimeout(async () => {
      setQuoting(true);
      try {
        const r = await client.post<{ quote: QuoteView }>("/orders/quote", orderBody);
        if (id === quoteSeq.current) setQuote(r.quote);
      } catch (err) {
        if (id === quoteSeq.current) setQuoteError(friendly(err));
      } finally {
        if (id === quoteSeq.current) setQuoting(false);
      }
    }, 400);
    return () => clearTimeout(timer);
    // orderBody is rebuilt on every render; its inputs are listed instead.
  }, [canQuote, cart, pin, address, client]);

  async function placeOrder() {
    if (!orderBody) return;
    setPlacing(true);
    setPlaceError(null);
    try {
      const r = await client.post<{ order: OrderView; payment: PaymentInit | null }>("/orders", orderBody);
      clear();
      if (r.payment) window.location.assign(r.payment.authorizationUrl);
      else router.push(`/orders/${r.order.id}?payment=unavailable`);
    } catch (err) {
      setPlaceError(friendly(err));
      setPlacing(false);
    }
  }

  function useMyLocation() {
    setGeoError(null);
    if (!navigator.geolocation) return setGeoError("Your browser cannot share your location. Tap the map instead.");
    navigator.geolocation.getCurrentPosition(
      (pos) => setPin({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => setGeoError("We could not get your location. Tap the map instead."),
      { enableHighAccuracy: true, timeout: 10_000 },
    );
  }

  if (!ready || status === "loading") return <Skeleton className="h-64" />;
  if (placing && !placeError) return <EmptyState title="Taking you to payment…" />;
  if (cart.lines.length === 0 || !cart.vendor) {
    return (
      <EmptyState title="Your cart is empty">
        <p>Add something from a vendor first.</p>
        <Link href="/vendors" className="btn-primary mt-6">Browse vendors</Link>
      </EmptyState>
    );
  }
  if (status !== "authed") return <Skeleton className="h-64" />;
  if (user?.role !== "CUSTOMER") return <EmptyState title="Customer accounts only">Only customer accounts can place orders. Sign in with a customer account.</EmptyState>;

  return (
    <div>
      <h1 className="font-display text-4xl tracking-wide sm:text-6xl">Checkout</h1>
      <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_380px]">
        <section aria-labelledby="drop-heading" className="space-y-4">
          <h2 id="drop-heading" className="text-xl font-semibold">Where should we deliver?</h2>
          <div>
            <label htmlFor="address" className="label">Delivery address</label>
            <input id="address" className="field" autoComplete="street-address" placeholder="House number, street, area" value={address} onChange={(e) => setAddress(e.target.value)} />
          </div>
          <div>
            <p className="label">Tap the map to drop a pin at your door ({cart.vendor.city === "ABUJA" ? "Abuja" : "Lagos"})</p>
            <DropoffMap center={{ lat: cart.vendor.lat, lng: cart.vendor.lng }} vendor={{ lat: cart.vendor.lat, lng: cart.vendor.lng }} value={pin} onChange={setPin} />
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <button type="button" className="btn-ghost" onClick={useMyLocation}>Use my location</button>
              <span data-testid="pin-status" className="text-sm text-muted">{pin ? `Pin set (${pin.lat.toFixed(4)}, ${pin.lng.toFixed(4)})` : "No pin yet"}</span>
            </div>
            {geoError && <p role="alert" className="mt-2 text-sm text-danger">{geoError}</p>}
          </div>
          <details className="rounded-2xl border border-line p-4">
            <summary className="cursor-pointer text-sm text-muted">Enter coordinates instead</summary>
            <div className="mt-3 grid grid-cols-2 gap-3">
              <div>
                <label htmlFor="lat" className="label">Latitude</label>
                <input id="lat" type="number" step="any" className="field" value={pin?.lat ?? ""} onChange={(e) => e.target.value !== "" && setPin({ lat: Number(e.target.value), lng: pin?.lng ?? cart.vendor!.lng })} />
              </div>
              <div>
                <label htmlFor="lng" className="label">Longitude</label>
                <input id="lng" type="number" step="any" className="field" value={pin?.lng ?? ""} onChange={(e) => e.target.value !== "" && setPin({ lat: pin?.lat ?? cart.vendor!.lat, lng: Number(e.target.value) })} />
              </div>
            </div>
          </details>
        </section>

        <aside aria-labelledby="summary-heading" className="glass h-fit space-y-3 p-6 lg:sticky lg:top-24">
          <h2 id="summary-heading" className="text-xl font-semibold">Order from {cart.vendor.name}</h2>
          <ul className="space-y-1 text-sm">
            {cart.lines.map((l) => (
              <li key={l.itemId} className="flex justify-between gap-3"><span>{l.quantity} × {l.name}</span><span className="text-muted">{formatNaira(l.priceKobo * l.quantity)}</span></li>
            ))}
          </ul>
          <hr className="border-line" />
          <div aria-live="polite" className="space-y-2 text-sm">
            {quote ? (
              <>
                <div className="flex justify-between"><span className="text-muted">Subtotal</span><span data-testid="quote-subtotal">{formatNaira(quote.subtotalKobo)}</span></div>
                <div className="flex justify-between"><span className="text-muted">Delivery ({formatKm(quote.distanceM)})</span><span data-testid="quote-fee">{formatNaira(quote.deliveryFeeKobo)}</span></div>
                <div className="flex justify-between text-base font-semibold"><span>Total</span><span data-testid="quote-total">{formatNaira(quote.totalKobo)}</span></div>
              </>
            ) : quoteError ? (
              <p role="alert" className="text-danger">{quoteError}</p>
            ) : quoting ? (
              <p className="text-muted">Working out your delivery fee…</p>
            ) : (
              <p className="text-muted">Enter your address and drop a pin to see your delivery fee and total.</p>
            )}
          </div>
          {placeError && <p role="alert" className="text-sm text-danger">{placeError}</p>}
          <button type="button" className="btn-primary w-full" disabled={!quote || placing} onClick={placeOrder}>
            {quote ? `Pay ${formatNaira(quote.totalKobo)}` : "Pay"}
          </button>
          <p className="text-xs text-muted">You will pay securely with Paystack. Your order is sent to the vendor once payment is confirmed.</p>
        </aside>
      </div>
    </div>
  );
}
