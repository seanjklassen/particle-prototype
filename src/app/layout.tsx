import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "mercury-chips-morph",
  description: "Hero chips morph into a CTA via particles.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {/* Global bottom blur overlay to affect all content */}
        <div className="pointer-events-none fixed left-0 right-0 bottom-0 h-72 blur-fade-bottom z-[9999]" />
        {children}
      </body>
    </html>
  );
}
