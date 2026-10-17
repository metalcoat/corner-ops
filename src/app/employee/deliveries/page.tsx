import type { Metadata } from "next";
import DriverDeliveries from "./driver-deliveries";
import "./deliveries.css";
export const metadata:Metadata={title:"My Deliveries | Corner Ops",description:"Corner Deli driver delivery workflow"};
export default function DeliveriesPage(){return <DriverDeliveries/>}
