import type { Metadata } from "next";
import QRCode from "qrcode";
import Greeter from "./greeter";
import "./greeter.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Welcome | Corner Deli" };

/**
 * The customer-facing TV by the front door (Raspberry Pi in kiosk mode): the logo and an
 * order-online QR code, switching to a spoken welcome whenever the camera sees a walk-in.
 */
export default async function GreeterPage() {
  const orderUrl = process.env.GREETER_ORDER_URL?.trim() || "https://ordercornerdeli.com";
  const qrSvg = await QRCode.toString(orderUrl, { type: "svg", margin: 1, errorCorrectionLevel: "M", color: { dark: "#111111", light: "#ffffff" } });
  return <Greeter qrSvg={qrSvg} orderUrl={orderUrl.replace(/^https?:\/\//, "").replace(/\/$/, "")} />;
}
