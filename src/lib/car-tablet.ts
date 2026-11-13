import { createHash, randomBytes, randomUUID } from "node:crypto";
import { getSql, withTransaction } from "@/lib/db";
import { employeeByPin } from "@/lib/employee-pin-security";
import { AuthenticationError, PermissionError, ValidationError } from "@/lib/http";
import { del, get, put } from "@/lib/storage";
import { toIsoTimestamp } from "@/lib/timestamp-values";
import {
  captureProof,
  changeDeliveryStatus,
  claimDeliveries,
  deliveryRoutePlans,
  deliveryStaffing,
  listDriverDeliveries,
  syncDeliveryAssignments,
  type DriverActor,
} from "@/lib/ordering-driver-delivery";
import { driverOrderDetail } from "@/lib/ordering-driver-orders";
import { deliLocation } from "@/lib/deli-location";
import { legNavigationUrl } from "@/lib/delivery-street-router";
import { complexBuilding } from "@/lib/complex-buildings";
import { GREETER_HOURS } from "@/lib/greeter-hours";
import { ogdensburgRouter } from "@/lib/route-map/ogdensburg-router";
import {
  isOnline,
  normalizePairingCode,
  pairingCode,
  PAIRING_MINUTES,
  PHOTO_REASONS,
  quietTime,
  stopTransitions,
  type CarCamera,
  type CarPhotoReason,
  type CarPoint,
} from "@/lib/car-tablet-rules";

/**
 * The delivery-car tablet (tools/car-tablet). It is paired once from POS Settings › Car tablet,
 * then authenticates with a bearer token. A driver signs in on it with their POS PIN; it then acts
 * as that driver for the existing delivery flow (ordering-driver-delivery), so the dispatch map,
 * customer tracking and audit trail work exactly as with the driver's phone.
 */

export type TabletBusiness = "Corner Deli" | "Tiki";
export type CarTablet = { id: string; business: TabletBusiness; name: string; driver_employee_id: string | null };

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

export async function createPairing(input: { business: TabletBusiness; name?: string; tabletId?: string; createdBy: string }) {
  const code = pairingCode((size) => randomBytes(size));
  const sql = getSql();
  if (input.tabletId) {
    const rows = await sql`UPDATE car_tablets SET pairing_code_hash=${hash(code)},pairing_expires_at=NOW()+(${PAIRING_MINUTES} * INTERVAL '1 minute'),
        revoked_at=NULL,name=COALESCE(NULLIF(${String(input.name || "").trim().slice(0, 60)},''),name)
      WHERE id=${input.tabletId} AND business=${input.business} RETURNING id,name,pairing_expires_at`;
    if (!rows[0]) throw new ValidationError("Car tablet not found.");
    return { tabletId: String(rows[0].id), name: String(rows[0].name), code, expiresAt: toIsoTimestamp(rows[0].pairing_expires_at) };
  }
  const id = randomUUID(), name = String(input.name || "").trim().slice(0, 60) || "Delivery car";
  const rows = await sql`INSERT INTO car_tablets(id,business,name,pairing_code_hash,pairing_expires_at,created_by)
    VALUES(${id},${input.business},${name},${hash(code)},NOW()+(${PAIRING_MINUTES} * INTERVAL '1 minute'),${input.createdBy.slice(0, 120)})
    RETURNING pairing_expires_at`;
  return { tabletId: id, name, code, expiresAt: toIsoTimestamp(rows[0].pairing_expires_at) };
}

/** The tablet trades the code for its long-lived token. The code works once. */
export async function completePairing(rawCode: unknown, device: { appVersion?: string; model?: string }) {
  const code = normalizePairingCode(rawCode);
  if (code.length !== 8) throw new AuthenticationError("Pairing code not recognized or expired.");
  const token = randomBytes(32).toString("base64url");
  const rows = await getSql()`UPDATE car_tablets SET token_hash=${hash(token)},pairing_code_hash=NULL,pairing_expires_at=NULL,paired_at=NOW(),revoked_at=NULL,
      app_version=${String(device.appVersion || "").slice(0, 40)},device_info=device_info||${JSON.stringify({ model: String(device.model || "").slice(0, 120) })}::jsonb
    WHERE pairing_code_hash=${hash(code)} AND pairing_expires_at>NOW() RETURNING id,business,name`;
  if (!rows[0]) throw new AuthenticationError("Pairing code not recognized or expired.");
  return { token, tabletId: String(rows[0].id), business: String(rows[0].business), name: String(rows[0].name) };
}

export async function tabletFromRequest(request: Request): Promise<CarTablet | null> {
  const header = request.headers.get("authorization") || "";
  const match = /^Bearer\s+([A-Za-z0-9_-]{20,200})$/.exec(header.trim());
  if (!match) return null;
  const row = (await getSql()`SELECT id,business,name,driver_employee_id FROM car_tablets WHERE token_hash=${hash(match[1])} AND revoked_at IS NULL`)[0];
  return row ? { id: String(row.id), business: row.business as TabletBusiness, name: String(row.name), driver_employee_id: row.driver_employee_id ? String(row.driver_employee_id) : null } : null;
}

export async function revokeTablet(business: TabletBusiness, tabletId: string) {
  const rows = await getSql()`UPDATE car_tablets SET revoked_at=NOW(),token_hash=NULL,pairing_code_hash=NULL,pairing_expires_at=NULL,driver_employee_id=NULL
    WHERE id=${tabletId} AND business=${business} RETURNING id`;
  if (!rows[0]) throw new ValidationError("Car tablet not found.");
  return { ok: true };
}

export async function renameTablet(business: TabletBusiness, tabletId: string, name: string) {
  const clean = name.trim().slice(0, 60);
  if (!clean) throw new ValidationError("Give the tablet a name.");
  const rows = await getSql()`UPDATE car_tablets SET name=${clean} WHERE id=${tabletId} AND business=${business} RETURNING id`;
  if (!rows[0]) throw new ValidationError("Car tablet not found.");
  return { ok: true };
}

/** The driver the tablet works for: the one signed in on it, else the only Driver on the clock. */
export async function effectiveDriver(tablet: CarTablet): Promise<{ employeeId: string; name: string; automatic: boolean } | null> {
  const sql = getSql();
  if (tablet.driver_employee_id) {
    const row = (await sql`SELECT id,name FROM employees WHERE id=${tablet.driver_employee_id} AND business=${tablet.business} AND active=TRUE`)[0];
    if (row) return { employeeId: String(row.id), name: String(row.name), automatic: false };
  }
  const rows = await sql`SELECT DISTINCT e.id,e.name FROM employees e JOIN time_entries t ON t.employee_id=e.id AND t.business=e.business AND t.clock_out IS NULL
    WHERE e.business=${tablet.business} AND e.active=TRUE AND e.role_group='Driver' LIMIT 2`;
  return rows.length === 1 ? { employeeId: String(rows[0].id), name: String(rows[0].name), automatic: true } : null;
}

/** The tablet acting as its driver, with driver (never dispatcher) rights. */
export async function tabletActor(tablet: CarTablet): Promise<DriverActor | null> {
  const driver = await effectiveDriver(tablet);
  if (!driver) return null;
  const row = (await getSql()`SELECT id,name,position,role_group,COALESCE(pos_role,'employee') pos_role,session_version FROM employees WHERE id=${driver.employeeId}`)[0];
  if (!row) return null;
  const staffing = await deliveryStaffing(tablet.business);
  return {
    employeeId: String(row.id),
    business: tablet.business,
    name: String(row.name),
    position: String(row.position || ""),
    roleGroup: row.role_group,
    posRole: row.pos_role,
    deviceSessionId: tablet.id,
    sessionVersion: Number(row.session_version || 1),
    expiresAt: Date.now() + 60_000,
    manager: false,
    driver: row.role_group === "Driver" || staffing.anyoneCanDeliver,
  };
}

export async function signInDriver(tablet: CarTablet, pin: unknown) {
  const employee = await employeeByPin(tablet.business, pin);
  if (!employee) throw new AuthenticationError("PIN not recognized.");
  if (employee.role_group !== "Driver" && !(await deliveryStaffing(tablet.business)).anyoneCanDeliver)
    throw new PermissionError("Only drivers can sign in on the car tablet.");
  await getSql()`UPDATE car_tablets SET driver_employee_id=${employee.id},driver_signed_in_at=NOW() WHERE id=${tablet.id}`;
  return { employeeId: String(employee.id), name: String(employee.name) };
}

export async function signOutDriver(tablet: CarTablet) {
  await getSql()`UPDATE car_tablets SET driver_employee_id=NULL,driver_signed_in_at=NULL WHERE id=${tablet.id}`;
  return { ok: true };
}

const optionalNumber = (value: unknown, min: number, max: number) => {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= min && number <= max ? number : null;
};

export async function recordHeartbeat(tablet: CarTablet, body: Record<string, unknown>) {
  const info = {
    model: String(body.model || "").slice(0, 120),
    androidVersion: String(body.androidVersion || "").slice(0, 20),
    kiosk: Boolean(body.kiosk),
    deviceOwner: Boolean(body.deviceOwner),
    gpsState: String(body.gpsState || "").slice(0, 40),
    queuedPoints: optionalNumber(body.queuedPoints, 0, 10_000_000),
    queuedPhotos: optionalNumber(body.queuedPhotos, 0, 100_000),
    lastUploadAt: String(body.lastUploadAt || "").slice(0, 40),
  };
  await getSql()`UPDATE car_tablets SET last_seen_at=NOW(),battery_percent=${optionalNumber(body.battery, 0, 100)},charging=${body.charging == null ? null : Boolean(body.charging)},
    network_type=${String(body.network || "").slice(0, 40)},signal_level=${optionalNumber(body.signal, 0, 4)},app_version=${String(body.appVersion || "").slice(0, 40)},
    device_info=device_info||${JSON.stringify(info)}::jsonb WHERE id=${tablet.id}`;
  return tabletStatus(tablet);
}

/**
 * Changes whenever anything the tablet's delivery list shows could have changed (a delivery order added,
 * moved on, assigned), so the tablet reloads the list only then instead of every few seconds.
 */
export async function feedVersion(tablet: CarTablet): Promise<string> {
  const row = (await getSql()`SELECT md5(COALESCE(string_agg(o.id::text||o.status||o.updated_at::text||COALESCE(d.status,'')||COALESCE(d.driver_employee_id::text,'')||COALESCE(d.updated_at::text,''),',' ORDER BY o.id),'')) version
    FROM ordering_orders o LEFT JOIN LATERAL(SELECT status,driver_employee_id,updated_at FROM ordering_delivery_assignments WHERE order_id=o.id ORDER BY created_at DESC LIMIT 1) d ON TRUE
    WHERE o.business=${tablet.business} AND o.service_type IN('delivery','no_contact_delivery')
      AND (o.status NOT IN('draft','completed','cancelled') OR d.updated_at>NOW()-INTERVAL '10 minutes')`)[0];
  const driver = (await getSql()`SELECT driver_employee_id FROM car_tablets WHERE id=${tablet.id}`)[0]?.driver_employee_id;
  return `${String(row?.version || "")}:${String(driver || "")}`.slice(0, 80);
}

/** What the tablet shows in its header: who is driving and whether anything is waiting for it. */
export async function tabletStatus(tablet: CarTablet) {
  const driver = await effectiveDriver(tablet);
  const pending = Number((await getSql()`SELECT COUNT(*)::int count FROM car_tablet_commands WHERE tablet_id=${tablet.id} AND completed_at IS NULL AND expires_at>NOW()`)[0]?.count || 0);
  return { tablet: { id: tablet.id, name: tablet.name, business: tablet.business }, driver, pendingCommands: pending, serverTime: new Date().toISOString(),
    // Overnight (30 min after close to 30 min before opening): no GPS, check in every 15 minutes.
    ...quietTime(GREETER_HOURS), feedVersion: await feedVersion(tablet) };
}

/**
 * Stores a batch of GPS points (idempotent on the tablet's point id), moves the car's "last seen
 * here", and copies points into every delivery its driver is out on so the dispatch map, store
 * dashboard and customer tracker show the car like a driver phone.
 */
export async function ingestPoints(tablet: CarTablet, points: CarPoint[]) {
  if (!points.length) return { accepted: 0, deliveryPoints: 0, stops: [] };
  const driver = await effectiveDriver(tablet);
  const columns = {
    ids: points.map((point) => point.id),
    times: points.map((point) => point.capturedAt.toISOString()),
    lats: points.map((point) => point.latitude),
    lngs: points.map((point) => point.longitude),
    accuracies: points.map((point) => point.accuracy),
    speeds: points.map((point) => point.speed),
    headings: points.map((point) => point.heading),
  };
  const result = await withTransaction(async () => {
    const sql = getSql();
    const inserted = await sql`INSERT INTO car_tablet_locations(id,tablet_id,driver_employee_id,client_event_id,captured_at,latitude,longitude,accuracy_meters,speed_mps,heading)
      SELECT gen_random_uuid(),${tablet.id},${driver?.employeeId ?? null},p.id,p.captured_at,p.latitude,p.longitude,p.accuracy,p.speed,p.heading
      FROM unnest(${columns.ids}::text[],${columns.times}::timestamptz[],${columns.lats}::float8[],${columns.lngs}::float8[],${columns.accuracies}::float8[],${columns.speeds}::float8[],${columns.headings}::float8[])
        AS p(id,captured_at,latitude,longitude,accuracy,speed,heading)
      ON CONFLICT(tablet_id,client_event_id) DO NOTHING RETURNING id`;
    const newest = points.reduce((latest, point) => point.capturedAt > latest.capturedAt ? point : latest);
    await sql`UPDATE car_tablets SET last_latitude=${newest.latitude},last_longitude=${newest.longitude},last_accuracy_meters=${newest.accuracy},
        last_speed_mps=${newest.speed},last_heading=${newest.heading},last_location_at=${newest.capturedAt.toISOString()},last_seen_at=NOW()
      WHERE id=${tablet.id} AND (last_location_at IS NULL OR last_location_at<=${newest.capturedAt.toISOString()})`;
    let deliveryPoints = 0;
    if (driver) {
      const copied = await sql`INSERT INTO ordering_delivery_locations(id,tracking_session_id,delivery_id,driver_id,device_session_id,client_event_id,captured_at,latitude,longitude,accuracy_meters,metadata)
        SELECT gen_random_uuid(),s.id,s.delivery_id,s.driver_id,${tablet.id},'car:'||p.id||':'||s.delivery_id,p.captured_at,p.latitude,p.longitude,p.accuracy,
          jsonb_build_object('source','car-tablet','tabletId',${tablet.id}::text,'heading',p.heading,'speed',p.speed)
        FROM unnest(${columns.ids}::text[],${columns.times}::timestamptz[],${columns.lats}::float8[],${columns.lngs}::float8[],${columns.accuracies}::float8[],${columns.speeds}::float8[],${columns.headings}::float8[])
          AS p(id,captured_at,latitude,longitude,accuracy,speed,heading)
        JOIN ordering_delivery_tracking_sessions s ON s.driver_id=${driver.employeeId} AND s.stopped_at IS NULL AND p.captured_at>=s.started_at-INTERVAL '1 minute'
        JOIN ordering_delivery_assignments d ON d.id=s.delivery_id AND d.business=${tablet.business} AND d.status IN('EN_ROUTE','ARRIVED','NO_CONTACT')
        ON CONFLICT(driver_id,client_event_id) DO NOTHING RETURNING id`;
      deliveryPoints = copied.length;
    }
    return { accepted: inserted.length, deliveryPoints };
  });
  const stops = driver ? await applyGpsStops(tablet, driver.employeeId, points).catch((error) => { console.error("[car-tablet] GPS stops", error); return []; }) : [];
  return { ...result, stops };
}

/**
 * Marks deliveries arrived/delivered from where the car stopped (stopTransitions), as the driver.
 * On arrival the tablet is asked for a road photo, saved as that delivery's proof photo.
 */
async function applyGpsStops(tablet: CarTablet, driverId: string, points: CarPoint[]) {
  // arrived_at is when the server heard about it; after a dead zone that's later than the car's actual stop,
  // so the stop's start comes from the car's own first point near the address (≈60 m box) when there is one.
  const rows = await getSql()`SELECT d.id,d.status,d.order_id,d.en_route_at,a.latitude::float8 latitude,a.longitude::float8 longitude,a.formatted_address,a.line2,
      COALESCE((SELECT MIN(l.captured_at) FROM car_tablet_locations l WHERE l.tablet_id=${tablet.id} AND l.captured_at>=d.en_route_at
        AND abs(l.latitude-a.latitude)<0.00055 AND abs(l.longitude-a.longitude)<0.00075),d.arrived_at) arrived_at
    FROM ordering_delivery_assignments d JOIN ordering_order_delivery_addresses a ON a.order_id=d.order_id
    WHERE d.business=${tablet.business} AND d.driver_employee_id=${driverId} AND d.status IN('EN_ROUTE','ARRIVED')
      AND a.latitude IS NOT NULL AND a.longitude IS NOT NULL`;
  if (!rows.length) return [];
  const when = (value: unknown) => { const iso = toIsoTimestamp(value); return iso ? new Date(iso) : null; };
  const transitions = stopTransitions(rows.map((row) => {
    const building = complexBuilding({ address: row.formatted_address, unit: row.line2, latitude: row.latitude, longitude: row.longitude });
    return {
      id: String(row.id), status: String(row.status), latitude: building?.latitude ?? Number(row.latitude), longitude: building?.longitude ?? Number(row.longitude),
      enRouteAt: when(row.en_route_at), arrivedAt: when(row.arrived_at),
    };
  }), points);
  if (!transitions.length) return [];
  const actor = await tabletActor(tablet);
  if (!actor) return [];
  const done = [];
  for (const transition of transitions) {
    try {
      if (transition.action === "arrived") {
        await changeDeliveryStatus(actor, transition.deliveryId, "ARRIVED", "GPS: the car stopped at the address");
        const orderId = String(rows.find((row) => String(row.id) === transition.deliveryId)?.order_id || "");
        await queueSnap(tablet.business, tablet.id, ["road"], "GPS stop at the address", orderId, { proof: true }).catch(() => undefined);
      } else {
        await changeDeliveryStatus(actor, transition.deliveryId, "DELIVERED", "GPS: the car drove off after stopping at the address");
      }
      done.push(transition);
    } catch (error) {
      // e.g. a no-contact order whose proof photo hasn't arrived yet: it stays Arrived for the driver to finish.
      console.warn("[car-tablet] GPS stop", transition, error instanceof Error ? error.message : error);
    }
  }
  return done;
}

const ACTIVE = ["ASSIGNED", "READY_FOR_DRIVER", "PICKED_UP", "EN_ROUTE", "ARRIVED", "NO_CONTACT", "DELIVERY_FAILED"];

/** The driver's deliveries (and unclaimed ones they may take), in the shape the tablet draws. */
export async function tabletDeliveries(tablet: CarTablet) {
  const actor = await tabletActor(tablet);
  if (!actor) return { driver: null, deliveries: [], route: null };
  await syncDeliveryAssignments(tablet.business);
  const rows = await listDriverDeliveries(actor, {});
  const deliveries = [];
  for (const row of rows) {
    if (!ACTIVE.includes(String(row.delivery_status))) continue;
    const mine = row.assigned_employee_id === actor.employeeId;
    let items: Array<{ quantity: number; name: string; options: string[]; instructions: string }> = [];
    if (mine) {
      try {
        const detail = await driverOrderDetail(actor, String(row.delivery_id), "");
        items = detail.items
          .filter((item) => item.quantity - item.cancelledQuantity > 0)
          .map((item) => ({ quantity: item.quantity - item.cancelledQuantity, name: [item.name, item.variant].filter(Boolean).join(" · "), options: item.options, instructions: item.instructions }));
      } catch (error) {
        console.error("[car-tablet] order detail", error);
      }
    }
    const building = complexBuilding({ address: row.delivery_address, unit: row.delivery_unit, latitude: row.destination_latitude, longitude: row.destination_longitude });
    deliveries.push({
      deliveryId: String(row.delivery_id),
      orderId: String(row.order_id),
      displayNumber: String(row.display_number),
      status: String(row.delivery_status),
      mine,
      customerName: String(row.customer_name || "Guest"),
      phone: String(row.delivery_phone || ""),
      address: String(row.delivery_address || ""),
      // Belmont Courts: the building shows with the unit, and Navigate / GPS stops use the building.
      unit: [String(row.delivery_unit || ""), building?.label].filter(Boolean).join(" · "),
      building: building?.label ?? null,
      notes: String(row.delivery_notes || ""),
      latitude: building?.latitude ?? (row.destination_latitude == null ? null : Number(row.destination_latitude)),
      longitude: building?.longitude ?? (row.destination_longitude == null ? null : Number(row.destination_longitude)),
      serviceType: String(row.service_type),
      noContact: row.service_type === "no_contact_delivery",
      scheduledFor: toIsoTimestamp(row.scheduled_for),
      createdAt: toIsoTimestamp(row.created_at),
      itemCount: Number(row.item_count || 0),
      amountDueCents: Number(row.amount_due_cents || 0),
      paymentStatus: String(row.payment_status || ""),
      items,
    });
  }
  // The driver's own deliveries first, out-the-door ones before those still in the store.
  const rank = (status: string) => ["ARRIVED", "NO_CONTACT", "EN_ROUTE", "PICKED_UP", "READY_FOR_DRIVER", "ASSIGNED", "DELIVERY_FAILED"].indexOf(status);
  deliveries.sort((a, b) => Number(b.mine) - Number(a.mine) || rank(a.status) - rank(b.status));
  // Navigate: from where the car is, on the preferred streets (Google Maps pinned to them).
  let route: { navigationUrl: string | null; order: string[]; loopMinutes: number | null } | null = null;
  try {
    const car = (await getSql()`SELECT last_latitude::float8 latitude,last_longitude::float8 longitude FROM car_tablets WHERE id=${tablet.id}`)[0];
    const here = car?.latitude != null ? { latitude: Number(car.latitude), longitude: Number(car.longitude) } : await deliLocation();
    if (here) for (const delivery of deliveries)
      if (delivery.latitude != null && delivery.longitude != null)
        Object.assign(delivery, { navigationUrl: legNavigationUrl(ogdensburgRouter(), here, { latitude: delivery.latitude, longitude: delivery.longitude }) });
    const plan = deliveryRoutePlans(rows.filter((row) => row.assigned_employee_id === actor.employeeId) as Array<Record<string, unknown>>, new Date(), await deliLocation())[0]?.plan;
    if (plan?.stops.length) route = { navigationUrl: plan.navigationUrl, order: plan.stops.map((stop) => stop.deliveryId), loopMinutes: "loopMinutes" in plan ? Number(plan.loopMinutes) : null };
  } catch (error) {
    console.error("[car-tablet] route", error);
  }
  return { driver: { employeeId: actor.employeeId, name: actor.name }, deliveries, route };
}

/** Drive screen route to one delivery (see /api/car-tablet/route). */
export async function tabletDriveRoute(tablet: CarTablet, from: { latitude: number; longitude: number }, deliveryId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(deliveryId)) throw new ValidationError("Choose a delivery.");
  const row = (await getSql()`SELECT a.formatted_address,a.line2,a.latitude::float8 latitude,a.longitude::float8 longitude,o.display_number
    FROM ordering_delivery_assignments d JOIN ordering_order_delivery_addresses a ON a.order_id=d.order_id JOIN ordering_orders o ON o.id=d.order_id
    WHERE d.id=${deliveryId} AND d.business=${tablet.business}`)[0];
  if (!row || row.latitude == null) throw new ValidationError("That delivery has no map location.");
  const building = complexBuilding({ address: row.formatted_address, unit: row.line2, latitude: row.latitude, longitude: row.longitude });
  const to = building ? { latitude: building.latitude, longitude: building.longitude } : { latitude: Number(row.latitude), longitude: Number(row.longitude) };
  const router = ogdensburgRouter();
  if (router.distanceToNetwork(from) > 800 || router.distanceToNetwork(to) > 800) return { route: null, reason: "off_map", destination: { ...to, label: String(row.formatted_address) } };
  const leg = router.route(from, to);
  if (!leg) return { route: null, reason: "no_route", destination: { ...to, label: String(row.formatted_address) } };
  return {
    route: { path: leg.path, steps: leg.steps, seconds: Math.round(leg.seconds), metres: Math.round(leg.metres), stopSigns: leg.stopSigns, streets: leg.streets },
    destination: { ...to, label: `#${row.display_number} · ${String(row.formatted_address).split(",")[0]}${building ? ` · ${building.label}` : ""}` },
  };
}

export const TABLET_ACTIONS = ["claim", "picked_up", "arrived", "delivered", "no_contact", "failed", "returned"] as const;
export type TabletAction = typeof TABLET_ACTIONS[number];

/**
 * One tap on the tablet. "Picked up" means the food is in the car and the driver is leaving,
 * so it also starts the trip (EN_ROUTE), which is what turns on customer tracking.
 */
export async function tabletDeliveryAction(tablet: CarTablet, deliveryId: string, action: TabletAction, note = "") {
  const actor = await tabletActor(tablet);
  if (!actor) throw new PermissionError("Sign in on the tablet with your PIN first.");
  const status = String((await getSql()`SELECT status FROM ordering_delivery_assignments WHERE id=${deliveryId} AND business=${tablet.business}`)[0]?.status || "");
  if (!status) throw new ValidationError("Delivery not found.");
  switch (action) {
    case "claim":
      return claimDeliveries(actor, { deliveryIds: [deliveryId] });
    case "picked_up":
      if (["ASSIGNED", "READY_FOR_DRIVER"].includes(status)) await changeDeliveryStatus(actor, deliveryId, "PICKED_UP", note);
      if (["ASSIGNED", "READY_FOR_DRIVER", "PICKED_UP"].includes(status)) return changeDeliveryStatus(actor, deliveryId, "EN_ROUTE", note);
      throw new ValidationError("This delivery has already left the store.");
    case "arrived":
      return changeDeliveryStatus(actor, deliveryId, "ARRIVED", note);
    case "delivered":
      return changeDeliveryStatus(actor, deliveryId, "DELIVERED", note);
    case "no_contact":
      return changeDeliveryStatus(actor, deliveryId, "NO_CONTACT", note);
    case "failed":
      return changeDeliveryStatus(actor, deliveryId, "DELIVERY_FAILED", note);
    case "returned":
      return changeDeliveryStatus(actor, deliveryId, "RETURNED", note);
  }
}

export async function savePhoto(tablet: CarTablet, file: File, meta: {
  clientPhotoId: string; camera: CarCamera; reason: CarPhotoReason; capturedAt: Date;
  latitude: number | null; longitude: number | null; accuracy: number | null;
  orderId?: string; deliveryId?: string; commandId?: string;
}) {
  if (file.type !== "image/jpeg" || file.size < 1 || file.size > 10_000_000) throw new ValidationError("Send a JPEG photo up to 10 MB.");
  if (!PHOTO_REASONS.includes(meta.reason)) throw new ValidationError("Unknown photo reason.");
  const sql = getSql();
  const existing = (await sql`SELECT id FROM car_tablet_photos WHERE tablet_id=${tablet.id} AND client_photo_id=${meta.clientPhotoId}`)[0];
  if (existing) return { ok: true, photoId: String(existing.id), duplicate: true };
  const uuid = /^[0-9a-f-]{36}$/i;
  // The delivery decides the order; a photo can name just one of them.
  let delivery = meta.deliveryId && uuid.test(meta.deliveryId)
    ? (await sql`SELECT id,order_id,status FROM ordering_delivery_assignments WHERE id=${meta.deliveryId} AND business=${tablet.business}`)[0] : undefined;
  if (!delivery && meta.orderId && uuid.test(meta.orderId))
    delivery = (await sql`SELECT d.id,d.order_id,d.status FROM ordering_delivery_assignments d WHERE d.order_id=${meta.orderId} AND d.business=${tablet.business} ORDER BY d.created_at DESC LIMIT 1`)[0];
  const orderId = delivery ? String(delivery.order_id) : meta.orderId && uuid.test(meta.orderId)
    ? ((await sql`SELECT id FROM ordering_orders WHERE id=${meta.orderId} AND business=${tablet.business}`)[0]?.id ?? null) : null;
  const command = meta.commandId && uuid.test(meta.commandId)
    ? (await sql`SELECT id,payload FROM car_tablet_commands WHERE id=${meta.commandId} AND tablet_id=${tablet.id}`)[0] : undefined;
  const driver = await effectiveDriver(tablet);
  const id = randomUUID();
  const day = meta.capturedAt.toISOString().slice(0, 10);
  const bytes = await file.arrayBuffer();
  const stored = await put(`car-tablet/${tablet.id}/${day}/${id}-${meta.camera}.jpg`, bytes, { access: "private", contentType: "image/jpeg" });
  await sql`INSERT INTO car_tablet_photos(id,tablet_id,business,client_photo_id,camera,reason,command_id,order_id,delivery_id,driver_employee_id,storage_reference,mime_type,size_bytes,captured_at,latitude,longitude,accuracy_meters)
    VALUES(${id},${tablet.id},${tablet.business},${meta.clientPhotoId},${meta.camera},${meta.reason},${command?.id ?? null},${orderId},${delivery?.id ?? null},${driver?.employeeId ?? null},
      ${stored.url},'image/jpeg',${file.size},${meta.capturedAt.toISOString()},${meta.latitude},${meta.longitude},${meta.accuracy})
    ON CONFLICT(tablet_id,client_photo_id) DO NOTHING`;
  if (command) await finishSnapIfComplete(String(command.id));
  // The road photo taken as the driver taps Delivered doubles as the delivery's proof photo
  // (no-contact orders need one before they can be marked delivered). A GPS-stop snap (command payload proof) counts too.
  if ((meta.reason === "delivery_complete" || command?.payload?.proof === true) && delivery && !["DELIVERED", "RETURNED", "CANCELLED"].includes(String(delivery.status))) {
    const actor = await tabletActor(tablet);
    if (actor) {
      const order = (await sql`SELECT service_type FROM ordering_orders WHERE id=${delivery.order_id}`)[0];
      await captureProof(actor, String(delivery.id), new File([bytes], `${id}.jpg`, { type: "image/jpeg" }), {
        capturedAt: meta.capturedAt.toISOString(),
        latitude: meta.latitude ?? undefined,
        longitude: meta.longitude ?? undefined,
        accuracy: meta.accuracy ?? undefined,
        proofType: order?.service_type === "no_contact_delivery" ? "no_contact" : "car_tablet",
        note: `Car tablet ${meta.camera} photo`,
      }).catch((error) => console.error("[car-tablet] proof", error));
    }
  }
  return { ok: true, photoId: id, duplicate: false };
}

async function finishSnapIfComplete(commandId: string) {
  await getSql()`UPDATE car_tablet_commands c SET completed_at=NOW(),result=c.result||jsonb_build_object('status','done')
    WHERE c.id=${commandId} AND c.completed_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(c.payload->'cameras') cam WHERE NOT EXISTS(SELECT 1 FROM car_tablet_photos p WHERE p.command_id=c.id AND p.camera=cam))`;
}

export async function queueSnap(business: TabletBusiness, tabletId: string, cameras: CarCamera[], requestedBy: string, orderId?: string | null, extra: { proof?: boolean } = {}) {
  if (!cameras.length) throw new ValidationError("Choose the cabin camera, the road camera or both.");
  const tablet = (await getSql()`SELECT id FROM car_tablets WHERE id=${tabletId} AND business=${business} AND revoked_at IS NULL AND token_hash IS NOT NULL`)[0];
  if (!tablet) throw new ValidationError("That car tablet isn't paired.");
  const id = randomUUID();
  await getSql()`INSERT INTO car_tablet_commands(id,tablet_id,kind,payload,requested_by,expires_at)
    VALUES(${id},${tabletId},'snap',${JSON.stringify({ cameras, orderId: orderId || null, ...extra })}::jsonb,${requestedBy.slice(0, 120)},NOW()+INTERVAL '10 minutes')`;
  return { ok: true, commandId: id };
}

function pendingCommandRows(tabletId: string) {
  return getSql()`UPDATE car_tablet_commands SET delivered_at=COALESCE(delivered_at,NOW())
    WHERE id IN(SELECT id FROM car_tablet_commands WHERE tablet_id=${tabletId} AND completed_at IS NULL AND expires_at>NOW()
      AND (delivered_at IS NULL OR delivered_at<NOW()-INTERVAL '45 seconds') ORDER BY created_at LIMIT 10)
    RETURNING id,kind,payload,created_at`;
}

/**
 * Long poll: returns as soon as a command is waiting, or empty after `waitSeconds`. A command
 * handed out but not finished is offered again after 45 s (the tablet may have lost signal).
 */
export async function waitForCommands(tablet: CarTablet, waitSeconds: number, signal?: AbortSignal, knownFeed?: string) {
  const deadline = Date.now() + Math.max(0, Math.min(waitSeconds, 30)) * 1000;
  await getSql()`UPDATE car_tablets SET last_seen_at=NOW() WHERE id=${tablet.id}`;
  for (let tick = 0; ; tick++) {
    const rows = await pendingCommandRows(tablet.id);
    // The delivery list changed: answer now so the tablet reloads it (checked every 2 s).
    const feed = knownFeed != null && tick % 2 === 0 ? await feedVersion(tablet) : knownFeed;
    if (rows.length || feed !== knownFeed || Date.now() >= deadline || signal?.aborted)
      return {
        commands: rows.map((row) => ({ id: String(row.id), kind: String(row.kind), payload: row.payload, createdAt: toIsoTimestamp(row.created_at) })),
        feedVersion: feed ?? null,
        ...quietTime(GREETER_HOURS),
      };
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

export async function finishCommand(tablet: CarTablet, commandId: string, result: { status: string; error?: string }) {
  const rows = await getSql()`UPDATE car_tablet_commands SET completed_at=COALESCE(completed_at,NOW()),
      result=result||${JSON.stringify({ status: String(result.status).slice(0, 20), error: String(result.error || "").slice(0, 300) })}::jsonb
    WHERE id=${commandId} AND tablet_id=${tablet.id} RETURNING id`;
  if (!rows[0]) throw new ValidationError("Command not found.");
  return { ok: true };
}

/** Tablets for the POS: status, battery, last place, driver, and what was asked of them. */
export async function listTablets(business: TabletBusiness) {
  const sql = getSql();
  const rows = await sql`SELECT t.*,e.name driver_name,
      (SELECT COUNT(*)::int FROM car_tablet_commands c WHERE c.tablet_id=t.id AND c.completed_at IS NULL AND c.expires_at>NOW()) pending_commands,
      (SELECT COUNT(*)::int FROM car_tablet_photos p WHERE p.tablet_id=t.id AND p.captured_at>NOW()-INTERVAL '24 hours') photos_today
    FROM car_tablets t LEFT JOIN employees e ON e.id=t.driver_employee_id
    WHERE t.business=${business} AND (t.revoked_at IS NULL OR t.revoked_at>NOW()-INTERVAL '30 days') ORDER BY t.revoked_at NULLS FIRST,t.created_at`;
  const now = new Date();
  return Promise.all(rows.map(async (row) => {
    const tablet = { id: String(row.id), business, name: String(row.name), driver_employee_id: row.driver_employee_id ? String(row.driver_employee_id) : null };
    const driver = row.revoked_at ? null : await effectiveDriver(tablet);
    return {
      id: tablet.id,
      name: tablet.name,
      paired: Boolean(row.token_hash) && !row.revoked_at,
      revoked: Boolean(row.revoked_at),
      pairingPending: Boolean(row.pairing_code_hash) && new Date(toIsoTimestamp(row.pairing_expires_at) || 0) > now,
      pairedAt: toIsoTimestamp(row.paired_at),
      online: !row.revoked_at && isOnline(toIsoTimestamp(row.last_seen_at), now),
      lastSeenAt: toIsoTimestamp(row.last_seen_at),
      batteryPercent: row.battery_percent == null ? null : Number(row.battery_percent),
      charging: row.charging == null ? null : Boolean(row.charging),
      networkType: String(row.network_type || ""),
      signalLevel: row.signal_level == null ? null : Number(row.signal_level),
      appVersion: String(row.app_version || ""),
      device: row.device_info || {},
      location: row.last_latitude == null ? null : {
        latitude: Number(row.last_latitude), longitude: Number(row.last_longitude),
        accuracyMeters: row.last_accuracy_meters == null ? null : Number(row.last_accuracy_meters),
        speedMph: row.last_speed_mps == null ? null : Math.round(Number(row.last_speed_mps) * 2.23694),
        heading: row.last_heading == null ? null : Number(row.last_heading),
        capturedAt: toIsoTimestamp(row.last_location_at),
      },
      driver,
      pendingCommands: Number(row.pending_commands || 0),
      photosToday: Number(row.photos_today || 0),
    };
  }));
}

export async function listPhotos(business: TabletBusiness, filter: { tabletId?: string; orderId?: string; limit?: number }) {
  const limit = Math.max(1, Math.min(Number(filter.limit) || 60, 200));
  const rows = await getSql()`SELECT p.id,p.tablet_id,t.name tablet_name,p.camera,p.reason,p.order_id,o.display_number,p.delivery_id,e.name driver_name,p.captured_at,p.latitude,p.longitude,p.size_bytes,c.requested_by
    FROM car_tablet_photos p JOIN car_tablets t ON t.id=p.tablet_id LEFT JOIN ordering_orders o ON o.id=p.order_id LEFT JOIN employees e ON e.id=p.driver_employee_id
    LEFT JOIN car_tablet_commands c ON c.id=p.command_id
    WHERE p.business=${business} AND (${filter.tabletId || null}::uuid IS NULL OR p.tablet_id=${filter.tabletId || null}::uuid)
      AND (${filter.orderId || null}::uuid IS NULL OR p.order_id=${filter.orderId || null}::uuid)
    ORDER BY p.captured_at DESC LIMIT ${limit}`;
  return rows.map((row) => ({
    id: String(row.id), tabletId: String(row.tablet_id), tabletName: String(row.tablet_name), camera: String(row.camera), reason: String(row.reason),
    orderId: row.order_id ? String(row.order_id) : null, displayNumber: row.display_number ? String(row.display_number) : null,
    deliveryId: row.delivery_id ? String(row.delivery_id) : null, driverName: row.driver_name ? String(row.driver_name) : null,
    requestedBy: row.requested_by ? String(row.requested_by) : null,
    capturedAt: toIsoTimestamp(row.captured_at),
    latitude: row.latitude == null ? null : Number(row.latitude), longitude: row.longitude == null ? null : Number(row.longitude),
    url: `/api/ordering/car-tablets/photos/${row.id}`,
  }));
}

/** Manager clean-up (test shots, mistakes). A copy saved as a delivery's proof photo is kept with the delivery. */
export async function deletePhotos(business: TabletBusiness, photoIds: string[]) {
  const ids = photoIds.filter((id) => /^[0-9a-f-]{36}$/i.test(id)).slice(0, 200);
  if (!ids.length) throw new ValidationError("Choose the photos to delete.");
  const rows = await getSql()`DELETE FROM car_tablet_photos WHERE business=${business} AND id=ANY(${ids}::uuid[]) RETURNING storage_reference`;
  await del(rows.map((row) => String(row.storage_reference))).catch((error) => console.error("[car-tablet] photo files", error));
  return { ok: true, deleted: rows.length };
}

export async function photoFile(business: TabletBusiness, photoId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(photoId)) return null;
  const row = (await getSql()`SELECT storage_reference,mime_type FROM car_tablet_photos WHERE id=${photoId} AND business=${business}`)[0];
  if (!row) return null;
  const object = await get(String(row.storage_reference), { access: "private" });
  return object?.stream ? { stream: object.stream, mimeType: String(row.mime_type) } : null;
}
