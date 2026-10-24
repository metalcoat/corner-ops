import ManagerRemakesClient from "./remakes-client";
import { remakeManager } from "@/lib/ordering-remakes";
import "./remakes.css";

export const dynamic = "force-dynamic";

export default async function ManagerRemakesPage() {
  if (!await remakeManager()) return <main className="remakePage"><h1>Manager access required</h1><p>Your operations account cannot create complaint remakes.</p></main>;
  return <ManagerRemakesClient />;
}
