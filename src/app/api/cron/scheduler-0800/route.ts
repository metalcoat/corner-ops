import { handleCronRequest } from "@/lib/scheduler";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(request: Request) {
  return handleCronRequest(request);
}
