const SUB_INTENSITY_OPTIONS = new Set([
  "mayonnaise",
  "mayo",
  "russian",
  "oil",
  "lettuce",
  "tomato",
  "tomatoes",
  "onion",
  "onions",
  "hot peppers",
  "mustard",
  "pickles",
]);

export type ModifierIntensity = "light" | "normal" | "heavy";

export function supportsSubModifierIntensity(
  groupSupportsIntensity: boolean,
  optionName: string,
): boolean {
  return (
    groupSupportsIntensity &&
    SUB_INTENSITY_OPTIONS.has(optionName.trim().toLowerCase())
  );
}

export function formatModifierIntensity(
  name: string,
  amount: ModifierIntensity,
): string {
  return amount === "normal"
    ? name
    : `${name} - ${amount === "light" ? "Light" : "Heavy"}`;
}
