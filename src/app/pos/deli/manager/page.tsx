import { getPosSession } from "@/lib/pos-auth";
import ManagerReport from "../../../employee/manager/manager-report";
import ManagerAccessGate from "../manager-access-gate";

export default async function PosManagerReportPage() {
  const session = await getPosSession(true);
  if (!session) return <ManagerAccessGate />;
  if (session.posRole !== "manager" && session.posRole !== "owner") return <ManagerAccessGate denied />;
  return <ManagerReport />;
}
