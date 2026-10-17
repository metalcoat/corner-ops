import CustomerDisplayClient from "../../pos/deli/customer-display/customer-display-client";
import "../../pos/deli/customer-display/customer-display.css";
export const metadata={
  title:"Corner Deli Customer Display",
  manifest:"/display/deli/manifest.webmanifest",
  applicationName:"Corner Deli Customer Display",
  appleWebApp:{capable:true,title:"Deli Customer Display",statusBarStyle:"black-translucent" as const},
};
export default function DeliCustomerDisplayPage(){return <CustomerDisplayClient/>}
