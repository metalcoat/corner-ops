export type SiteBrand = {
  name: string;
  icon: string;
  teamHost: boolean;
};

const OWNER_BRAND: SiteBrand = { name: "Corner Ops", icon: "/corner-ops-icon.svg", teamHost: false };

export function siteBrandForHost(hostname: string): SiteBrand {
  switch (hostname.toLowerCase().split(":")[0]) {
    case "team.ordercornerdeli.com":
      return { name: "Corner Deli", icon: "/corner-deli-logo.png", teamHost: true };
    case "team.atthedocks.com":
      return { name: "At the Docks", icon: "/at-the-docks-logo.svg", teamHost: true };
    default:
      return OWNER_BRAND;
  }
}
