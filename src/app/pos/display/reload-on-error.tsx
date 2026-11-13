"use client";

import { useEffect } from "react";

/**
 * Error screen for the TV pages (menu board, greeter). Nobody can press a button on a TV, and the usual
 * cause is a page left running across an update (old page code, new data), so it reloads itself.
 */
export default function ReloadOnError({ error }: { error: unknown }) {
  useEffect(() => {
    console.error(error);
    const timer = window.setTimeout(() => window.location.reload(), 10_000);
    return () => window.clearTimeout(timer);
  }, [error]);
  return <main style={{ position: "fixed", inset: 0, background: "#0f1d14", color: "#a9bcab", display: "grid", placeItems: "center", font: "500 28px system-ui, sans-serif" }}>Updating the menu…</main>;
}
