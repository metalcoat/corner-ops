import type { CapacitorConfig } from "@capacitor/cli";

const posUrl = process.env.CORNER_OPS_MOBILE_URL || "https://dev.ordercornerdeli.com/pos/deli";

const config: CapacitorConfig = {
  appId: "com.ordercornerdeli.pos",
  appName: "Corner Deli POS",
  webDir: "mobile-shell",
  server: {
    url: posUrl,
    allowNavigation: [new URL(posUrl).hostname],
    cleartext: false,
  },
  backgroundColor: "#07120d",
  android: {
    allowMixedContent: false,
    backgroundColor: "#07120d",
  },
  ios: {
    backgroundColor: "#07120d",
    contentInset: "automatic",
    preferredContentMode: "mobile",
  },
};

export default config;
