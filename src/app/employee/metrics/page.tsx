import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getEmployeeSession } from "@/lib/employee-auth";
import SalesMetrics from "./sales-metrics";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Sales metrics | Corner Deli" };

export default async function EmployeeMetricsPage() {
  const session = await getEmployeeSession();
  if (!session) redirect("/employee");
  if (session.business !== "Corner Deli" || (session.posRole !== "manager" && session.posRole !== "owner")) return <main className="employeePortalContent"><h1>Managers only</h1><p>Ask a manager if you need these numbers.</p></main>;
  return <SalesMetrics />;
}
