import { del, put } from "@vercel/blob";
import { canAccessBusiness, getSession } from "@/lib/auth";
import { apiError, unauthorized } from "@/lib/http";
import {
  bulkUpdateDirectoryPins,
  createDirectoryEmployee,
  listDirectoryEmployees,
  updateDirectoryEmployee,
} from "@/lib/employee-directory-admin";
import { setEmployeeProfilePhoto } from "@/lib/employee-profile";
import type { Business } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_PROFILE_PHOTO = 8 * 1024 * 1024;

function businessFrom(value: unknown): Business {
  if (value === "Corner Deli" || value === "Tiki") return value;
  throw new Error("Unknown business.");
}

function roleGroupFrom(value: unknown): "Driver" | "In-House" | "Ignore" | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (value === "Driver" || value === "In-House" || value === "Ignore") return value;
  throw new Error("Invalid employee role group.");
}

function safeFileName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "employee-photo.jpg";
}

function profilePath(business: Business, employeeId: string, fileName: string): string {
  return `employee-profiles/${business === "Corner Deli" ? "corner-deli" : "tiki"}/${employeeId}/${Date.now()}-${safeFileName(fileName)}`;
}

export async function GET(request: Request) {
  try {
    const session = await getSession();
    if (!session) return unauthorized();
    const business = businessFrom(new URL(request.url).searchParams.get("business"));
    if (!canAccessBusiness(session, business)) return Response.json({ error: "Business access denied." }, { status: 403 });
    return Response.json({ employees: await listDirectoryEmployees(business) });
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  let uploadedUrl = "";
  try {
    const session = await getSession();
    if (!session) return unauthorized();
    const contentType = request.headers.get("content-type") || "";

    if (contentType.includes("multipart/form-data")) {
      const form = await request.formData();
      const action = String(form.get("action") || "");
      if (action !== "profile-photo") return Response.json({ error: "Unknown employee upload action." }, { status: 400 });
      const business = businessFrom(form.get("business"));
      if (!canAccessBusiness(session, business)) return Response.json({ error: "Business access denied." }, { status: 403 });
      const employeeId = String(form.get("employeeId") || "");
      const file = form.get("photo");
      if (!(file instanceof File) || !file.size) throw new Error("Choose an employee photo.");
      if (!file.type.toLowerCase().startsWith("image/")) return Response.json({ error: "Employee photos must be image files." }, { status: 415 });
      if (file.size > MAX_PROFILE_PHOTO) return Response.json({ error: "Employee photos are limited to 8 MB." }, { status: 413 });

      const blob = await put(profilePath(business, employeeId, file.name), file, { access: "private", addRandomSuffix: true });
      uploadedUrl = blob.url;
      const result = await setEmployeeProfilePhoto({
        business,
        employeeId,
        url: blob.url,
        pathname: blob.pathname,
        fileName: file.name,
        contentType: file.type || "application/octet-stream",
        size: file.size,
      });
      if (result.previousUrl && result.previousUrl !== blob.url) await del(result.previousUrl).catch(() => undefined);
      return Response.json({ uploaded: true });
    }

    const body = await request.json() as Record<string, unknown>;
    const business = businessFrom(body.business);
    if (!canAccessBusiness(session, business)) return Response.json({ error: "Business access denied." }, { status: 403 });

    const action = String(body.action || "create");
    if (action === "create") {
      return Response.json(await createDirectoryEmployee({
        business,
        email: body.email ? String(body.email) : "",
        phone: body.phone ? String(body.phone) : "",
        smsOptIn: body.smsOptIn === true,
        name: String(body.name || ""),
        pin: String(body.pin || ""),
        position: String(body.position || ""),
        roleGroup: roleGroupFrom(body.roleGroup) || "In-House",
        countsForTips: body.countsForTips !== false,
        hourlyRate: Number(body.hourlyRate || 0),
        tippedRate: Number(body.tippedRate || 0),
      }), { status: 201 });
    }

    if (action === "bulk-pin-update") {
      return Response.json(await bulkUpdateDirectoryPins({
        business,
        lines: String(body.lines || ""),
      }));
    }

    if (action === "update-access" || action === "update-profile") {
      return Response.json(await updateDirectoryEmployee({
        id: String(body.id || ""),
        business,
        email: body.email === undefined ? undefined : String(body.email || ""),
        phone: body.phone === undefined ? undefined : String(body.phone || ""),
        smsOptIn: body.smsOptIn === undefined ? undefined : body.smsOptIn === true,
        pin: body.pin ? String(body.pin) : undefined,
        active: body.active === undefined ? undefined : body.active === true,
        name: body.name === undefined ? undefined : String(body.name || ""),
        position: body.position === undefined ? undefined : String(body.position || ""),
        roleGroup: roleGroupFrom(body.roleGroup),
        countsForTips: body.countsForTips === undefined ? undefined : body.countsForTips === true,
        hourlyRate: body.hourlyRate === undefined ? undefined : Number(body.hourlyRate || 0),
        tippedRate: body.tippedRate === undefined ? undefined : Number(body.tippedRate || 0),
        scheduleColor: body.scheduleColor === undefined ? undefined : String(body.scheduleColor || ""),
      }));
    }

    return Response.json({ error: "Unknown employee directory action." }, { status: 400 });
  } catch (error) {
    if (uploadedUrl) await del(uploadedUrl).catch(() => undefined);
    return apiError(error);
  }
}
