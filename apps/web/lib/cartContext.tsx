"use client";

import { createContext, useContext, useEffect, useMemo, useReducer, useState, type ReactNode } from "react";
import { cartCount, cartReducer, cartSubtotalKobo, emptyCart, parseStoredCart, wouldConflict, type Cart, type CartLine, type CartVendor } from "./cart";

const KEY = "relay.cart.v1";

interface CartContextValue {
  cart: Cart;
  /** False until the saved cart has been read, so screens do not flash an empty cart. */
  ready: boolean;
  count: number;
  subtotalKobo: number;
  add: (vendor: CartVendor, line: Omit<CartLine, "quantity">) => "added" | "conflict";
  replace: (vendor: CartVendor, line: Omit<CartLine, "quantity">) => void;
  setQuantity: (itemId: string, quantity: number) => void;
  remove: (itemId: string) => void;
  clear: () => void;
}

const CartContext = createContext<CartContextValue | null>(null);

export function CartProvider({ children }: { children: ReactNode }) {
  const [cart, dispatch] = useReducer(cartReducer, emptyCart);
  const [ready, setReady] = useState(false);

  // Read after mount (not during render) so the server and browser render the same first HTML.
  useEffect(() => {
    try {
      dispatch({ type: "hydrate", cart: parseStoredCart(window.localStorage.getItem(KEY)) });
    } catch {
      // storage unavailable (private mode): carry on with an in-memory cart
    }
    setReady(true);
    // Keep several tabs in step.
    const onStorage = (e: StorageEvent) => {
      if (e.key === KEY) dispatch({ type: "hydrate", cart: parseStoredCart(e.newValue) });
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  useEffect(() => {
    if (!ready) return;
    try {
      window.localStorage.setItem(KEY, JSON.stringify(cart));
    } catch {
      // ignore
    }
  }, [cart, ready]);

  const value = useMemo<CartContextValue>(
    () => ({
      cart,
      ready,
      count: cartCount(cart),
      subtotalKobo: cartSubtotalKobo(cart),
      add: (vendor, line) => {
        if (wouldConflict(cart, vendor.id)) return "conflict";
        dispatch({ type: "add", vendor, line });
        return "added";
      },
      replace: (vendor, line) => dispatch({ type: "replace", vendor, line }),
      setQuantity: (itemId, quantity) => dispatch({ type: "setQuantity", itemId, quantity }),
      remove: (itemId) => dispatch({ type: "remove", itemId }),
      clear: () => dispatch({ type: "clear" }),
    }),
    [cart, ready],
  );
  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export function useCart(): CartContextValue {
  const ctx = useContext(CartContext);
  if (!ctx) throw new Error("useCart must be used inside CartProvider");
  return ctx;
}
