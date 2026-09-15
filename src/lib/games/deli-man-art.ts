export type DeliManArtTheme = {
  background: string;
  surface: number;
  edge: number;
  face: number;
  shadow: number;
  accent: number;
  glow: number;
  particle: "steam" | "tickets" | "leaves" | "frost" | "crumbs" | "embers" | "dust" | "mist" | "paper";
  prop: "fryer" | "phone" | "street" | "freezer" | "rush" | "dock" | "gothic" | "closing" | "office";
};

export const DELI_MAN_ART: Record<string, DeliManArtTheme> = {
  fryer: {
    background: "/games/deli-man/backgrounds/fryer-hell-v3.png",
    surface: 0xb7a18a,
    edge: 0xff8a22,
    face: 0x4a2620,
    shadow: 0x160b0a,
    accent: 0xf04b28,
    glow: 0xff7a18,
    particle: "steam",
    prop: "fryer",
  },
  phone: {
    background: "/games/deli-man/backgrounds/phone-chaos-v3.png",
    surface: 0xc8c6b8,
    edge: 0x9f8cff,
    face: 0x444451,
    shadow: 0x171520,
    accent: 0xf04455,
    glow: 0x805dff,
    particle: "tickets",
    prop: "phone",
  },
  route: {
    background: "/games/deli-man/backgrounds/delivery-route-v3.png",
    surface: 0x73777a,
    edge: 0xe9e2c8,
    face: 0x292d31,
    shadow: 0x111315,
    accent: 0xffb52e,
    glow: 0xff7d32,
    particle: "leaves",
    prop: "street",
  },
  walkin: {
    background: "/games/deli-man/backgrounds/walkin-v3.png",
    surface: 0xd9f5ff,
    edge: 0xffffff,
    face: 0x54798b,
    shadow: 0x152b42,
    accent: 0x79e6ff,
    glow: 0x8deeff,
    particle: "frost",
    prop: "freezer",
  },
  friday: {
    background: "/games/deli-man/backgrounds/friday-night-v3.png",
    surface: 0xd4c2a1,
    edge: 0xf04435,
    face: 0x51352d,
    shadow: 0x1b0f11,
    accent: 0xffd438,
    glow: 0xff582e,
    particle: "crumbs",
    prop: "rush",
  },
  tiki: {
    background: "/games/deli-man/backgrounds/tiki-dimension-v3.png",
    surface: 0xb8753d,
    edge: 0xffb94d,
    face: 0x4c2e21,
    shadow: 0x15122c,
    accent: 0x35d8dc,
    glow: 0xff922f,
    particle: "embers",
    prop: "dock",
  },
  service: {
    background: "/games/deli-man/backgrounds/service-catacombs-v3.png",
    surface: 0x8b8791,
    edge: 0xe0c574,
    face: 0x38333e,
    shadow: 0x100e18,
    accent: 0xb23b48,
    glow: 0x66bce8,
    particle: "dust",
    prop: "gothic",
  },
  closing: {
    background: "/games/deli-man/backgrounds/closing-time-v3.png",
    surface: 0x71828c,
    edge: 0xb8e7ef,
    face: 0x283642,
    shadow: 0x090d16,
    accent: 0xe83232,
    glow: 0xe84335,
    particle: "mist",
    prop: "closing",
  },
  "owner-office": {
    background: "/games/deli-man/backgrounds/owners-office-v3.png",
    surface: 0x806a63,
    edge: 0xf0c34b,
    face: 0x392331,
    shadow: 0x100913,
    accent: 0xd1203d,
    glow: 0xff234f,
    particle: "paper",
    prop: "office",
  },
};

export function getDeliManArt(stageId: string): DeliManArtTheme {
  return DELI_MAN_ART[stageId] ?? DELI_MAN_ART.fryer;
}
