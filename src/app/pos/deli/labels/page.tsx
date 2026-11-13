import { redirect } from "next/navigation";

// The label station lives at /pos/labels, outside the POS, so it never locks.
export default function OldLabelStationPage() {
  redirect("/pos/labels");
}
