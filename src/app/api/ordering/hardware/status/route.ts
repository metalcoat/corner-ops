import { isoJson } from "@/lib/timestamp-values";
import { apiError, unauthorized } from "@/lib/http";
import { operationalPrinterStatus } from "@/lib/ordering-hardware";
import { orderingActor } from "@/lib/ordering-route-auth";
import { paymentStationProfile } from "@/lib/ordering-payment-stations";

export const runtime = "nodejs";

export async function GET(request:Request) {
  try {
    if (!await orderingActor("Corner Deli")) return unauthorized();
    const printer=await operationalPrinterStatus("Corner Deli"),stationKey=new URL(request.url).searchParams.get("stationKey")||"",station=stationKey?await paymentStationProfile("Corner Deli",stationKey):null,readerExpected=station?.station_mode==="payment";
    return isoJson({...printer,cardReader:readerExpected?(station?.payment_terminal_id&&station.terminal_status==="online"?"online":"offline"):"not_applicable",stationMode:station?.station_mode||"unassigned"});
  } catch (error) {
    return apiError(error);
  }
}
