import StoreDashboard from "./store-dashboard";
import Link from "next/link";
import "./store-dashboard.css";
export const dynamic="force-dynamic";
export default function StoreDashboardPage(){return <><nav className="dashboardBackOffice" aria-label="Back of house"><strong>Back of house</strong><Link href="/pos/deli/register">REGISTER</Link><Link href="/pos/deli/inventory">INVENTORY</Link></nav><StoreDashboard/></>}
