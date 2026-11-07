import type {Metadata} from "next";
import Game from "./delivery-game";
import "./delivery.css";
export const metadata:Metadata={title:"Corner Delivery Boy | Corner Deli",description:"Survive the delivery route and earn a free sub."};
export default function Page(){return <Game/>}
