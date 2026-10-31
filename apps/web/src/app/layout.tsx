import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Shuttle Tracker",
  description: "Track a badminton shuttlecock, draw its trajectory and export annotated video.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="th" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
