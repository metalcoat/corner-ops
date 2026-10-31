/**
 * Apartment complexes where the street address isn't enough to find the door. Belmont Courts
 * (Ogdensburg Housing Authority, between Jay St, Plover Hill Ave, Lafayette St and Park St) has 17
 * buildings in four courts; unit 153 is in the building for 151–158 in Court 100 (owner's site map).
 */
import belmont from "./route-map/belmont-courts.json";

export type ComplexBuilding = { complex: string; label: string; latitude: number; longitude: number };

function inBox(latitude: unknown, longitude: unknown) {
  const lat = Number(latitude), lng = Number(longitude), [south, west, north, east] = belmont.box;
  return Number.isFinite(lat) && Number.isFinite(lng) && lat >= south && lat <= north && lng >= west && lng <= east;
}

/** The unit number: anything 3-digit in the unit line, else "Apt/Unit/#/No 153" or "Belmont Courts 153" in the address. */
export function unitNumber(address: string, unit: string): number | null {
  const fromUnit = /\b(\d{3})\b/.exec(unit);
  if (fromUnit) return Number(fromUnit[1]);
  const fromAddress = /(?:\b(?:apt|apartment|unit|no)\.?\s*|#\s*|belmont\s+c(?:our)?ts?\.?,?\s+)(\d{3})\b/i.exec(address);
  return fromAddress ? Number(fromAddress[1]) : null;
}

/** Which building a delivery goes to, when its address is in a mapped complex and has a unit number. */
export function complexBuilding(input: { address?: unknown; unit?: unknown; latitude?: unknown; longitude?: unknown }): ComplexBuilding | null {
  const address = String(input.address ?? ""), unit = String(input.unit ?? "");
  if (!/belmont/i.test(`${address} ${unit}`) && !inBox(input.latitude, input.longitude)) return null;
  const number = unitNumber(address, unit);
  if (number == null) return null;
  const building = belmont.buildings.find((candidate) => number >= candidate.units[0] && number <= candidate.units[1]);
  if (!building) return null;
  return { complex: belmont.name, label: `Bldg ${building.units[0]}–${building.units[1]} · Court ${building.court}`, latitude: building.lat, longitude: building.lng };
}
