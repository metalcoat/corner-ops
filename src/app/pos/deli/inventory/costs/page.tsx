import { getPosSession } from "@/lib/pos-auth";
import ManagerAccessGate from "../../manager-access-gate";
import SupplierCosts from "./supplier-costs";
import "./costs.css";

export const metadata = { title: "Supplier costs · Corner Deli" };

export default async function SupplierCostsPage() {
  const session = await getPosSession(true);
  if (!session) return <ManagerAccessGate />;
  if (session.posRole !== "manager" && session.posRole !== "owner") return <ManagerAccessGate denied />;
  return <SupplierCosts />;
}
