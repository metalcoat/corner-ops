import { ValidationError } from "@/lib/http";
import { withTablet } from "@/lib/car-tablet-route";
import { CAMERAS, type CarCamera, type CarPhotoReason } from "@/lib/car-tablet-rules";
import { savePhoto } from "@/lib/car-tablet";

export const runtime = "nodejs";

const number = (value: FormDataEntryValue | null) => value == null || value === "" || !Number.isFinite(Number(value)) ? null : Number(value);

/** One JPEG from the cabin (front) or road (rear) camera, with when, where and why. Idempotent on clientPhotoId. */
export function POST(request: Request) {
  return withTablet(request, async (tablet) => {
    const form = await request.formData();
    const photo = form.get("photo"), camera = String(form.get("camera") || "") as CarCamera;
    if (!(photo instanceof File)) throw new ValidationError("Photo required.");
    if (!CAMERAS.includes(camera)) throw new ValidationError("Camera must be cabin or road.");
    const clientPhotoId = String(form.get("clientPhotoId") || "").slice(0, 64);
    if (clientPhotoId.length < 8) throw new ValidationError("clientPhotoId required.");
    const capturedAt = new Date(String(form.get("capturedAt") || ""));
    return savePhoto(tablet, photo, {
      clientPhotoId,
      camera,
      reason: String(form.get("reason") || "manual") as CarPhotoReason,
      capturedAt: Number.isFinite(capturedAt.getTime()) ? capturedAt : new Date(),
      latitude: number(form.get("latitude")),
      longitude: number(form.get("longitude")),
      accuracy: number(form.get("accuracy")),
      orderId: String(form.get("orderId") || "") || undefined,
      deliveryId: String(form.get("deliveryId") || "") || undefined,
      commandId: String(form.get("commandId") || "") || undefined,
    });
  });
}
