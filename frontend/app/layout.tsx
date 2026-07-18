import type { Metadata, Viewport } from "next";
import "./globals.css";
import AuthGate from "@/components/AuthGate";
import PwaRegister from "@/components/PwaRegister";
import InstallPrompt from "@/components/InstallPrompt";
import { AlertsProvider } from "@/components/Alerts";

export const metadata: Metadata = {
  title: "AI VISIO",
  description: "Capture a screen region, interpret it with a vision LLM, show it on a round Display",
  applicationName: "AI VISIO",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "AI VISIO",
  },
  icons: {
    icon: [
      { url: "/icon.svg", type: "image/svg+xml" },
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180" }],
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Extend the layout under the notch / rounded corners so full-screen camera works.
  viewportFit: "cover",
  themeColor: "#1a1d26",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <head>
        {/* Apply the saved theme before paint to avoid a flash of the wrong theme. */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              "(function(){try{var t=localStorage.getItem('ai_visio_theme');var d=t?t==='dark':true;var c=document.documentElement.classList;c.toggle('dark',d);c.toggle('light',!d);}catch(e){}})();",
          }}
        />
      </head>
      <body>
        <PwaRegister />
        <InstallPrompt />
        <AlertsProvider>
          <AuthGate>{children}</AuthGate>
        </AlertsProvider>
      </body>
    </html>
  );
}
