import Link from "next/link";
import type { ReactNode } from "react";
import { getPosSession } from "@/lib/pos-auth";
import ManagerAccessGate from "../manager-access-gate";
import "./settings.css";

const links = [
  ["Overview", "/pos/deli/settings"], ["Menu", "/pos/deli/settings/menu"],
  ["Hardware", "/pos/deli/settings/hardware"], ["Operations", "/pos/deli/settings/operations"],
  ["Delivery", "/pos/deli/settings/delivery"], ["Promotions", "/pos/deli/settings/promotions"],
  ["Loyalty", "/pos/deli/settings/loyalty"], ["Gift Cards", "/pos/deli/settings/gift-cards"],
  ["Barcode", "/pos/deli/settings/barcode"],
] as const;

export default async function SettingsLayout({ children }: { children: ReactNode }) {
  const session = await getPosSession(true);
  if (!session) return <ManagerAccessGate />;
  if (session.posRole !== "manager" && session.posRole !== "owner") return <ManagerAccessGate denied />;
  return <div className="managerSettingsWorkspace"><nav aria-label="Settings sections">{links.map(([label, href]) => <Link key={href} href={href}>{label}</Link>)}</nav>{children}</div>;
}
