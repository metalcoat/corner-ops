export function giftCardNumberFromInput(value: string): string {
  const raw = String(value || "").trim();
  const track2 = raw.match(/;([A-Za-z0-9]{8,64})[=D?]/);
  if (track2?.[1]) return track2[1].toUpperCase();
  const track1 = raw.match(/%B([A-Za-z0-9]{8,64})\^/i);
  if (track1?.[1]) return track1[1].toUpperCase();
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function validGiftCardInput(value: string): boolean {
  return giftCardNumberFromInput(value).length >= 8;
}
