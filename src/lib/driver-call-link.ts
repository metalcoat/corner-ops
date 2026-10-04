// How the driver tablet places calls. The default tel: link opens whatever app
// the tablet uses for calls; with the 3CX app set as the default calling app,
// calls go out through the deli's 3CX system and show the deli's caller ID.
export const DEFAULT_CALL_LINK_TEMPLATE = "tel:{phone}";

/** Only dialer-style links: tel:, callto:, sip:, or an https 3CX web client link. */
export function validCallLinkTemplate(value: string) {
  const template = value.trim();
  if (!template.includes("{phone}") || template.length > 300) return false;
  return /^(tel|callto|sip|sips):/i.test(template) || /^https:\/\/[^\s/]+\//i.test(template);
}

export function callLink(template: string, phone: string) {
  const digits = phone.replace(/[^\d+]/g, "");
  if (!digits) return null;
  const safe = validCallLinkTemplate(template) ? template.trim() : DEFAULT_CALL_LINK_TEMPLATE;
  return safe.replaceAll("{phone}", encodeURIComponent(digits));
}
