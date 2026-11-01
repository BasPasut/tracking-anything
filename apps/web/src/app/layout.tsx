import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Shuttle Tracker",
  description: "Track a badminton shuttlecock, draw its trajectory and export annotated video.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Draw under notches and rounded corners; padding uses safe-area insets instead.
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#fafafa" },
    { media: "(prefers-color-scheme: dark)", color: "#0a0a0a" },
  ],
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="th" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
