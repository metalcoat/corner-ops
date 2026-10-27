/**
 * Direction (degrees from north) and speed (mph) of a driver's latest position for the dispatch map: what the
 * phone reported, else worked out from the previous point (owner request 2026-10-27, "like Glympse").
 */
export function driverMotion(row: Record<string, unknown>): { driver_heading: number | null; driver_speed_mph: number | null } {
  const reportedHeading = row.driver_reported_heading == null ? NaN : Number(row.driver_reported_heading);
  const reportedSpeed = row.driver_reported_speed == null ? NaN : Number(row.driver_reported_speed);
  let heading: number | null = Number.isFinite(reportedHeading) ? reportedHeading : null;
  let mph: number | null = Number.isFinite(reportedSpeed) ? reportedSpeed * 2.23694 : null;
  const lat = Number(row.driver_latitude), lng = Number(row.driver_longitude);
  const prevLat = Number(row.driver_previous_latitude), prevLng = Number(row.driver_previous_longitude);
  if ((heading == null || mph == null) && row.driver_previous_latitude != null && [lat, lng, prevLat, prevLng].every(Number.isFinite)) {
    const toRad = (value: number) => (value * Math.PI) / 180;
    const dLat = toRad(lat - prevLat), dLng = toRad(lng - prevLng);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(prevLat)) * Math.cos(toRad(lat)) * Math.sin(dLng / 2) ** 2;
    const metres = 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    const seconds = (new Date(String(row.driver_location_captured_at)).getTime() - new Date(String(row.driver_previous_captured_at)).getTime()) / 1000;
    if (heading == null && metres > 15) {
      const y = Math.sin(dLng) * Math.cos(toRad(lat));
      const x = Math.cos(toRad(prevLat)) * Math.sin(toRad(lat)) - Math.sin(toRad(prevLat)) * Math.cos(toRad(lat)) * Math.cos(dLng);
      heading = ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
    }
    if (mph == null && seconds > 0) mph = (metres / seconds) * 2.23694;
  }
  // A parked phone drifts: no arrow or speed under ~2 mph.
  if (mph != null && mph < 2) { mph = 0; heading = null; }
  return { driver_heading: heading == null ? null : Math.round(heading), driver_speed_mph: mph == null ? null : Math.round(mph) };
}
