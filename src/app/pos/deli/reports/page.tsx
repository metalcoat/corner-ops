import PosReports from "../../pos-reports";
import { getPosSession } from "@/lib/pos-auth";
import ManagerAccessGate from "../manager-access-gate";
import AiPhoneReport from "./ai-phone-report";
import Link from "next/link";
import "./reports.css";

export default async function DeliPosReportsPage() {
  const session = await getPosSession(true);
  if (!session) return <ManagerAccessGate />;
  if (session.posRole !== "manager" && session.posRole !== "owner") return <ManagerAccessGate denied />;
  return <><section className="posReportCard reportOperations"><h2>Register & inventory</h2><p>Back-of-house controls, current stock and live AI phone calls.</p><nav aria-label="Register and inventory"><Link href="/pos/deli/register">TILL CLOSEOUT / REGISTER</Link><Link href="/pos/deli/inventory">INVENTORY</Link><Link href="/pos/deli/inventory/costs">SUPPLIER COSTS</Link><Link href="/employee/stock">STOCK SHEET</Link><Link href="/pos/deli/ai-calls">AI CALL MONITOR</Link></nav></section><PosReports business="Corner Deli" /><AiPhoneReport /></>;
}
