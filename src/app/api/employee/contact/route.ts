import { getEmployeeSession } from "@/lib/employee-auth";
import { listDirectoryEmployees, updateDirectoryEmployee } from "@/lib/employee-directory-admin";
import { apiError, unauthorized } from "@/lib/http";

export const runtime = "nodejs";

export async function GET() {
  try {
    const session = await getEmployeeSession();
    if (!session) return unauthorized();
    const employees = await listDirectoryEmployees(session.business);
    const employee = employees.find((candidate) => candidate.id === session.employeeId);
    if (!employee) return Response.json({ error: "Employee record not found." }, { status: 404 });
    return Response.json({ email: employee.email || "" });
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  try {
    const session = await getEmployeeSession();
    if (!session) return unauthorized();
    const body = await request.json() as { email?: unknown };
    const email = String(body.email || "").trim().toLowerCase();
    if (!email) throw new Error("Enter your email address.");
    const employee = await updateDirectoryEmployee({
      id: session.employeeId,
      business: session.business,
      email,
    });
    return Response.json({ email: employee.email });
  } catch (error) {
    return apiError(error);
  }
}
