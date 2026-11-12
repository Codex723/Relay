"use client";

import { useState } from "react";
import type { ItemSummary } from "@relay/shared";
import { MAX_QTY, type CartVendor } from "@/lib/cart";
import { useCart } from "@/lib/cartContext";
import { formatNaira } from "@/lib/money";

export function MenuList({ vendor, isOpen, items }: { vendor: CartVendor; isOpen: boolean; items: ItemSummary[] }) {
  const { cart, add, replace, setQuantity } = useCart();
  const [pending, setPending] = useState<ItemSummary | null>(null);

  const qty = (itemId: string) => cart.lines.find((l) => l.itemId === itemId)?.quantity ?? 0;
  const line = (i: ItemSummary) => ({ itemId: i.id, name: i.name, priceKobo: i.priceKobo });

  return (
    <div className="mt-8">
      {pending && (
        <div role="alertdialog" aria-label="Start a new cart?" className="glass mb-6 p-5">
          <p>Your cart has items from <strong>{cart.vendor?.name}</strong>. One order is from one vendor. Start a new cart with {vendor.name}?</p>
          <div className="mt-4 flex gap-3">
            <button
              type="button"
              className="btn-primary"
              onClick={() => {
                replace(vendor, line(pending));
                setPending(null);
              }}
            >
              Start new cart
            </button>
            <button type="button" className="btn-ghost" onClick={() => setPending(null)}>Keep my cart</button>
          </div>
        </div>
      )}

      {items.length === 0 ? (
        <p className="text-muted">This vendor has no items yet.</p>
      ) : (
        <ul className="grid gap-4 md:grid-cols-2">
          {items.map((i) => {
            const q = qty(i.id);
            const canOrder = isOpen && i.isAvailable;
            return (
              <li key={i.id} className={`glass flex items-center justify-between gap-4 p-5 ${i.isAvailable ? "" : "opacity-60"}`}>
                <div>
                  <h2 className="font-semibold">{i.name}</h2>
                  {i.description && <p className="text-sm text-muted">{i.description}</p>}
                  <p className="mt-1 text-accent">{formatNaira(i.priceKobo)}</p>
                </div>
                {!i.isAvailable ? (
                  <span className="pill text-muted">Unavailable</span>
                ) : q === 0 ? (
                  <button
                    type="button"
                    className="btn-primary shrink-0"
                    disabled={!canOrder}
                    onClick={() => {
                      if (add(vendor, line(i)) === "conflict") setPending(i);
                    }}
                    aria-label={`Add ${i.name} to cart`}
                  >
                    Add
                  </button>
                ) : (
                  <div className="flex shrink-0 items-center gap-2" role="group" aria-label={`Quantity of ${i.name}`}>
                    <button type="button" className="btn-ghost !px-0 w-12" onClick={() => setQuantity(i.id, q - 1)} aria-label={`Remove one ${i.name}`}>−</button>
                    <span className="w-6 text-center" aria-live="polite" data-testid={`qty-${i.name}`}>{q}</span>
                    <button type="button" className="btn-ghost !px-0 w-12" disabled={q >= MAX_QTY} onClick={() => setQuantity(i.id, q + 1)} aria-label={`Add one more ${i.name}`}>+</button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
