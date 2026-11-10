import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Allowance: a shopping agent that pays inside a parent's rules",
  description: "Kip shops for a teenager with the family's saved PayPal, but only inside a signed spending mandate. A PayPal sandbox prototype.",
  icons: { icon: "/kip.svg" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#fbf6ee",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
