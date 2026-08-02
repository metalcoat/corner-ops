import { ConfigurationError } from "@/lib/config";

export function apiError(error: unknown): Response {
  console.error(error);
  if (error instanceof ConfigurationError) {
    return Response.json({ error: "Application setup is incomplete.", missing: error.missing }, { status: 503 });
  }
  return Response.json({ error: "The request could not be completed." }, { status: 500 });
}

export function unauthorized(): Response {
  return Response.json({ error: "Authentication required." }, { status: 401 });
}
