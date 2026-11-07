import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getEmployeeSession } from "@/lib/employee-auth";
import HouseAccounts from "./house-accounts";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "House accounts | Corner Deli" };

export default async function EmployeeHouseAccountsPage() {
  const session = await getEmployeeSession();
  if (!session) redirect("/employee");
  if (session.business !== "Corner Deli" || (session.posRole !== "manager" && session.posRole !== "owner")) return <main className="employeePortalContent"><h1>Managers only</h1><p>Ask a manager if you need a house account.</p></main>;
  return <HouseAccounts />;
}
