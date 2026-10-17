import type { Metadata } from "next";
import JumboRush from "./jumbo-rush";
import "./jumbo-rush.css";

export const metadata: Metadata = {
  title: "Jumbo Rush | Earn Your Jumbo | Corner Deli",
  description: "Slice every pizza, dodge the phone, survive the rush and earn a free Jumbo Cheese Pizza.",
};

export default function Page() {
  return <JumboRush />;
}
