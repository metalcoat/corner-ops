import type { Metadata } from "next";
import { getPosSession } from "@/lib/pos-auth";
import { houseAccountStatement } from "@/lib/ordering-house-accounts";
import HouseAccountStatement from "@/components/house-account-statement";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "House account statement | Corner Deli" };

/** Any employee signed in at the POS can show or print a customer's statement (outside the POS shell, so it prints clean). */
export default async function PosHouseAccountStatementPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ from?: string; to?: string }> }) {
  if (!(await getPosSession(true))) return <main className="haStatement"><h1>Sign in at the POS first</h1><p><a href="/pos/deli">Open the POS</a></p></main>;
  const [{ id }, { from, to }] = await Promise.all([params, searchParams]);
  const statement = await houseAccountStatement({ id, from, to });
  if (!statement) return <main className="haStatement"><h1>House account not found</h1></main>;
  return <HouseAccountStatement statement={statement} backHref={`/pos/deli/house-accounts?account=${statement.account.id}`} />;
}
