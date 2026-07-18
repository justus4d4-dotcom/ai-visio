import type { Metadata, Viewport } from "next";
import "./globals.css";
import AuthGate from "@/components/AuthGate";

export const metadata: Metadata = {
  title: "AI Image Interpreter",
  description: "Capture a screen region, interpret it with a vision LLM, show it on an ESP32 round display",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Extend the layout under the notch / rounded corners so full-screen camera works.
  viewportFit: "cover",
  themeColor: "#0a0a0a",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <AuthGate>{children}</AuthGate>
      </body>
    </html>
  );
}
