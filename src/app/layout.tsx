import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

// UI/UX design system: Inter font (Donor spec §Design System)
const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

export const metadata: Metadata = {
  title: "FoodLink — Rescue food. Feed your community.",
  description: "A three-sided food redistribution marketplace connecting donors, consumers, and couriers.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${inter.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col font-[family-name:var(--font-inter)]">
        {children}
      </body>
    </html>
  );
}
