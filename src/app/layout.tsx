import type { Metadata } from "next";
import { Inter, Calistoga } from "next/font/google";
import "./globals.css";

// UI design system: Calistoga (warm display serif for headings) + Inter (UI/body)
const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

const calistoga = Calistoga({
  subsets: ["latin"],
  weight: "400",
  variable: "--font-calistoga",
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
    <html lang="en" className={`${inter.variable} ${calistoga.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col font-sans bg-background text-foreground">
        {children}
      </body>
    </html>
  );
}
