import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getEmployeeSession } from "@/lib/employee-auth";
import OrderSearch from "./order-search";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Order search | Corner Deli" };

export default async function EmployeeOrderSearchPage() {
  const session = await getEmployeeSession();
  if (!session) redirect("/employee");
  if (session.business !== "Corner Deli" || (session.posRole !== "manager" && session.posRole !== "owner")) return <main className="employeePortalContent"><h1>Managers only</h1><p>Ask a manager if you need to look up an order.</p></main>;
  return <OrderSearch />;
}
