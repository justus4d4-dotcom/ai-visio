"use client";

// Standalone /usage (Monitoring) route. The in-app experience opens Monitoring as a
// modal on the main page (which keeps the capture stream alive); this route reuses the
// same view for direct navigation / bookmarking.

import Link from "next/link";
import UsageView from "@/components/UsageView";

export default function UsagePage() {
  return (
    <main className="min-h-screen p-6 max-w-5xl mx-auto">
      <header className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Monitoring</h1>
        <Link
          href="/"
          className="rounded-lg border border-neutral-700 px-3 py-1.5 text-sm hover:bg-neutral-800"
        >
          Back
        </Link>
      </header>
      <UsageView />
    </main>
  );
}
