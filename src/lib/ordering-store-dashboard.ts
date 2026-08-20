import { getSql } from "@/lib/db";
import { syncDeliveryAssignments } from "@/lib/ordering-driver-delivery";

export async function orderingStoreDashboard(){
  await syncDeliveryAssignments("Corner Deli");
  const sql=getSql();
  const [summary,timedOrders,deliveries,activity]=await Promise.all([
    sql`SELECT
      COUNT(*) FILTER(WHERE created_at>=(CURRENT_DATE AT TIME ZONE 'America/New_York'))::int orders_today,
      COUNT(*) FILTER(WHERE status NOT IN('completed','cancelled'))::int open_orders,
      COUNT(*) FILTER(WHERE timing_mode='future' AND scheduled_for>=NOW() AND scheduled_for<NOW()+INTERVAL '4 hours' AND status NOT IN('completed','cancelled'))::int timed_upcoming,
      COUNT(*) FILTER(WHERE amount_due_cents>0 AND status NOT IN('completed','cancelled'))::int unpaid_open,
      COALESCE(SUM(total_cents) FILTER(WHERE created_at>=(CURRENT_DATE AT TIME ZONE 'America/New_York') AND status<>'cancelled'),0)::int sales_cents
      FROM ordering_orders WHERE business='Corner Deli'`,
    sql`SELECT id,display_number,status,service_type,scheduled_for,COALESCE(NULLIF(trim(first_name_snapshot||' '||last_name_snapshot),''),'Guest') customer_name
      FROM ordering_orders WHERE business='Corner Deli' AND timing_mode='future' AND scheduled_for>=NOW()-INTERVAL '30 minutes' AND scheduled_for<NOW()+INTERVAL '8 hours' AND status NOT IN('completed','cancelled') ORDER BY scheduled_for LIMIT 30`,
    sql`SELECT d.id delivery_id,d.status,d.driver_employee_id,d.assigned_at,d.picked_up_at,d.en_route_at,d.arrived_at,d.delivered_at,d.failed_at,d.updated_at,
      o.display_number,o.status order_status,o.scheduled_for,COALESCE(NULLIF(trim(o.first_name_snapshot||' '||o.last_name_snapshot),''),'Guest') customer_name,e.name driver_name
      FROM ordering_delivery_assignments d JOIN ordering_orders o ON o.id=d.order_id LEFT JOIN employees e ON e.id=d.driver_employee_id
      WHERE d.business='Corner Deli' AND (d.status NOT IN('DELIVERED','RETURNED','CANCELLED') OR d.updated_at>=(CURRENT_DATE AT TIME ZONE 'America/New_York'))
      ORDER BY CASE d.status WHEN 'DELIVERY_FAILED' THEN 0 WHEN 'NO_CONTACT' THEN 1 WHEN 'EN_ROUTE' THEN 2 WHEN 'READY_FOR_DRIVER' THEN 3 ELSE 4 END,COALESCE(o.scheduled_for,o.created_at) LIMIT 60`,
    sql`SELECT a.id,a.action,a.new_status,a.created_at,o.display_number,e.name employee_name
      FROM ordering_delivery_audit a JOIN ordering_orders o ON o.id=a.order_id LEFT JOIN employees e ON e.id=a.employee_id
      WHERE o.business='Corner Deli' AND a.created_at>=(CURRENT_DATE AT TIME ZONE 'America/New_York') ORDER BY a.created_at DESC LIMIT 30`
  ]);
  const deliveryRows=deliveries as Array<Record<string,unknown>>;
  const tasks=[
    {key:"unassigned",label:"Deliveries waiting for a driver",count:deliveryRows.filter(d=>!d.driver_employee_id&&!['DELIVERED','RETURNED','CANCELLED'].includes(String(d.status))).length,href:"/employee/deliveries?dispatch=1"},
    {key:"ready",label:"Ready orders waiting for pickup",count:deliveryRows.filter(d=>d.status==="READY_FOR_DRIVER").length,href:"/employee/deliveries?dispatch=1"},
    {key:"problems",label:"Delivery problems needing attention",count:deliveryRows.filter(d=>['NO_CONTACT','DELIVERY_FAILED'].includes(String(d.status))).length,href:"/employee/deliveries?dispatch=1"},
    {key:"timed",label:"Timed orders due within four hours",count:Number(summary[0]?.timed_upcoming||0),href:"/pos/deli/orders"},
    {key:"unpaid",label:"Open orders with a balance",count:Number(summary[0]?.unpaid_open||0),href:"/pos/deli/orders"}
  ];
  return{generatedAt:new Date().toISOString(),summary:summary[0],tasks,timedOrders,deliveries,activity};
}
