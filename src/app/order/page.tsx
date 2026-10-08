import type { Metadata } from "next";
import CustomerOrder from "./customer-order";
import "./order.css";

export const metadata: Metadata = { title: "Order Online | Corner Deli", description: "Browse the Corner Deli menu and build a pickup or delivery order." };
export default function OrderPage() { return <CustomerOrder />; }
