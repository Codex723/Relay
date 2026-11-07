import type { ReactNode } from "react";

export const metadata = { title: "RELAY", description: "Move the city." };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, background: "#070B14", color: "#F4F1EA", fontFamily: "system-ui, sans-serif" }}>
        {children}
      </body>
    </html>
  );
}
