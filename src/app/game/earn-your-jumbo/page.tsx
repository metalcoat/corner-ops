import type { Metadata } from "next";
import Game from "./arcade-game";
import "./arcade.css";
import "./edge-coverage.css";
export const metadata:Metadata={title:"Earn Your Jumbo | Corner Deli",description:"Survive the Corner Deli Pizza Gauntlet and earn your jumbo."};
export default function Page(){return <Game/>}
