// NANP area codes outside the US and Canada (Caribbean and Atlantic islands),
// where texts are billed at premium rates and the deli has no customers.
const NON_US_CANADA_AREA_CODES = new Set([
  "242", "246", "264", "268", "284", "345", "441", "473", "649", "658", "664",
  "721", "758", "767", "784", "809", "829", "849", "868", "869", "876",
]);

/** Accepts a normalized +1 number only when it is a US or Canadian line. */
export function usOrCanadaMobile(phone: string): boolean {
  const match = /^\+1(\d{3})\d{7}$/.exec(phone);
  return Boolean(match && !NON_US_CANADA_AREA_CODES.has(match[1]) && !/^[01]/.test(match[1]));
}
