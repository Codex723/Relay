export const MAX_QTY = 20;

export interface CartVendor {
  id: string;
  name: string;
  city: "ABUJA" | "LAGOS";
  lat: number;
  lng: number;
}
export interface CartLine {
  itemId: string;
  name: string;
  /** For display only. The server always prices the order from its own data. */
  priceKobo: number;
  quantity: number;
}
export interface Cart {
  vendor: CartVendor | null;
  lines: CartLine[];
}
export const emptyCart: Cart = { vendor: null, lines: [] };

export type CartAction =
  | { type: "hydrate"; cart: Cart }
  | { type: "add"; vendor: CartVendor; line: Omit<CartLine, "quantity"> }
  | { type: "replace"; vendor: CartVendor; line: Omit<CartLine, "quantity"> }
  | { type: "setQuantity"; itemId: string; quantity: number }
  | { type: "remove"; itemId: string }
  | { type: "clear" };

// One order is for one vendor. Adding from another vendor is refused here; the screen asks the customer
// whether to start a new cart and then sends "replace".
export function wouldConflict(cart: Cart, vendorId: string): boolean {
  return cart.lines.length > 0 && cart.vendor !== null && cart.vendor.id !== vendorId;
}

export function cartReducer(cart: Cart, action: CartAction): Cart {
  switch (action.type) {
    case "hydrate":
      return action.cart;
    case "replace":
      return { vendor: action.vendor, lines: [{ ...action.line, quantity: 1 }] };
    case "add": {
      if (wouldConflict(cart, action.vendor.id)) return cart;
      const existing = cart.lines.find((l) => l.itemId === action.line.itemId);
      const lines = existing
        ? cart.lines.map((l) => (l.itemId === existing.itemId ? { ...l, quantity: Math.min(MAX_QTY, l.quantity + 1) } : l))
        : [...cart.lines, { ...action.line, quantity: 1 }];
      return { vendor: action.vendor, lines };
    }
    case "setQuantity": {
      const quantity = Math.min(MAX_QTY, Math.floor(action.quantity));
      const lines = cart.lines
        .map((l) => (l.itemId === action.itemId ? { ...l, quantity } : l))
        .filter((l) => l.quantity > 0);
      return lines.length === 0 ? emptyCart : { ...cart, lines };
    }
    case "remove": {
      const lines = cart.lines.filter((l) => l.itemId !== action.itemId);
      return lines.length === 0 ? emptyCart : { ...cart, lines };
    }
    case "clear":
      return emptyCart;
  }
}

export const cartCount = (cart: Cart): number => cart.lines.reduce((n, l) => n + l.quantity, 0);
export const cartSubtotalKobo = (cart: Cart): number => cart.lines.reduce((sum, l) => sum + l.priceKobo * l.quantity, 0);

// Anything read back from localStorage is untrusted: a bad value gives an empty cart, never an error.
export function parseStoredCart(raw: string | null): Cart {
  if (!raw) return emptyCart;
  try {
    const data = JSON.parse(raw) as Partial<Cart> | null;
    const v = data?.vendor;
    if (!v || typeof v.id !== "string" || typeof v.name !== "string" || (v.city !== "ABUJA" && v.city !== "LAGOS")) return emptyCart;
    if (typeof v.lat !== "number" || typeof v.lng !== "number" || !Array.isArray(data?.lines)) return emptyCart;
    const lines: CartLine[] = [];
    for (const l of data.lines) {
      const ok =
        l && typeof l.itemId === "string" && typeof l.name === "string" && Number.isInteger(l.priceKobo) && l.priceKobo >= 0 &&
        Number.isInteger(l.quantity) && l.quantity >= 1 && l.quantity <= MAX_QTY;
      if (!ok) return emptyCart;
      lines.push({ itemId: l.itemId, name: l.name, priceKobo: l.priceKobo, quantity: l.quantity });
    }
    return lines.length === 0 ? emptyCart : { vendor: { id: v.id, name: v.name, city: v.city, lat: v.lat, lng: v.lng }, lines };
  } catch {
    return emptyCart;
  }
}
