import CustomerOrder from "../../order/customer-order";
import "../../order/order.css";
import "./kiosk.css";
export const metadata={title:"Corner Deli Kiosk"};
export default function DeliKioskPage(){return <main className="deliKiosk"><div className="kioskBanner"><strong>CORNER DELI SELF-SERVICE</strong><span>Touch an item to begin your order</span></div><CustomerOrder/></main>}
