import { ensureSchema, getSql } from "@/lib/db";

type LocationInput = {
  latitude?: number | null;
  longitude?: number | null;
  accuracy?: number | null;
};

type EmployeeRow = {
  id: string;
  name: string;
  position: string;
  role_group: "Driver" | "In-House" | "Ignore";
};

type OpenEntryRow = {
  id: string;
  clock_in: string;
  status: string;
};

function finite(value: unknown): number | null {
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

function locationReview(location: LocationInput) {
  const latitude = finite(location.latitude);
  const longitude = finite(location.longitude);
  const accuracy = finite(location.accuracy);
  const siteLatitude = finite(process.env.TIMECLOCK_LATITUDE);
  const siteLongitude = finite(process.env.TIMECLOCK_LONGITUDE);
  const radius = Math.max(10, finite(process.env.TIMECLOCK_RADIUS_METERS) || 150);

  if (latitude === null || longitude === null) {
    return { latitude, longitude, accuracy, needsReview: true, reason: "Location was not supplied." };
  }
  if (siteLatitude === null || siteLongitude === null) {
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

export async function punchAuthenticatedTikiEmployee(employeeId: string, location: LocationInput) {
  await ensureSchema();
  const employeeRows = await getSql()`
    SELECT id, name, position, role_group
    FROM employees
    WHERE id = ${employeeId}::uuid AND business = 'Tiki' AND active = TRUE
    LIMIT 1
  ` as unknown as EmployeeRow[];
  const employee = employeeRows[0];
  if (!employee) throw new Error("Active Tiki employee session required.");

  const locationCheck = locationReview(location);
  const openRows = await getSql()`
    SELECT id, clock_in, status
    FROM time_entries
    WHERE employee_id = ${employee.id}::uuid AND clock_out IS NULL
    ORDER BY clock_in DESC
    LIMIT 1
  ` as unknown as OpenEntryRow[];

  if (openRows[0]) {
    const existing = openRows[0];
    const result = await getSql()`
      UPDATE time_entries SET
        clock_out = NOW(),
        clock_out_lat = ${locationCheck.latitude},
        clock_out_lng = ${locationCheck.longitude},
        clock_out_accuracy = ${locationCheck.accuracy},
        status = CASE
          WHEN ${existing.status} = 'Needs Review'
            OR ${locationCheck.needsReview}
            OR NOW() - clock_in > INTERVAL '16 hours'
          THEN 'Needs Review'
          ELSE 'Complete'
        END,
        notes = CASE
          WHEN ${locationCheck.reason} <> ''
          THEN CONCAT_WS(' ', NULLIF(notes, ''), ${locationCheck.reason})
          ELSE notes
        END,
        updated_at = NOW()
      WHERE id = ${existing.id}::uuid
      RETURNING id, clock_in, clock_out, status
    ` as unknown as Array<{ id: string; clock_in: string; clock_out: string; status: string }>;
    return {
      action: "clocked-out" as const,
      employee: employee.name,
      entry: result[0],
      locationReview: locationCheck.needsReview ? locationCheck.reason : null,
    };
  }

  const id = crypto.randomUUID();
  const result = await getSql()`
    INSERT INTO time_entries (
      id, business, employee_id, employee_name, position, role_group,
      clock_in, clock_in_lat, clock_in_lng, clock_in_accuracy, status, notes
    ) VALUES (
      ${id}, 'Tiki', ${employee.id}::uuid, ${employee.name}, ${employee.position}, ${employee.role_group},
      NOW(), ${locationCheck.latitude}, ${locationCheck.longitude}, ${locationCheck.accuracy},
      ${locationCheck.needsReview ? "Needs Review" : "Open"}, ${locationCheck.reason}
    )
    RETURNING id, clock_in, clock_out, status
  ` as unknown as Array<{ id: string; clock_in: string; clock_out: string | null; status: string }>;

  return {
    action: "clocked-in" as const,
    employee: employee.name,
    entry: result[0],
    locationReview: locationCheck.needsReview ? locationCheck.reason : null,
  };
}
