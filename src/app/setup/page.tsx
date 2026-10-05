import type { Metadata } from "next";
import DeviceSetup from "./device-setup";
import "./setup.css";

export const metadata: Metadata = { title: "Set up this tablet | Corner Deli", robots: { index: false, follow: false } };

export default function SetupPage() {
  return <DeviceSetup />;
}
