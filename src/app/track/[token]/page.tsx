import type { Metadata } from "next";
import CustomerDeliveryTracker from "./tracker";
import "./tracker.css";
export const metadata:Metadata={title:"Delivery status | Corner Deli",robots:{index:false,follow:false}};
export default async function TrackingPage({params}:{params:Promise<{token:string}>}){return <CustomerDeliveryTracker token={(await params).token}/>}
