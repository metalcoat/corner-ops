"use client";
import { useEffect, useState } from "react";
import { RIDICULOUS_MENU_ADS } from "@/lib/games/menu-ads";
import "./menu-ad-ticker.css";
export function MenuAdTicker({
  overlay = false,
  roadside = false,
}: {
  overlay?: boolean;
  roadside?: boolean;
}) {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    const id = window.setInterval(
      () => setIndex((i) => (i + 1) % RIDICULOUS_MENU_ADS.length),
      4300,
    );
    return () => clearInterval(id);
  }, []);
  return (
    <aside
      className={`menu-ad-ticker ${overlay ? "overlay" : ""} ${roadside ? "roadside" : ""}`}
      aria-live="polite"
    >
      <b>{roadside ? "⚠ CORNER DELI AHEAD ⚠" : "ACTUAL MENU PROPAGANDA"}</b>
      <span key={index}>{RIDICULOUS_MENU_ADS[index]}</span>
    </aside>
  );
}
