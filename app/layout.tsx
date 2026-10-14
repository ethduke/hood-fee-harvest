import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "Hood Fee Harvest — Find your launchpad fees",
  description:
    "Look up unclaimed creator fees and onchain payout history on Robinhood Chain. No wallet connection required.",
  icons: { icon: "/favicon.svg" },
  robots: { index: true, follow: true },
};
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
