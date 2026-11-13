import type { Metadata } from "next";
import SubMission from "./sub-mission";
import "../deli-rampage/deli-rampage.css";

export const metadata: Metadata = {
  title: "SUB-MISSION: Over the Counter",
  description: "A hangry customer is reaching over the counter. Duck, dodge, ring the bell and feed them into a food coma. A Corner Deli arcade game.",
};

export default function Page() {
  return <SubMission />;
}
