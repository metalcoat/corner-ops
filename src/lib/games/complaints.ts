// Shared Corner Deli customer complaints for every arcade game. The joke is
// that doing everything right still gets you a complaint (and sometimes a
// penalty), so these are written for orders that went perfectly.

export const PERFECT_ORDER_COMPLAINTS = [
  "Customer got diarrhea and blamed the sub. The cook saw him at The Bowl last night doing tequila shots until close.",
  "Customer called to say nothing was wrong. Still called us idiots. Hung up before we could say thank you.",
  "Customer says the food arrived too fast and they 'weren't emotionally ready for dinner.'",
  "Customer wanted the sub pre-chewed. The online notes only said EXTRA ONIONS.",
  "Customer found a hair in their food. The cook is bald. The driver is bald. The customer is missing a chunk of hair from the back of their head.",
  "Customer says the sub was 'too correct' and wants us to 'surprise them a little' next time.",
  "Customer received exactly what they ordered and demands to know who told us.",
  "Customer wants a refund because the sub was better than their mother's. Their mother agrees.",
  "Customer says the bag was too easy to open and they felt 'unchallenged as a person.'",
  "Customer complained the sub was cut on a diagonal 'at a political angle.'",
  "Customer says the food was hot, which 'burned the roof of their mouth that they already burned on coffee.'",
  "Customer is upset the driver was polite. 'Nobody is that nice in Ogdensburg. What's he hiding.'",
  "Customer ate the whole thing, then called to ask if it was supposed to be that good, then called back to complain about the first call.",
  "Customer says the pickle 'made eye contact.' Requests a pickle that minds its business.",
  "Customer is mad the order was right because they had already written the complaint and now it's 'wasted.'",
  "Customer said the delivery was so on time it 'made their microwave look bad.'",
  "Customer wanted the sub delivered 'warm but not hot, cold but not cold, and on the porch but also inside.'",
  "Customer complained the receipt was 'too long to read and too short to frame.'",
  "Customer says the driver's car was 'too clean' and it made them feel bad about their car.",
  "Customer left a 1-star review that says 'Perfect. Never doing this again. Too stressful.'",
  "Customer called to report the sandwich 'tasted like a sandwich.' Expected 'an experience.'",
  "Customer says we forgot the napkins. The napkins are in their hand. They are using them to dial.",
  "Customer demands to speak to the manager of the pickles.",
  "Customer says the food arrived before they ordered it and wants to know how. Honestly, so do we.",
] as const;

/** Short punchlines for in-game pop-ups when a perfect play gets penalised. */
export const PERFECT_PENALTY_LINES = [
  "COMPLAINT: TOO FAST",
  "COMPLAINT: TOO CORRECT",
  "COMPLAINT: NOT PRE-CHEWED",
  "COMPLAINT: CALLED US IDIOTS ANYWAY",
  "COMPLAINT: HAIR (COOK IS BALD)",
  "COMPLAINT: PICKLE MADE EYE CONTACT",
  "COMPLAINT: NOTHING WRONG. STILL MAD.",
  "COMPLAINT: TEQUILA, NOT THE SUB",
] as const;

const recent: string[] = [];
/** A random complaint, avoiding the last few so they don't repeat back to back. */
export function randomComplaint(pool: readonly string[] = PERFECT_ORDER_COMPLAINTS) {
  const fresh = pool.filter((line) => !recent.includes(line));
  const line = (fresh.length ? fresh : pool)[Math.floor(Math.random() * (fresh.length ? fresh.length : pool.length))];
  recent.push(line);
  if (recent.length > 6) recent.shift();
  return line;
}

/**
 * Doing everything perfectly can still cost you: returns a penalty (points to
 * subtract) and the reason, or null when the customer is, for once, satisfied.
 */
export function perfectionPenalty(chance = 0.18, points = 100) {
  if (Math.random() >= chance) return null;
  return {
    points,
    line: PERFECT_PENALTY_LINES[Math.floor(Math.random() * PERFECT_PENALTY_LINES.length)],
    complaint: randomComplaint(),
  };
}
