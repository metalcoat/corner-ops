export type DeliveryLocationPreset = { id: string; name: string; address: string; aliases: readonly string[]; dropoffs: readonly string[] };

export const DELIVERY_LOCATION_PRESETS: readonly DeliveryLocationPreset[] = [
  { id: "ogdensburg-bowl", name: "Ogdensburg Bowl", address: "1121 Paterson Street, Ogdensburg, NY 13669", aliases: ["ogdensburg bowl", "bowling alley", "1121 paterson", "1121 patterson"], dropoffs: [...Array.from({ length: 14 }, (_, index) => `Lane ${index + 1}`), "Bar"] },
  { id: "claxton-hepburn", name: "Claxton-Hepburn Medical Center", address: "214 King Street, Ogdensburg, NY 13669", aliases: ["claxton", "claxton hepburn", "hospital", "214 king"], dropoffs: ["ICU", "ER", "Front Desk"] },
  { id: "ansen", name: "Ansen Corporation", address: "100 Chimney Point Drive, Ogdensburg, NY 13669", aliases: ["ansen", "new ansen", "old ansen", "100 chimney point"], dropoffs: ["New Ansen", "Old Ansen"] },
  { id: "state-hospital", name: "State Hospital (Psych Center)", address: "1 Chimney Point Drive, Ogdensburg, NY 13669", aliases: ["state hospital", "psych center", "psychiatric center", "st lawrence psychiatric center", "saint lawrence psychiatric center", "1 chimney point"], dropoffs: [] },
] as const;

export function deliveryPresetSuggestions(input: string) {
  const query=input.toLowerCase().replace(/[^a-z0-9]+/g," ").trim();
  if(query.length<2)return [];
  return DELIVERY_LOCATION_PRESETS.filter(location=>[location.name,location.address,...location.aliases].some(value=>value.toLowerCase().replace(/[^a-z0-9]+/g," ").includes(query))).map(location=>({id:`preset:${location.id}`,text:location.address,mainText:location.name,secondaryText:`${location.address} · Choose drop-off location`,provider:"preset" as const,deliveryLocationId:location.id}));
}
