// DELI RAMPAGE content: the monsters, the streets, the buildings and everything
// the customers yell. All names are invented except the Ogdensburg street names.

export type MonsterId = "cook" | "pickle" | "slice";

export type Monster = {
  id: MonsterId;
  name: string;
  tagline: string;
  /** Walk speed, px per frame. */
  speed: number;
  /** Climb speed, px per frame. */
  climb: number;
  /** Damage per punch to a wall section. */
  punch: number;
  /** Patience (health). */
  patience: number;
  colors: { body: string; trim: string; accent: string; eye: string };
  breakLine: string;
};

export const MONSTERS: Monster[] = [
  {
    id: "cook",
    name: "THE COOK",
    tagline: "READ 400 COMPLAINTS. DRANK THE ESPRESSO DRIP TRAY.",
    speed: 1.25,
    climb: 1.1,
    punch: 2,
    patience: 100,
    colors: { body: "#f4f4f4", trim: "#c8c8c8", accent: "#d82800", eye: "#000" },
    breakLine: "THE COOK IS TAKING HIS 15.",
  },
  {
    id: "pickle",
    name: "BIG DILL",
    tagline: "MADE EYE CONTACT ONE TIME. NOW IT'S PERSONAL.",
    speed: 1.6,
    climb: 1.6,
    punch: 1,
    patience: 80,
    colors: { body: "#3c9a2c", trim: "#246d1a", accent: "#b8f070", eye: "#fff" },
    breakLine: "BIG DILL WENT BACK IN THE JAR.",
  },
  {
    id: "slice",
    name: "JUMBO SLICE",
    tagline: "TOO CHEESY, THEY SAID. NOT CHEESY ENOUGH, THEY SAID.",
    speed: 0.95,
    climb: 0.85,
    punch: 3,
    patience: 130,
    colors: { body: "#f8c838", trim: "#d88010", accent: "#c81810", eye: "#000" },
    breakLine: "JUMBO SLICE WENT COLD.",
  },
];

export const STREETS = [
  "MORRIS ST",
  "FORD ST",
  "STATE ST",
  "KNOX ST",
  "CANTON ST",
  "LAKE ST",
  "PATTERSON ST",
  "PROCTOR AVE",
  "PARK ST",
  "WASHINGTON ST",
];

/** Rooftop signs. Kept to 10 characters so they fit over a building. */
export const BUILDING_NAMES = [
  "VAPE+BAIT",
  "TAN + TAX",
  "LAUNDROMAT",
  "DOLLAR-ISH",
  "BINGO HALL",
  "LAWYER",
  "RACCOONS",
  "INSURANCE?",
  "DENTIST",
  "PAWN SHOP",
  "CHIRO",
  "NAILS",
  "HOA OFFICE",
  "YELP HQ",
  "COMPLAINTS",
  "TROPHIES",
  "PHONE FIX",
  "BAIL BONDS",
];

/** What customers yell out of the windows. Short enough for a speech bubble. */
export const COMPLAINTS = [
  "WHERE'S MY SUB?!",
  "I SAID NO MAYO!",
  "TOO MUCH CHEESE!",
  "NOT ENOUGH CHEESE!",
  "IT WAS 4 MIN LATE!",
  "IT WAS 4 MIN EARLY!",
  "MANAGER! NOW!",
  "COUPON'S FROM 2009!",
  "PICKLE LOOKED AT ME",
  "TASTED LIKE A SUB",
  "TOO HOT!",
  "TOO COLD!",
  "WHY DIAGONAL?!",
  "1 STAR. SEE YOU TUES",
  "DRIVER TOO POLITE",
  "CALLING THE PAPER!",
  "I WANTED IT WRONG!",
  "NOT PRE-CHEWED!",
  "HAIR! (I'M BALD)",
  "YOU CALL THIS RANCH?",
  "MY DOG HATES IT",
  "BAG TOO EASY TO OPEN",
  "TOO CORRECT!",
  "I'M TELLING FACEBOOK",
  "WHO TOLD YOU MY ORDER",
  "WHERE'S MY NAPKIN?",
  "NOTHING WRONG. MAD.",
];

/** What the managers-of-everything yell (the tougher window customers). */
export const MANAGER_LINES = [
  "I WANT YOUR MANAGER!",
  "AND HIS MANAGER!",
  "I KNOW THE OWNER!",
  "I'M A REGULAR! (1ST TIME)",
  "I'LL LEAVE A REVIEW!",
];

/** What a customer says after being handed a sub through the wall. */
export const SERVED_LINES = [
  "...OK THAT'S GOOD",
  "5 STARS. DON'T TELL ANYONE",
  "MMPH!",
  "I'LL ALLOW IT",
  "STILL MAD. BUT FULL.",
  "IS THIS EXTRA ONIONS?",
  "...HOW DID YOU KNOW",
  "FINE. 4 STARS.",
];

/** Shown when a building comes down. */
export const COLLAPSE_LINES = [
  "CLOSED: 1 STAR",
  "PERMANENTLY CLOSED",
  "UNDER NEW MANAGEMENT",
  "NOW A PARKING LOT",
  "OUT OF BUSINESS",
  "LEFT A REVIEW",
];

export const INSPECTOR_LINES = ["VIOLATION!", "TOO MANY PICKLES!", "WHERE'S YOUR HAIRNET", "CODE 4-B!"];

export const NEWS_LINES = ["CH 1-STAR NEWS", "LIVE: MONSTER!", "BREAKING: SUB"];
