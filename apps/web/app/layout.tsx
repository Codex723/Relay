import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { CartBar, Header } from "@/components/Header";
import { AuthProvider } from "@/lib/auth";
import { CartProvider } from "@/lib/cartContext";
import "./globals.css";

export const metadata: Metadata = {
  title: "RELAY: Move the city",
  description: "Order from vendors in Abuja and Lagos, pay in naira, and watch your rider arrive.",
};
export const viewport: Viewport = { width: "device-width", initialScale: 1, viewportFit: "cover", themeColor: "#070B14" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        {/* Fonts load at runtime and fall back to system fonts if they cannot be reached. */}
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Anton&family=Inter:wght@400;500;600&family=Playfair+Display:ital@1&display=swap"
        />
      </head>
      <body>
        <AuthProvider>
          <CartProvider>
            <Header />
            <main className="mx-auto max-w-6xl px-4 pb-28 pt-6">{children}</main>
            <CartBar />
          </CartProvider>
        </AuthProvider>
      </body>
    </html>
  );
}
