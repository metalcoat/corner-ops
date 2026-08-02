import { upsertDirectoryEmployees, type DirectoryEmployeeInput } from "@/lib/employee-directory";
import { apiError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SETUP_TOKEN = "k_dvSZhBkLlL4Ml5-nvHIqaB6D64ehfx";

export async function GET(request: Request) {
  try {
    if (process.env.VERCEL_ENV !== "preview") {
      return Response.json({ error: "Setup route is preview-only." }, { status: 403 });
    }

    const url = new URL(request.url);
    if (url.searchParams.get("token") !== SETUP_TOKEN) {
      return Response.json({ error: "Setup token is invalid." }, { status: 403 });
    }

    const encoded = url.searchParams.get("payload");
    if (!encoded) throw new Error("Employee payload is required.");
    const decoded = Buffer.from(encoded, "base64url").toString("utf8");
    const employees = JSON.parse(decoded) as DirectoryEmployeeInput[];
    if (!Array.isArray(employees) || employees.length < 1 || employees.length > 20) {
      throw new Error("Employee payload must contain between 1 and 20 records.");
    }

    return Response.json(await upsertDirectoryEmployees(employees));
  } catch (error) {
    return apiError(error);
  }
}
