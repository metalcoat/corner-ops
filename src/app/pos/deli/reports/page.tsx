import PosReports from "../../pos-reports";
import { getPosSession } from "@/lib/pos-auth";
import ManagerAccessGate from "../manager-access-gate";

export default async function DeliPosReportsPage() {
  const session = await getPosSession(true);
  if (!session) return <ManagerAccessGate />;
  if (session.posRole !== "manager" && session.posRole !== "owner") return <ManagerAccessGate denied />;
  return <PosReports business="Corner Deli" />;
}
