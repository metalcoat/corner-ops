/**
 * How a keyed card reached us, for MX's POST /payment (https://developer.mxmerchant.com/reference/post-payment).
 * MX treats a keyed payment as card-present unless told otherwise (seen in the sandbox, Oct 2026), so every
 * keyed request says which it is. Card-present payments go through the reader (MX Terminal API); a card
 * keyed on the POS is treated as read over the phone, and online orders are e-commerce. "pos_keyed" is kept
 * for completeness but isn't used.
 */
export type MxPresentment = "pos_keyed" | "online" | "phone";

const COMMON = { deviceInputCapability: "KeyedOnly", panCaptureMethod: "Manual", partialApprovalSupport: "NotSupported", pinCaptureCapability: "Incapable" };

export function mxPresentment(kind: MxPresentment): { cardPresent: boolean; posData: Record<string, string> } {
  if (kind === "pos_keyed") return { cardPresent: true, posData: { cardholderPresence: "Present", deviceAttendance: "Attended", deviceLocation: "OnPremise", ...COMMON } };
  if (kind === "phone") return { cardPresent: false, posData: { cardholderPresence: "Phone", deviceAttendance: "VoiceAru", deviceLocation: "VoiceAru", ...COMMON } };
  return { cardPresent: false, posData: { cardholderPresence: "Ecom", deviceAttendance: "HomePc", deviceLocation: "HomePc", ...COMMON } };
}
