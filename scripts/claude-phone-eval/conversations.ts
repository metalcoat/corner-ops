// Scripted phone conversations for the Claude text eval. Caller lines are the meaning of real dev Gemini
// calls (geminiCallId, read live from ordering_call_transcript_segments) with the speech-to-text noise
// removed, plus a few made-up calls for cases the logged calls don't cover. A line is sent in order unless
// the assistant's last words match one of the `answers` rules first (so a follow-up question the script
// didn't expect still gets a sensible reply instead of the next scripted line).

export type LineMatcher = {
  item: RegExp;
  variant?: RegExp;
  quantity?: number;
  has?: RegExp[];
  not?: RegExp[];
};

export type Conversation = {
  key: string;
  covers: string;
  caller: "returning" | "new";
  lines: string[];
  answers?: Array<{ when: RegExp; say: string }>;
  expect: {
    lines: LineMatcher[];
    // Wings may be one line per sauce or one line with two sauces; total wings per sauce is what counts.
    wings?: Record<string, number>;
    service?: "pickup" | "delivery";
    address?: RegExp;
    outcome: "payment" | "handoff" | "complete" | "payment_or_complete";
    tipCents?: number;
  };
  // A logged Gemini call whose caller asked for the same order, graded with the same expectations.
  geminiCallId?: string;
};

const wings = /^wings$/i;
const pizza = /pizza/i;
const bigBoss = /turkey big boss/i;
const largeFries = /large french fries/i;

export const conversations: Conversation[] = [
  {
    key: "two-jumbo-pepperoni",
    covers: "baseline returning-customer delivery, card + tip",
    caller: "returning",
    geminiCallId: "ff9e1d2b-8a46-41ba-bcfc-a580cf17dea8",
    lines: ["Delivery.", "Yes.", "Yes.", "Can I get two jumbo pepperoni pizzas?", "No, that's it.", "Yes.", "Card.", "Yeah, $3."],
    expect: {
      lines: [{ item: pizza, quantity: 2, has: [/pepperoni/i] }],
      service: "delivery",
      outcome: "payment",
      tipCents: 300,
    },
  },
  {
    key: "bigboss-no-tomato-wings-split",
    covers: "Big Boss omission, half-topping pizza, 30 wings split 10 hot / 20 medium, readback correction",
    caller: "returning",
    geminiCallId: "27fc630a-b103-4082-8cc0-ed0177695be1",
    lines: [
      "Delivery.",
      "Yep.",
      "Yep.",
      "Can I get a Turkey Big Boss with no tomato?",
      "And a large pepperoni pizza with half onions.",
      "And 30 wings total, 10 hot and 20 medium, extra crispy.",
      "Blue cheese.",
      "Can I get the caramel cheesecake?",
      "No, that's it.",
      "Yes.",
      "Card.",
      "$3.",
    ],
    answers: [{ when: /which (one|sauce)|what (sauce|flavor)/i, say: "10 hot and 20 medium." }],
    expect: {
      lines: [
        { item: bigBoss, has: [/no tomato/i] },
        { item: pizza, has: [/pepperoni/i, /onion/i] },
        { item: /cheesecake/i },
      ],
      wings: { Hot: 10, Medium: 20 },
      service: "delivery",
      outcome: "payment",
      tipCents: 300,
    },
  },
  {
    key: "bbq-wings-split",
    covers: "30 wings split 15 BBQ / 15 medium (Gemini rejected BBQ)",
    caller: "returning",
    geminiCallId: "af3c7c7f-fbce-4100-b478-0ee861779a01",
    lines: [
      "Delivery.",
      "Yes.",
      "Yep.",
      "A jumbo pepperoni pizza, half onions.",
      "And 30 wings, can I get 15 of those barbecue and 15 medium?",
      "Ranch.",
      "That's all.",
      "Yes.",
      "Card.",
      "$3.",
    ],
    answers: [{ when: /open pit|sweet (and|&) sassy|which (bbq|barbecue)/i, say: "Just the regular BBQ." }],
    expect: {
      lines: [{ item: pizza, has: [/pepperoni/i, /onion/i] }],
      wings: { BBQ: 15, Medium: 15 },
      service: "delivery",
      outcome: "payment",
      tipCents: 300,
    },
  },
  {
    key: "bigboss-fries-tender-dinner",
    covers: "Big Boss no tomato, plain large fry, chicken tender dinner with BBQ + coleslaw (Gemini rejected BBQ)",
    caller: "returning",
    geminiCallId: "383d8c28-c91a-45b2-96fa-0541ee95b878",
    lines: [
      "Delivery.",
      "Yep.",
      "Yes.",
      "I'll get the turkey big boss sub with no tomato.",
      "Make it a large order of fries.",
      "Can I get a chicken tender dinner?",
      "BBQ sauce, and yeah, some coleslaw.",
      "Small fry.",
      "No, that's it.",
      "Yep.",
      "Card.",
      "Yeah, $3.",
    ],
    answers: [
      { when: /gravy or nacho/i, say: "No, just plain." },
      { when: /which (bbq|barbecue)|open pit|sweet (and|&) sassy/i, say: "Regular BBQ." },
      { when: /fries|side/i, say: "Small fry." },
    ],
    expect: {
      lines: [
        { item: bigBoss, has: [/no tomato/i] },
        { item: largeFries, not: [/gravy|nacho|poutine|loaded/i] },
        { item: /chicken tender dinner/i, has: [/coleslaw/i, /bbq/i] },
      ],
      service: "delivery",
      outcome: "payment",
      tipCents: 300,
    },
  },
  {
    key: "fries-nachos-bbq-wings",
    covers: "BBQ variant choice (Open Pit), large fry with nacho cheese (side by default)",
    caller: "returning",
    geminiCallId: "3a17f287-1bd0-49b2-8d10-b400ab21b6b5",
    lines: [
      "Delivery.",
      "Yes.",
      "Yes.",
      "Can I get a jumbo pepperoni, half onion?",
      "Yeah, can I get 10 wings, barbecue, and a side of blue cheese?",
      "Open Pit.",
      "And a large fry with that.",
      "Gimme nacho cheese.",
      "That's it.",
      "Yep.",
      "Card.",
      "$5.",
    ],
    expect: {
      lines: [
        { item: pizza, has: [/pepperoni/i, /onion/i] },
        { item: largeFries, has: [/nacho cheese on side/i] },
      ],
      wings: { "Open Pit BBQ": 10 },
      service: "delivery",
      outcome: "payment",
      tipCents: 500,
    },
  },
  {
    key: "half-jalapeno-quesadilla",
    covers: "one pizza half jalapenos (Gemini made two pizzas), quesadilla salsa on side, fry nacho, ranch cup",
    caller: "returning",
    geminiCallId: "27410b10-c3da-4665-9091-b934c2f317a3",
    lines: [
      "Delivery.",
      "Yep.",
      "Yes.",
      "A large pepperoni pizza, half jalapenos.",
      "And a chicken quesadilla with salsa on the side, a large fry with nacho cheese, and a ranch.",
      "Nope.",
      "Yes.",
      "Card.",
      "$5.",
    ],
    expect: {
      lines: [
        { item: pizza, quantity: 1, has: [/pepperoni/i, /jalapen/i] },
        { item: /chicken quesadilla/i, has: [/salsa on side/i] },
        { item: largeFries, has: [/nacho/i] },
        { item: /ranch/i },
      ],
      service: "delivery",
      outcome: "payment",
      tipCents: 500,
    },
  },
  {
    key: "poutine-burger-bigboss",
    covers: "five-item order: poutine, Wild West Burger, half-mushroom pizza, 2L Pepsi, Big Boss",
    caller: "returning",
    geminiCallId: "4b3d92cb-cf06-4fe2-83d2-c0004077dea3",
    lines: [
      "Delivery.",
      "Yep.",
      "Yes.",
      "Can I get a large poutine?",
      "And a Wild West Burger.",
      "Can I get a large pizza, all pepperoni, half mushrooms?",
      "Can I get a two liter Pepsi?",
      "And a Turkey Big Boss.",
      "That's it.",
      "Yes.",
      "Card.",
      "$10.",
    ],
    answers: [{ when: /cheese/i, say: "American is fine." }],
    expect: {
      lines: [
        { item: largeFries, has: [/poutine/i] },
        { item: /wild west burger/i },
        { item: pizza, has: [/pepperoni/i, /mushroom/i] },
        { item: /pepsi/i },
        { item: bigBoss },
      ],
      service: "delivery",
      outcome: "payment",
      tipCents: 1000,
    },
  },
  {
    key: "wings-medium-two-dressings",
    covers: "20 medium wings with blue cheese and ranch",
    caller: "returning",
    geminiCallId: "a18bfba9-2fd0-4098-985a-6c9b335c9811",
    lines: [
      "Delivery.",
      "Yep.",
      "Yep.",
      "I need a jumbo pepperoni pizza.",
      "Can I get 20 wings medium with a side of blue cheese?",
      "Blue cheese and ranch.",
      "Nothing else.",
      "Yep.",
      "Card.",
      "Yeah, $3.",
    ],
    expect: {
      lines: [{ item: pizza, has: [/pepperoni/i] }],
      wings: { Medium: 20 },
      service: "delivery",
      outcome: "payment",
      tipCents: 300,
    },
  },
  {
    key: "correction-make-it-20",
    covers: "new caller pickup, mid-order correction: 10 hot wings -> 20 medium",
    caller: "new",
    lines: [
      "Pickup.",
      "Mike Thompson.",
      "Can I get 10 wings, hot?",
      "Ranch.",
      "Actually, make it 20, and make them medium instead of hot.",
      "That's it.",
      "Yes.",
      "Cash.",
    ],
    expect: {
      lines: [],
      wings: { Medium: 20 },
      service: "pickup",
      outcome: "complete",
    },
  },
  {
    key: "delivery-new-address",
    covers: "new caller delivery, address given aloud, gravy on top of fries",
    caller: "new",
    lines: [
      "Delivery.",
      "Sarah Miller.",
      "315 Ford Street in Ogdensburg.",
      "Two cheeseburgers and a large fries with gravy on top.",
      "That's all.",
      "Yes.",
      "Cash.",
    ],
    answers: [
      { when: /what kind of cheese|which cheese|american|provolone/i, say: "American." },
      { when: /toppings|lettuce|tomato|anything on/i, say: "Just plain is fine." },
      { when: /unit|apartment/i, say: "No, it's a house." },
    ],
    expect: {
      lines: [
        { item: /cheeseburger/i, quantity: 2 },
        { item: largeFries, has: [/gravy on fries/i] },
      ],
      service: "delivery",
      address: /315 ford/i,
      outcome: "complete",
    },
  },
  {
    key: "bigboss-two-omissions",
    covers: "two Turkey Big Boss lines with different omissions",
    caller: "returning",
    lines: [
      "Pickup.",
      "Yes.",
      "Two Turkey Big Bosses, one with no tomato and one with no Russian.",
      "That's it.",
      "Yes.",
      "Card.",
      "No tip, thanks.",
    ],
    expect: {
      lines: [
        { item: bigBoss, quantity: 1, has: [/no tomato/i], not: [/no russian/i] },
        { item: bigBoss, quantity: 1, has: [/no russian/i], not: [/no tomato/i] },
      ],
      service: "pickup",
      outcome: "payment_or_complete",
    },
  },
  {
    key: "transfer-request",
    covers: "caller asks for a person",
    caller: "returning",
    lines: ["Pickup.", "Yes.", "Can I talk to someone at the store? I have a question about a catering order."],
    expect: { lines: [], outcome: "handoff" },
  },
];
