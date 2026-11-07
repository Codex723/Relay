import { randomBytes } from "node:crypto";

// References look like rly_<order id without dashes>_<6 random hex>. The order id is in the reference,
// so a payment can always be traced to its order, and a retry gets a fresh, unique reference.
const PATTERN = /^rly_([0-9a-f]{32})_[0-9a-f]{6}$/;

export function makeReference(orderId: string): string {
  return `rly_${orderId.replaceAll("-", "")}_${randomBytes(3).toString("hex")}`;
}

export function orderIdFromReference(reference: string): string | null {
  const m = PATTERN.exec(reference);
  if (!m) return null;
  const h = m[1];
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
