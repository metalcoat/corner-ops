import type { Metadata } from "next";
import DeliMan from "./deli-man";
import "./deli-man.css";
export const metadata: Metadata = {
  title: "DELI MAN: The Last Jumbo",
  description: "An original Corner Deli action-platformer.",
};
export default function Page() {
  return <DeliMan />;
}
