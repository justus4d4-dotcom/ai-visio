"use client";

// Standalone /history route. The in-app experience opens History as a modal on the
// main page (which keeps the capture stream alive); this route reuses the same view
// for direct navigation / bookmarking.

import Link from "next/link";
import HistoryView from "@/components/HistoryView";

export default function HistoryPage() {
  return (
    <main className="min-h-screen p-6 max-w-5xl mx-auto">
      <header className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-semibold">History</h1>
        <Link
          href="/"
          className="rounded-lg border border-line px-3 py-1.5 text-sm hover:bg-panel-2"
        >
          Back
        </Link>
      </header>
      <HistoryView />
    </main>
  );
}
