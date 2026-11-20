import type { Metadata } from "next";
import "./globals.css";
import "../src/saas.css";

export const metadata: Metadata = {
  title: "TableServe | Scan · Order · Dine",
  description: "Scan, order, and dine with TableServe.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
