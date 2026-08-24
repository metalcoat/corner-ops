"use client";

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

export function formatUsd(value: number | null | undefined): string {
  const amount = Number(value ?? 0);
  return usd.format(Number.isFinite(amount) ? amount : 0);
}

export function formatUsdNullable(value: number | null | undefined, unavailable = "Balance unavailable"): string {
  return value === null || value === undefined ? unavailable : formatUsd(value);
}
