import { isoJson } from "@/lib/timestamp-values";
export const dynamic="force-dynamic";
export function GET(){return isoJson({appId:"com.ordercornerdeli.pos",versionName:"1.1.0",versionCode:2,downloadUrl:"https://dev.ordercornerdeli.com/downloads/corner-deli-pos.apk",minimumSupportedVersionCode:2},{headers:{"Cache-Control":"public, max-age=300"}})}
