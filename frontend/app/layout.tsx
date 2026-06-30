import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AI Image Interpreter",
  description: "Capture a screen region, interpret it with a vision LLM, show it on an ESP32 round display",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
