import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "Hood Fee Harvest — Find your launchpad fees",
  description:
    "Connect your wallet to discover unclaimed launchpad fees, review claims and track verified payouts on Robinhood Chain.",
  icons: { icon: "/favicon.svg" },
  robots: { index: true, follow: true },
};
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" style={{ colorScheme: "dark" }}>
      <body>{children}</body>
    </html>
  );
}
