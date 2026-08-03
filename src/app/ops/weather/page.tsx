import { redirect } from "next/navigation";

export default function WeatherPage() {
  redirect("/ops/reports#weather");
}
