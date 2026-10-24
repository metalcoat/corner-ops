// What search engines read about Corner Deli on the public ordering site:
// page title/description and schema.org Restaurant data (name, address,
// phone, hours, menu link), so "pizza Ogdensburg" / "deli Ogdensburg" searches
// can show the store with its hours and an order link. Keep the address,
// phone and hours identical to the Google Business Profile.
import { GREETER_HOURS, WEEKDAYS } from "@/lib/greeter-hours";

export const CUSTOMER_SITE_URL = "https://ordercornerdeli.com";
export const STORE_NAME = "Corner Deli";
export const STORE_PHONE = "+1-315-393-2271";
export const STORE_ADDRESS = { street: "828 Morris St", city: "Ogdensburg", region: "NY", postalCode: "13669", country: "US" };

export const ORDER_PAGE_TITLE = "Corner Deli | Pizza, Subs & Wings in Ogdensburg, NY | Order Online";
export const ORDER_PAGE_DESCRIPTION =
  "Order Corner Deli online for pickup or delivery in Ogdensburg, NY: pizza, wings, subs, wraps, burgers, deli platters and catering. 828 Morris St, (315) 393-2271.";

export function restaurantJsonLd() {
  return {
    "@context": "https://schema.org",
    "@type": "Restaurant",
    "@id": `${CUSTOMER_SITE_URL}/#restaurant`,
    name: STORE_NAME,
    url: CUSTOMER_SITE_URL,
    telephone: STORE_PHONE,
    image: `${CUSTOMER_SITE_URL}/corner-deli-logo.png`,
    logo: `${CUSTOMER_SITE_URL}/corner-deli-logo.png`,
    servesCuisine: ["Pizza", "Wings", "Subs", "Sandwiches", "Deli", "American"],
    priceRange: "$",
    acceptsReservations: false,
    hasMenu: `${CUSTOMER_SITE_URL}/order`,
    address: {
      "@type": "PostalAddress",
      streetAddress: STORE_ADDRESS.street,
      addressLocality: STORE_ADDRESS.city,
      addressRegion: STORE_ADDRESS.region,
      postalCode: STORE_ADDRESS.postalCode,
      addressCountry: STORE_ADDRESS.country,
    },
    areaServed: { "@type": "City", name: "Ogdensburg, NY" },
    openingHoursSpecification: GREETER_HOURS.flatMap((day, index) =>
      day ? [{ "@type": "OpeningHoursSpecification", dayOfWeek: `https://schema.org/${WEEKDAYS[index]}`, opens: day.opens, closes: day.closes }] : []),
    potentialAction: {
      "@type": "OrderAction",
      target: { "@type": "EntryPoint", urlTemplate: `${CUSTOMER_SITE_URL}/order`, actionPlatform: ["https://schema.org/DesktopWebPlatform", "https://schema.org/MobileWebPlatform"] },
      deliveryMethod: ["http://purl.org/goodrelations/v1#DeliveryModePickUp", "http://purl.org/goodrelations/v1#DeliveryModeOwnFleet"],
    },
  };
}
