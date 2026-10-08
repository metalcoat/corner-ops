const zone = "America/New_York";
const formatter = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "shortOffset", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

function parts(timestamp: number) {
  return Object.fromEntries(formatter.formatToParts(new Date(timestamp)).map((part) => [part.type, part.value]));
}

/** Interpret a datetime-local field as Corner Deli wall time, regardless of the manager's device zone. */
export function storeLocalTimeToIso(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new Error("Choose a valid Eastern time.");
  const [year, month, day, hour, minute] = match.slice(1).map(Number);
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  if (new Date(wall).toISOString().slice(0, 16) !== value) throw new Error("Choose a valid Eastern time.");
  const candidates = new Set<number>();
  for (const probe of [wall - 86_400_000, wall, wall + 86_400_000]) {
    const offset = parts(probe).timeZoneName?.match(/^GMT([+-])(\d{1,2})(?::(\d{2}))?$/);
    if (!offset) throw new Error("Eastern time is unavailable on this device.");
    const minutes = (offset[1] === "+" ? 1 : -1) * (Number(offset[2]) * 60 + Number(offset[3] || 0));
    const candidate = wall - minutes * 60_000;
    const rendered = parts(candidate);
    if (`${rendered.year}-${rendered.month}-${rendered.day}T${rendered.hour}:${rendered.minute}` === value) candidates.add(candidate);
  }
  if (candidates.size !== 1) throw new Error("That Eastern time is skipped or repeated by daylight saving time. Choose another time.");
  return new Date([...candidates][0]).toISOString();
}
