import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getEmployeeSession } from "@/lib/employee-auth";
import { houseAccountManager } from "@/lib/house-account-access";
import { houseAccountStatement } from "@/lib/ordering-house-accounts";
import HouseAccountStatement from "@/components/house-account-statement";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "House account statement | Corner Deli" };

export default async function HouseAccountStatementPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ from?: string; to?: string }> }) {
  if (!(await houseAccountManager())) {
    if (!(await getEmployeeSession())) redirect("/employee");
    return <main className="employeePortalContent"><h1>Managers only</h1></main>;
  }
  const [{ id }, { from, to }] = await Promise.all([params, searchParams]);
  const statement = await houseAccountStatement({ id, from, to });
  if (!statement) return <main className="haStatement"><h1>House account not found</h1></main>;
  return <HouseAccountStatement statement={statement} backHref={`/employee/manager/house-accounts?account=${statement.account.id}`} />;
}
