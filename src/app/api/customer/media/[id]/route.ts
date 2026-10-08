import { getSql } from "@/lib/db";
import { get } from "@/lib/storage";
import { ensureOrderingMenuOverrideSchema } from "@/lib/ordering-menu-overrides";

export const runtime = "nodejs";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  await ensureOrderingMenuOverrideSchema();
  const { id } = await params;
  const rows = await getSql()`
    SELECT media.storage_reference,media.mime_type
    FROM ordering_menu_media media
    JOIN ordering_menu_items item ON media.target_type='item' AND item.id=media.target_id
    LEFT JOIN ordering_item_overrides general ON general.item_id=item.id
    LEFT JOIN ordering_item_channel_overrides web ON web.item_id=item.id AND web.channel='web'
    WHERE media.id=${id} AND media.show_web=TRUE AND item.business='Corner Deli'
      AND item.active=TRUE AND COALESCE(web.visible,general.visible,TRUE)=TRUE
    LIMIT 1
  `;
  if (!rows[0]) return new Response("Not found", { status: 404 });
  const object = await get(String(rows[0].storage_reference), { access: "public", ifNoneMatch: request.headers.get("if-none-match") || undefined });
  if (!object) return new Response("Not found", { status: 404 });
  return new Response(object.stream, { status: object.statusCode, headers: { "content-type": String(rows[0].mime_type), etag: object.blob.etag, "cache-control": "public,max-age=3600", "x-content-type-options": "nosniff" } });
}
