export type LocationInput = { latitude?: number | null; longitude?: number | null; accuracy?: number | null };

function finite(value: unknown): number | null {
  if (value === null || value === undefined || (typeof value === "string" && !value.trim())) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function radians(value: number): number {
  return value * Math.PI / 180;
}

function distanceMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const earthRadius = 6_371_000;
  const deltaLat = radians(lat2 - lat1);
  const deltaLng = radians(lng2 - lng1);
  const a = Math.sin(deltaLat / 2) ** 2
    + Math.cos(radians(lat1)) * Math.cos(radians(lat2)) * Math.sin(deltaLng / 2) ** 2;
  return 2 * earthRadius * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function locationReview(location: LocationInput) {
  const rawLatitude = finite(location.latitude);
  const latitude = rawLatitude !== null && Math.abs(rawLatitude) <= 90 ? rawLatitude : null;
  const rawLongitude = finite(location.longitude);
  const longitude = rawLongitude !== null && Math.abs(rawLongitude) <= 180 ? rawLongitude : null;
  const rawAccuracy = finite(location.accuracy);
  const accuracy = rawAccuracy !== null && rawAccuracy >= 0 && rawAccuracy <= 99999999 ? rawAccuracy : null;
  const siteLatitude = finite(process.env.TIMECLOCK_LATITUDE);
  const siteLongitude = finite(process.env.TIMECLOCK_LONGITUDE);
  const radius = Math.max(10, finite(process.env.TIMECLOCK_RADIUS_METERS) || 150);

  if (latitude === null || longitude === null) {
    return { latitude, longitude, accuracy, needsReview: true, reason: "Location was not supplied." };
  }
  if (siteLatitude === null || siteLongitude === null || Math.abs(siteLatitude) > 90 || Math.abs(siteLongitude) > 180) {
    return { latitude, longitude, accuracy, needsReview: true, reason: "Time-clock geofence is not configured." };
  }

  const distance = distanceMeters(siteLatitude, siteLongitude, latitude, longitude);
  const uncertainty = Math.max(0, accuracy || 0);
  const outside = Math.max(0, distance - uncertainty) > radius;
  const imprecise = uncertainty > Math.max(radius * 2, 250);
  return {
    latitude,
    longitude,
    accuracy,
    needsReview: outside || imprecise,
    reason: outside
      ? `Punch location was approximately ${Math.round(distance)} m from the configured site.`
      : imprecise
        ? `Punch location accuracy was only ${Math.round(uncertainty)} m.`
        : "",
  };
}
