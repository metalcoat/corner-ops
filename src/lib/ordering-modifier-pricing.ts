// A modifier group's charge-once fee (Burger "Deluxe": lettuce, tomato, onion, any or all +$0.25,
// Chris 2026-11-06): charged once when anything in the group is picked, however many. Shared by the server
// price check, the POS, the online order page and the AI phone so every screen, ticket and total agrees.
// It rides on the first selected option in menu order (on the order snapshot too), so receipts, refunds
// and totals that add up option prices stay right.
export function groupSelectionChargeCents(selectionChargeCents: number | undefined, selectedCount: number): number {
  return selectedCount > 0 ? Math.max(0, selectionChargeCents || 0) : 0;
}
