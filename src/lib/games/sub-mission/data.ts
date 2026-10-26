// SUB-MISSION: OVER THE COUNTER — the customers, and everything everybody yells.
// Only the font's characters: A-Z 0-9 ! ? . , ' - : / % + ( ) # & = > < * @ (no dollar sign, no double quotes).

export type Attack = "choke" | "slap" | "throw" | "scream" | "double";
export type ThrowKind = "coupon" | "ranch" | "review";

export type Customer = {
  id: string;
  name: string;
  title: string;
  /** How hangry they walk in. Feeding them brings it to zero: FOOD COMA. */
  hangry: number;
  /** Wind-up length multiplier; lower is faster. */
  speed: number;
  /** Bell presses it takes to get out of their grip. */
  grip: number;
  attacks: ReadonlyArray<{ kind: Attack; weight: number }>;
  throws: ThrowKind;
  colors: { skin: string; hair: string; shirt: string; accent: string };
  intro: string;
  taunts: readonly string[];
  koLine: string;
};

export const CUSTOMERS: readonly Customer[] = [
  {
    id: "carol",
    name: "COUPON CAROL",
    title: "COUPON FOR A STORE THAT CLOSED IN 1994",
    hangry: 90,
    speed: 1.15,
    grip: 10,
    attacks: [
      { kind: "slap", weight: 3 },
      { kind: "throw", weight: 3 },
      { kind: "choke", weight: 1 },
    ],
    throws: "coupon",
    colors: { skin: "#f0c8a0", hair: "#c8c8d0", shirt: "#c05890", accent: "#f8e070" },
    intro: "SHE HAS A COUPON. IT EXPIRED IN 2009. SO DID HER PATIENCE.",
    taunts: ["IT SAYS BOGO RIGHT HERE!", "I'VE BEEN COMING HERE SINCE 1971!", "THE OTHER GIRL HONORED IT!", "DO YOU KNOW WHO MY SON IS?"],
    koLine: "...IS THIS THE TURKEY? OH MY. OH, THAT'S NICE.",
  },
  {
    id: "randy",
    name: "RANCH RANDY",
    title: "WANTS RANCH ON THE RANCH",
    hangry: 120,
    speed: 1,
    grip: 13,
    attacks: [
      { kind: "throw", weight: 4 },
      { kind: "slap", weight: 2 },
      { kind: "choke", weight: 2 },
    ],
    throws: "ranch",
    colors: { skin: "#e8a878", hair: "#7a4a20", shirt: "#3a6a3a", accent: "#e83020" },
    intro: "HE ASKED FOR EXTRA RANCH. THEN EXTRA EXTRA. THEN HE BROUGHT HIS OWN.",
    taunts: ["THAT'S NOT A CUP, THAT'S A THIMBLE!", "RANCH IS A BEVERAGE!", "I WANT TO SEE THE BOTTOM OF THE BOTTLE!", "DIP THE SUB IN IT. THE WHOLE SUB."],
    koLine: "...RANCH AND A SUB. TOGETHER. LIKE FAMILY.",
  },
  {
    id: "karen",
    name: "KAREN OF THE NORTH",
    title: "WANTS YOUR MANAGER'S MANAGER",
    hangry: 140,
    speed: 0.92,
    grip: 15,
    attacks: [
      { kind: "scream", weight: 3 },
      { kind: "slap", weight: 3 },
      { kind: "choke", weight: 2 },
      { kind: "throw", weight: 1 },
    ],
    throws: "review",
    colors: { skin: "#f8d0b0", hair: "#e8c050", shirt: "#4878c8", accent: "#202020" },
    intro: "SHE HAS LEFT 412 ONE-STAR REVIEWS. ONE WAS FOR A SUNSET.",
    taunts: ["I'M WRITING THIS DOWN!", "MY COUSIN IS A LAWYER! ONLINE!", "THIS IS A HATE CRIME AGAINST MAYO!", "I WANT IT FREE. AND FASTER."],
    koLine: "...FIVE STARS. FIVE. DON'T TELL ANYONE.",
  },
  {
    id: "hank",
    name: "HANGRY HANK",
    title: "THE OVER-THE-COUNTER CHOKER",
    hangry: 180,
    speed: 0.85,
    grip: 18,
    attacks: [
      { kind: "choke", weight: 5 },
      { kind: "double", weight: 2 },
      { kind: "slap", weight: 2 },
    ],
    throws: "review",
    colors: { skin: "#d89060", hair: "#3a2010", shirt: "#b02818", accent: "#202848" },
    intro: "HASN'T EATEN SINCE TUESDAY. CLEARS THE SNEEZE GUARD IN A SINGLE BOUND.",
    taunts: ["WHERE'S MY ITALIAN!", "I SAID LIGHT MAYO!", "I'VE BEEN WAITING 45 SECONDS!", "I CAN SEE THE SUB! I CAN SEE IT!"],
    koLine: "...I WAS JUST HANGRY. SORRY ABOUT YOUR COLLAR.",
  },
];

/** The manager, from the walk-in cooler, between customers. */
export const CORNER_TIPS = [
  "WHEN THEY LEAN OVER THE COUNTER, DUCK. THE SNEEZE GUARD DOES THE REST.",
  "THE SNEEZE GUARD HAS NEVER STOPPED A SNEEZE. IT HAS STOPPED SIX GUYS.",
  "A HANGRY CUSTOMER IS JUST A HAPPY CUSTOMER WITHOUT A SUB IN THEIR FACE.",
  "IF THEY GRAB YOUR COLLAR, HIT THE BELL. NOBODY KNOWS WHY. IT WORKS.",
  "THE CUSTOMER IS ALWAYS RIGHT. DUCK ANYWAY.",
  "WORKERS COMP DOES NOT COVER HE WANTED LIGHT MAYO.",
  "TOSS THE SAMPLE PICKLE. THEY ALWAYS CATCH IT WITH THEIR MOUTH.",
  "TIPS ARE OPTIONAL. DUCKING IS NOT.",
  "SAVE YOUR TIP STARS. NOTHING ENDS AN ARGUMENT LIKE A WHOLE JUMBO.",
  "I'D HELP, BUT I'M COUNTING THE PROVOLONE.",
];

export const GRAB_LINES = [
  "HE'S GOT YOUR COLLAR!",
  "IS THIS ABOUT THE MAYO?!",
  "SIR, THIS IS A DELI!",
  "I'M ON BREAK IN 5 MINUTES!",
  "NOT THE APRON! IT'S NEW!",
  "CAN I INTEREST YOU IN A COMBO?!",
];

export const ESCAPE_LINES = ["ORDER UP!", "DING DING! BACK OFF!", "BELL SAYS NO!", "NEXT IN LINE!"];
export const DUCK_LINES = ["STUCK ON THE SNEEZE GUARD!", "FACE MEETS GLASS!", "WINDEX TIME!", "THAT'S WHAT IT'S FOR!"];
export const SCREAMS = ["MANAGER!!!", "CORPORATE!!!", "I'LL CALL THE NEWS!!!"];
export const COUNT_WORDS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"];
