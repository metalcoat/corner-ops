import { getEmployeeSession } from "@/lib/employee-auth";
import { apiError } from "@/lib/http";
import { listI9Documents, readI9Document, removeI9Document, uploadI9Document } from "@/lib/i9-documents";

export const runtime = "nodejs";
export const maxDuration = 60;

/** The signed-in employee's own I-9 document copies. */
export async function GET(request: Request) {
  try {
    const session = await getEmployeeSession();
    if (!session) return Response.json({ error: "Employee sign-in required." }, { status: 401 });
    const params = new URL(request.url).searchParams;
    const id = params.get("id");
    if (id) {
      const file = await readI9Document({ business: session.business, documentId: id, employeeId: session.employeeId });
      return new Response(new Uint8Array(file.bytes), { headers: { "Content-Type": file.contentType, "Cache-Control": "private, no-store", "Content-Disposition": "inline" } });
    }
    return Response.json(await listI9Documents(session.business, String(params.get("formId") || ""), session.employeeId));
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  try {
    const session = await getEmployeeSession();
    if (!session) return Response.json({ error: "Employee sign-in required." }, { status: 401 });
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return Response.json({ error: "Choose a photo or PDF." }, { status: 400 });
    return Response.json(await uploadI9Document({ business: session.business, employeeId: session.employeeId, formId: String(form.get("formId") || ""), list: form.get("list"), title: form.get("title"), file }), { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}

export async function DELETE(request: Request) {
  try {
    const session = await getEmployeeSession();
    if (!session) return Response.json({ error: "Employee sign-in required." }, { status: 401 });
    return Response.json(await removeI9Document({ business: session.business, employeeId: session.employeeId, documentId: String(new URL(request.url).searchParams.get("id") || "") }));
  } catch (error) {
    return apiError(error);
  }
}
