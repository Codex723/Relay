export type OrderStatus =
  | "PENDING_PAYMENT"
  | "PAID"
  | "SEARCHING_RIDER"
  | "ASSIGNED"
  | "PICKED_UP"
  | "DELIVERED"
  | "CANCELLED"
  | "PAYMENT_REVIEW";

export const STEPS = [
  { label: "Awaiting payment" },
  { label: "Finding a rider" },
  { label: "Rider heading to the vendor" },
  { label: "On the way to you" },
  { label: "Delivered" },
] as const;

// Which step of the timeline an order is on. PAID is a moment before the search starts, so it shares a step.
export function stepIndex(status: OrderStatus): number {
  switch (status) {
    case "PENDING_PAYMENT":
      return 0;
    case "PAID":
    case "SEARCHING_RIDER":
      return 1;
    case "ASSIGNED":
      return 2;
    case "PICKED_UP":
      return 3;
    case "DELIVERED":
      return 4;
    default:
      return -1;
  }
}

// Colour of the status pill.
export function statusTone(status: OrderStatus): string {
  if (status === "DELIVERED") return "border-success text-success";
  if (status === "CANCELLED" || status === "PAYMENT_REVIEW") return "border-danger text-danger";
  return "border-accent text-accent";
}

export const isFinal = (status: OrderStatus): boolean => status === "DELIVERED" || status === "CANCELLED";

export function statusMessage(status: OrderStatus): { title: string; detail: string } {
  switch (status) {
    case "PENDING_PAYMENT":
      return { title: "Waiting for payment", detail: "Your order is saved. Pay to send it to the vendor." };
    case "PAID":
    case "SEARCHING_RIDER":
      return { title: "Finding a rider", detail: "Payment received. We are looking for the nearest rider." };
    case "ASSIGNED":
      return { title: "Rider on the way to the vendor", detail: "A rider has accepted your order and is heading to pick it up." };
    case "PICKED_UP":
      return { title: "On the way to you", detail: "Your rider has picked up your order." };
    case "DELIVERED":
      return { title: "Delivered", detail: "Enjoy your order!" };
    case "CANCELLED":
      return { title: "Order cancelled", detail: "This order was cancelled." };
    case "PAYMENT_REVIEW":
      return { title: "Payment under review", detail: "Your payment did not match the order total. Our team is checking it." };
  }
}

// Only allow in-app paths after sign-in, never another site.
export function safeNext(next: string | null | undefined): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.includes("\\")) return "/vendors";
  return next;
}
