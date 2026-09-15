export type StageDef = {
  id: string;
  name: string;
  theme: number;
  boss: string;
  ability: string;
  intro: string;
  hazards: string[];
  lines: string[];
};
export const STAGES: StageDef[] = [
  {
    id: "fryer",
    name: "FRYER HELL",
    theme: 0xff6b22,
    boss: "FATHEAD",
    ability: "BUFFALO BURST",
    intro:
      "FATHEAD HAS ENTERED THE CHAT.\nHE HAS REQUESTED A MANAGER.\nTHERE IS NO MANAGER. GOOD LUCK.",
    hazards: ["FRY GOBLIN", "ROGUE TOT", "FRY BASKET"],
    lines: ["CAUTION: GREASE HAS ACQUIRED SENTIENCE"],
  },
  {
    id: "phone",
    name: "THE PHONE NEVER STOPS",
    theme: 0x7548db,
    boss: "INVALID MODIFIER",
    ability: "ALIAS CANNON",
    intro: "CUSTOMER SAID 'NACHO FRIES.'\nSYSTEM HEARD 'DESTROY EVERYTHING.'",
    hazards: ["RINGING PHONE", "BAD TRANSCRIPT", "HOLD MUSIC"],
    lines: [
      "CAN I GET A LARGE MEDIUM PIZZA?",
      "TRANSLATION ENGINE ENGAGED. GOD HAS ABANDONED US.",
    ],
  },
  {
    id: "route",
    name: "DELIVERY ROUTE 666",
    theme: 0x4a8e45,
    boss: "THE DOE",
    ability: "VENISON DASH",
    intro: "COMPANY VEHICLE STATUS:\nWE DON'T WANT TO TALK ABOUT IT.",
    hazards: ["POTHOLE", "BAD GPS", "DEER"],
    lines: [
      "GPS: YOU HAVE ARRIVED.",
      "WILDLIFE DETECTED. CRAIG PROTOCOL DISABLED.",
    ],
  },
  {
    id: "walkin",
    name: "THE WALK-IN",
    theme: 0x65ccec,
    boss: "FREEZER BURN",
    ability: "CHICKEN SHIELD",
    intro: "IF FOUND FROZEN IN HERE\nCLOCK ME OUT FIRST.",
    hazards: ["FROZEN BOX", "FROST", "CHICKEN"],
    lines: ["THE EMPLOYEE BREAK ROOM: ONE CHAIR. NO QUESTIONS."],
  },
  {
    id: "friday",
    name: "FRIDAY NIGHT",
    theme: 0xd73b31,
    boss: "THE RUSH",
    ability: "RUSH MODE",
    intro: "5:01 PM\nTHE PRINTER HAS BEGUN SCREAMING.",
    hazards: ["TICKET SWARM", "DOORDASH DRIVER", "PHONE"],
    lines: [
      "5:02 PM — 17 ORDERS RECEIVED.",
      "5:03 PM — SOMEONE ORDERED 14 JUMBOS.",
      "ORDER WAS PLACED 11 SECONDS AGO.",
    ],
  },
  {
    id: "tiki",
    name: "THE TIKI DIMENSION",
    theme: 0x18a8a8,
    boss: "LAKE ONTARIO",
    ability: "TIKI WAVE",
    intro: "NORTHERN NEW YORK WEATHER ENGINE\nOPERATING WITHIN SPECIFICATIONS.",
    hazards: ["WIND", "COOLER", "BOAT"],
    lines: ["HOURS SUBJECT TO WEATHER, STAFFING, BOATS, ACTS OF GOD."],
  },
  {
    id: "service",
    name: "CUSTOMER SERVICE CATACOMBS",
    theme: 0x57515f,
    boss: "THE REVIEWER",
    ability: "ONE-STAR BEAM",
    intro:
      "CHEESE APPLIED: 16.0 OZ\nREQUIRED: 16.0 OZ\nCUSTOMER CONFIDENCE: ABSOLUTE.",
    hazards: ["ONE STAR", "REFUND GHOST", "OLD REVIEW"],
    lines: [
      "THESE USED TO BE LOADED.",
      "HISTORICAL LOADEDNESS RECORDS NOT FOUND.",
    ],
  },
  {
    id: "closing",
    name: "CLOSING TIME",
    theme: 0x202738,
    boss: "LAST MINUTE ORDER",
    ability: "LAST CALL",
    intro: "10:58 PM\nKITCHEN CLOSES AT 11:00 PM.",
    hazards: ["MOP BUCKET", "TRASH", "RINGING PHONE"],
    lines: [
      "10:59 PM",
      "HEY ARE YOU GUYS STILL OPEN?",
      "+ 2 JUMBOS · + 50 WINGS · ACTUALLY MAKE THAT 100",
    ],
  },
];
export const INCIDENTS = [
  "THE DEER WAS NOT AN AUTHORIZED DELIVERY CUSTOMER.",
  "STOP REFERRING TO THE WALK-IN AS THE CRYING ROOM.",
  "FOUR MEANS FOUR. IT HAS ALWAYS MEANT FOUR.",
  "NOBODY KNOWS WHY GREG HAD THE KEYS.",
  "THE FRYER BASKET IS NOT AN EMPLOYEE.",
  "THE CUSTOMER'S COUSIN DOES NOT SET PORTIONS.",
  "THE GOOSE IS BANNED FROM BOTH ENTRANCES.",
  "THE PRINTER PAPER WAS FOUND HIDING.",
];
