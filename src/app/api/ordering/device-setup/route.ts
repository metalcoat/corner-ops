import { getSql } from "@/lib/db";
import { ensureOrderingHardwareSchema } from "@/lib/ordering-hardware-schema";

export const runtime = "nodejs";

/** Names only (no addresses or settings): what a new tablet can be set up as. */
export async function GET() {
  try {
    await ensureOrderingHardwareSchema();
    const sql = getSql();
    const [stations, labelPrinters] = await Promise.all([
      sql`SELECT name,station_key,station_mode,customer_display_enabled FROM ordering_payment_stations WHERE business='Corner Deli' AND active=TRUE ORDER BY station_mode DESC,name`,
      sql`SELECT id,name FROM ordering_hardware_devices WHERE business='Corner Deli' AND role='label_printer' AND active=TRUE ORDER BY name`,
    ]);
    return Response.json({
      stations: stations.map((row) => ({ name: String(row.name), key: String(row.station_key), payment: row.station_mode === "payment", customerDisplay: Boolean(row.customer_display_enabled) })),
      labelPrinters: labelPrinters.map((row) => ({ id: String(row.id), name: String(row.name) })),
    });
  } catch (error) {
    console.error(error);
    return Response.json({ error: "Setup options could not be loaded." }, { status: 500 });
  }
}
