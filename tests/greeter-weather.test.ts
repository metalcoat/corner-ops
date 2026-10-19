import assert from "node:assert/strict";
import test from "node:test";
import { summarizeForecast, type NwsPeriod } from "../src/lib/greeter-weather-format";

const period = (name: string, start: string, isDaytime: boolean, temperature: number, shortForecast: string, pop: number | null = 0): NwsPeriod => ({
  name, startTime: start, isDaytime, temperature, temperatureUnit: "F", shortForecast, probabilityOfPrecipitation: { value: pop },
});

const week = [
  period("Today", "2026-10-19T11:00:00-04:00", true, 62, "Sunny"),
  period("Tonight", "2026-10-19T18:00:00-04:00", false, 40, "Patchy Fog", 10),
  period("Tuesday", "2026-10-20T06:00:00-04:00", true, 56, "Sunny"),
  period("Tuesday Night", "2026-10-20T18:00:00-04:00", false, 34, "Mostly Clear"),
  period("Wednesday", "2026-10-21T06:00:00-04:00", true, 51, "Chance Rain Showers", 40),
  period("Wednesday Night", "2026-10-21T18:00:00-04:00", false, 38, "Rain Showers", 70),
  period("Thursday", "2026-10-22T06:00:00-04:00", true, 49, "Cloudy", 20),
  period("Thursday Night", "2026-10-22T18:00:00-04:00", false, 33, "Cloudy"),
];

test("weather slide: now, today's high/low and the next three days", () => {
  const slide = summarizeForecast(week, { textDescription: "Clear", temperature: { value: 16, unitCode: "wmoUnit:degC" } }, "2026-10-19T15:30:00Z");
  assert.deepEqual(slide.now, { temperature: 61, conditions: "Clear" });
  assert.deepEqual(slide.today, { name: "Today", high: 62, low: 40, forecast: "Sunny", rainChance: 10 });
  assert.deepEqual(slide.next.map((d) => [d.name, d.high, d.low, d.forecast, d.rainChance]), [
    ["Tuesday", 56, 34, "Sunny", 0],
    ["Wednesday", 51, 38, "Chance Rain Showers", 70],
    ["Thursday", 49, 33, "Cloudy", 20],
  ]);
});

test("weather slide: in the evening today has only tonight's low; no observation falls back to the forecast", () => {
  const slide = summarizeForecast(week.slice(1), null, "2026-10-19T23:00:00Z");
  assert.deepEqual(slide.now, { temperature: 40, conditions: "Patchy Fog" });
  assert.equal(slide.today.high, null);
  assert.equal(slide.today.low, 40);
  assert.equal(slide.next[0].name, "Tuesday");
});
