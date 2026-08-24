export function requestFailure(response: Response): string {
  return `Request failed (${response.status}).`;
}

export async function responseMessage(response: Response): Promise<string> {
  const payload = await response.json().catch(() => null) as { error?: string } | null;
  return payload?.error || requestFailure(response);
}
