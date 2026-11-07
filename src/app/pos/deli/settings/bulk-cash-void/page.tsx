import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { localDevToolsAllowed } from "@/lib/local-dev-tools";
import { getPosSession } from "@/lib/pos-auth";
import ManagerAccessGate from "../../manager-access-gate";
import BulkCashVoidSettings from "./bulk-cash-void-settings";
import "../../orders/orders.css";

export default async function BulkCashVoidSettingsPage() {
  const session = await getPosSession(true);
  if (session?.posRole !== "owner") return <ManagerAccessGate denied />;
  if (!localDevToolsAllowed(process.env, (await headers()).get("host"))) notFound();
  return <BulkCashVoidSettings />;
}
