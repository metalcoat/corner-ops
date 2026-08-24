"use client";

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

function finiteAmount(value: number | null | undefined): number {
  const amount = Number(value ?? 0);
  return Number.isFinite(amount) ? amount : 0;
}

export function formatUsd(value: number | null | undefined): string {
  return usd.format(finiteAmount(value));
}

export function formatUsdFixed(value: number | null | undefined, digits = 0): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  }).format(finiteAmount(value));
}

export function formatUsdNullable(value: number | null | undefined, unavailable = "Balance unavailable"): string {
  return value === null || value === undefined ? unavailable : formatUsd(value);
}
