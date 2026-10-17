/**
 * Loyalty earning is incremental per (program, order): each submit earns only
 * the qualifying units not yet earned for that order, so add-ons sent after
 * the first submit still earn, while a retried submit earns nothing twice.
 *
 * `earnedThroughUnits` is the cumulative earned total after the new entry. It
 * is part of a unique index, so two concurrent submits computing the same
 * increment collide and only one entry is kept.
 */
export function loyaltyEarnIncrement(qualifyingUnits: number, alreadyEarnedUnits: number) {
  const qualifying = Math.max(0, Math.floor(Number(qualifyingUnits) || 0));
  const earned = Math.max(0, Math.floor(Number(alreadyEarnedUnits) || 0));
  const delta = Math.max(0, qualifying - earned);
  return { delta, earnedThroughUnits: earned + delta };
}
