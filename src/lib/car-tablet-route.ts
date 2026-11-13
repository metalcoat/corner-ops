import { apiError } from "@/lib/http";
import { isoJson } from "@/lib/timestamp-values";
import { tabletFromRequest, type CarTablet } from "@/lib/car-tablet";

/** Car tablet API routes: the bearer token from pairing, else 401 (the tablet then shows its pairing screen). */
export async function withTablet(request: Request, handle: (tablet: CarTablet) => Promise<unknown>): Promise<Response> {
  try {
    const tablet = await tabletFromRequest(request);
    if (!tablet) return isoJson({ error: "This tablet isn't paired (or was unpaired from the POS).", code: "unpaired" }, { status: 401 });
    const result = await handle(tablet);
    return result instanceof Response ? result : isoJson(result);
  } catch (error) {
    if (error instanceof Error && /not assigned|cannot move|already|required before|only a delivery|nothing ready|someone else|not found/i.test(error.message))
      return isoJson({ error: error.message }, { status: 409 });
    return apiError(error);
  }
}
