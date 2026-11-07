/**
 * Corner Deli's opening hours for the TV greeter's "Our hours" slide (tools/greeter-pi).
 * One entry per day, Sunday first (the way the deli writes its hours); null = closed.
 * 24-hour "HH:MM" times, store time.
 * Leave GREETER_HOURS empty to keep the slide out of the rotation.
 */
export type DayHours = { opens: string; closes: string } | null;

export const GREETER_HOURS: DayHours[] = [
  { opens: "10:30", closes: "21:30" }, // Sunday
  { opens: "10:30", closes: "21:30" }, // Monday
  { opens: "10:30", closes: "21:30" }, // Tuesday
  { opens: "10:30", closes: "21:30" }, // Wednesday
  { opens: "10:30", closes: "21:30" }, // Thursday
  { opens: "10:30", closes: "22:30" }, // Friday
  { opens: "10:30", closes: "22:30" }, // Saturday
];
export const GREETER_HOURS_NOTE = "Order ahead anytime at ordercornerdeli.com";

export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** "07:00" → "7 AM", "19:30" → "7:30 PM". */
export function clockLabel(value: string): string {
  const [h, m] = value.split(":").map(Number);
  const suffix = h >= 12 ? "PM" : "AM";
  const hour = h % 12 || 12;
  return m ? `${hour}:${String(m).padStart(2, "0")} ${suffix}` : `${hour} ${suffix}`;
}

/** Rows for the slide, merging neighbouring days with the same hours ("Monday – Friday"). */
export function hoursRows(hours: readonly DayHours[]): { days: string; time: string; dayIndexes: number[] }[] {
  const rows: { days: string; time: string; dayIndexes: number[] }[] = [];
  hours.forEach((day, index) => {
    const time = day ? `${clockLabel(day.opens)} – ${clockLabel(day.closes)}` : "Closed";
    const last = rows[rows.length - 1];
    if (last && last.time === time) last.dayIndexes.push(index);
    else rows.push({ days: "", time, dayIndexes: [index] });
  });
  for (const row of rows) {
    const first = WEEKDAYS[row.dayIndexes[0]], end = WEEKDAYS[row.dayIndexes[row.dayIndexes.length - 1]];
    row.days = row.dayIndexes.length === 1 ? first : `${first} – ${end}`;
  }
  return rows;
}
