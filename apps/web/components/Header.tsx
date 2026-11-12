"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth";
import { useCart } from "@/lib/cartContext";
import { formatNaira } from "@/lib/money";

export function Header() {
  const { status, user, logout } = useAuth();
  const { count } = useCart();
  const router = useRouter();
  return (
    <header className="sticky top-0 z-30 border-b border-line bg-bg/80 backdrop-blur">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-x-3 px-4 py-2">
        <Link href="/" className="font-display text-2xl tracking-wide">
          RELAY
        </Link>
        <nav aria-label="Main" className="flex items-center gap-3 whitespace-nowrap text-sm sm:gap-6">
          <Link href="/vendors" className="min-h-[44px] content-center">Vendors</Link>
          {status === "authed" && <Link href="/orders" className="min-h-[44px] content-center">Orders</Link>}
          <Link href="/cart" className="relative min-h-[44px] content-center">
            Cart
            {count > 0 && (
              <span data-testid="cart-count" className="ml-1 rounded-full bg-accent px-2 py-0.5 text-xs font-semibold text-bg">
                {count}
              </span>
            )}
          </Link>
          {status === "authed" ? (
            <button
              type="button"
              className="min-h-[44px] text-muted hover:text-ink"
              onClick={async () => {
                await logout();
                router.push("/");
              }}
              aria-label={`Sign out ${user?.name ?? ""}`}
            >
              Sign out
            </button>
          ) : status === "anon" ? (
            <Link href="/login" className="min-h-[44px] content-center">Sign in</Link>
          ) : null}
        </nav>
      </div>
    </header>
  );
}

// A bar at the bottom of browsing screens that shows the cart and links to it.
export function CartBar() {
  const { count, subtotalKobo } = useCart();
  const path = usePathname();
  const hidden = ["/cart", "/checkout", "/orders", "/login", "/register"].some((p) => path.startsWith(p));
  if (count === 0 || hidden) return null;
  return (
    <div className="fixed inset-x-0 bottom-0 z-20 px-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
      <Link href="/cart" className="glass mx-auto flex max-w-xl items-center justify-between bg-bg/90 px-6 py-4 shadow-xl">
        <span className="font-semibold">
          {count} {count === 1 ? "item" : "items"} · {formatNaira(subtotalKobo)}
        </span>
        <span className="text-accent">View cart →</span>
      </Link>
    </div>
  );
}
