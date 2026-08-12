import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import MenuSettingsClient from "./settings-client";

export const dynamic = "force-dynamic";

export default async function MenuSettingsPage() {
  const session = await getSession();
  if (!session) redirect("/signin?next=/pos/deli/settings/menu");
  if (!["Owner", "Co-Owner", "Manager"].includes(session.role) || !session.businesses.includes("Corner Deli")) redirect("/pos/deli");
  return <MenuSettingsClient />;
}
