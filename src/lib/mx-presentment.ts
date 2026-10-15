/**
 * How a keyed card reached us, for MX's POST /payment (https://developer.mxmerchant.com/reference/post-payment).
 * MX treats a keyed payment as card-present unless told otherwise (seen in the sandbox, Oct 2026), so every
 * keyed request says which it is, using the posData objects in MX's API Validation Spreadsheet Guide.
 * Card-present payments go through the reader (MX Terminal API); a card keyed on the POS is a phone order,
 * sent as MX's "Card Not Present – Keyed"; online orders are e-commerce. "pos_keyed" is kept for
 * completeness but isn't used. An authorization (authOnly) is a preauthorization; a sale is final.
 */
export type MxPresentment = "pos_keyed" | "online" | "phone";

export function mxPresentment(kind: MxPresentment, options: { authOnly?: boolean } = {}): {
  cardPresent: boolean;
  authorizationIndicator: "Final" | "Undefined";
  posData: Record<string, string>;
} {
  const where = kind === "pos_keyed"
    ? { cardholderPresence: "Present", deviceAttendance: "Attended", deviceLocation: "OnPremise" }
    : kind === "phone"
      ? { cardholderPresence: "NotPresent", deviceAttendance: "VoiceAru", deviceLocation: "VoiceAru" }
      : { cardholderPresence: "Ecom", deviceAttendance: "HomePc", deviceLocation: "HomePc" };
  return {
    cardPresent: kind === "pos_keyed",
    authorizationIndicator: options.authOnly ? "Undefined" : "Final",
    posData: {
      cardholderPresence: where.cardholderPresence,
      deviceAttendance: where.deviceAttendance,
      deviceInputCapability: "KeyedOnly",
      deviceLocation: where.deviceLocation,
      panCaptureMethod: "Manual",
      // Corner Ops can't take part of a charge on a card and the rest another way.
      partialApprovalSupport: "NotSupported",
      transactionStatus: options.authOnly ? "Preauthorization" : "Normal",
    },
  };
}
