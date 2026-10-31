import { redirect } from "next/navigation";

/** The dashboard lives outside the POS menu now (owner request 2026-10-29). */
export default function StoreDashboardPage() { redirect("/pos/dashboard"); }
