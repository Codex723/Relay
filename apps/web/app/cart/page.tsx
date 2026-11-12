"use client";

import Link from "next/link";
import { EmptyState, Skeleton } from "@/components/ui";
import { MAX_QTY } from "@/lib/cart";
import { useCart } from "@/lib/cartContext";
import { formatNaira } from "@/lib/money";

export default function CartPage() {
  const { cart, ready, subtotalKobo, setQuantity, remove, clear } = useCart();

  if (!ready) return <Skeleton className="h-48" />;
  if (cart.lines.length === 0 || !cart.vendor) {
    return (
      <EmptyState title="Your cart is empty">
        <p>Add something delicious from a vendor.</p>
        <Link href="/vendors" className="btn-primary mt-6">Browse vendors</Link>
      </EmptyState>
    );
  }

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="font-display text-4xl tracking-wide sm:text-6xl">Your cart</h1>
      <p className="mt-1 text-muted">from <Link href={`/vendors/${cart.vendor.id}`} className="text-accent">{cart.vendor.name}</Link></p>

      <ul className="mt-6 space-y-3">
        {cart.lines.map((l) => (
          <li key={l.itemId} className="glass flex items-center justify-between gap-4 p-4">
            <div>
              <p className="font-semibold">{l.name}</p>
              <p className="text-sm text-muted">{formatNaira(l.priceKobo)} each</p>
            </div>
            <div className="flex items-center gap-2" role="group" aria-label={`Quantity of ${l.name}`}>
              <button type="button" className="btn-ghost !px-0 w-12" onClick={() => setQuantity(l.itemId, l.quantity - 1)} aria-label={`Remove one ${l.name}`}>−</button>
              <span className="w-6 text-center">{l.quantity}</span>
              <button type="button" className="btn-ghost !px-0 w-12" disabled={l.quantity >= MAX_QTY} onClick={() => setQuantity(l.itemId, l.quantity + 1)} aria-label={`Add one more ${l.name}`}>+</button>
              <button type="button" className="ml-2 text-sm text-muted hover:text-danger" onClick={() => remove(l.itemId)} aria-label={`Remove ${l.name} from cart`}>Remove</button>
            </div>
          </li>
        ))}
      </ul>

      <div className="glass mt-6 p-5">
        <div className="flex justify-between"><span className="text-muted">Subtotal</span><span data-testid="cart-subtotal">{formatNaira(subtotalKobo)}</span></div>
        <p className="mt-1 text-sm text-muted">The delivery fee is worked out from your address at checkout.</p>
      </div>

      <div className="mt-6 flex flex-wrap gap-3">
        <Link href="/checkout" className="btn-primary">Checkout</Link>
        <button type="button" className="btn-ghost" onClick={clear}>Clear cart</button>
      </div>
    </div>
  );
}
