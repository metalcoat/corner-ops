import { isoJson } from "@/lib/timestamp-values";
import { getPosSession } from "@/lib/pos-auth";
import { currentScreen, screenSigner } from "@/lib/screen-auth";
import { orderingStoreDashboard } from "@/lib/ordering-store-dashboard";
import { deliCallStats } from "@/lib/three-cx-call-stats";
import { doorWalkInDashboard } from "@/lib/door-chime";
import { listTablets } from "@/lib/car-tablet";

export const runtime="nodejs";
export async function GET(){try{const session=await getPosSession(false);if((!session||session.clockInRequired)&&!(await screenSigner())&&!(await currentScreen("board")))return isoJson({error:"Employee sign-in required."},{status:401});const [dashboard,calls,doorGreets,carTablets]=await Promise.all([orderingStoreDashboard(),deliCallStats().catch((error)=>{console.error("Call stats unavailable",error);return null}),doorWalkInDashboard("Corner Deli").catch((error)=>{console.error("Door walk-ins unavailable",error);return null}),listTablets("Corner Deli").then(rows=>rows.filter(row=>row.paired)).catch((error)=>{console.error("Car tablets unavailable",error);return []})]);return isoJson({...dashboard,calls,doorGreets,carTablets})}catch(error){console.error(error);return isoJson({error:"The store dashboard is temporarily unavailable."},{status:500})}}
