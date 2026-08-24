import { ConfigurationError } from "@/lib/config";

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export class AuthenticationError extends Error {
  constructor(message = "Authentication required.") {
    super(message);
    this.name = "AuthenticationError";
  }
}

export class PermissionError extends Error {
  constructor(message = "Your account does not have permission for this action.") {
    super(message);
    this.name = "PermissionError";
  }
}

export class RateLimitError extends Error {
  retryAfterSeconds: number;

  constructor(message: string, retryAfterSeconds: number) {
    super(message);
    this.name = "RateLimitError";
    this.retryAfterSeconds = Math.max(1, Math.ceil(retryAfterSeconds));
  }
}

export function apiError(error: unknown): Response {
  if (error instanceof ConfigurationError) {
    console.error(error);
    return Response.json({ error: "Application setup is incomplete.", missing: error.missing }, { status: 503 });
  }
  if (error instanceof RateLimitError) {
    return Response.json(
      { error: error.message, retryAfterSeconds: error.retryAfterSeconds },
      { status: 429, headers: { "Retry-After": String(error.retryAfterSeconds) } },
    );
  }
  if (error instanceof AuthenticationError) {
    return Response.json({ error: error.message }, { status: 401 });
  }
  if (error instanceof PermissionError) {
    return Response.json({ error: error.message }, { status: 403 });
  }
  if (error instanceof ValidationError) {
    return Response.json({ error: error.message }, { status: 400 });
  }
  console.error(error);
  return Response.json({ error: "The request could not be completed." }, { status: 500 });
}

export function unauthorized(message = "Authentication required."): Response {
  return Response.json({ error: message }, { status: 401 });
}
