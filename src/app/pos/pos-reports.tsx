"use client";
import { useEffect, useState } from "react";
import type { Business } from "@/lib/types";
import "./pos.css";

type MoneyRow = { label?: string; tender_type?: string; entry_type?: string; sales_cents?: number; payments_cents?: number; reversals_cents?: number; amount_cents?: number; orders?: number; quantity?: number; count?: number };
type Report = { summary: Record<string,number>; tenders: MoneyRow[]; giftCards: MoneyRow[]; salesByServiceType: MoneyRow[]; salesByChannel: MoneyRow[]; salesByCategory: MoneyRow[]; salesByItem: MoneyRow[]; voids: Record<string,number>; openOrderSummary:{count:number;overdueCount:number;amountDueCents:number}; openOrders:Array<{id:string;display_number:string;status:string;service_type:string;amount_due_cents:number;created_at:string;overdue:boolean}>; employeeActions:Array<{event_type:string;actor_id:string;count:number}>; notes:string[]; salesTax?: SalesTax };
type TaxDay = { date:string; orders:number; grossSalesCents:number; taxableSalesCents:number; nonTaxableSalesCents:number; taxCents:number; tipsCents:number };
type SalesTax = { rateBps:number; days:TaxDay[]; refunds:{refundCents:number;taxCents:number}; totals:TaxDay&{netTaxCents:number;taxableSalesExTaxCents:number}; warnings:string[] };
const cents=(value=0)=>new Intl.NumberFormat("en-US",{style:"currency",currency:"USD"}).format(value/100);
const dateKey=(date:Date)=>date.toISOString().slice(0,10);
const label=(value:string)=>value.replaceAll("_"," ").replace(/\b\w/g,(character)=>character.toUpperCase());

function Breakdown({title,rows,valueKey="sales_cents"}:{title:string;rows:MoneyRow[];valueKey?:keyof MoneyRow}) {
  return <section className="posReportCard"><h2>{title}</h2>{rows.length?<div className="posReportRows">{rows.map((row,index)=><div key={`${row.label||row.tender_type||row.entry_type}-${index}`}><span>{label(String(row.label||row.tender_type||row.entry_type||"Other"))}<small>{row.orders!==undefined?`${row.orders} orders`:row.quantity!==undefined?`${row.quantity} sold`:row.count!==undefined?`${row.count} entries`:""}</small></span><strong>{cents(Number(row[valueKey]||0))}</strong></div>)}</div>:<p className="posReportEmpty">No activity in this range.</p>}</section>;
}

const dollars=(value:number)=>(value/100).toFixed(2);
/** Daily sales tax figures for the accountant or the NY sales tax return. */
function downloadTaxCsv(business:string,start:string,end:string,tax:SalesTax){
  const rows=[["Business day","Orders","Gross sales (tax included)","Taxable sales (tax included)","Non-taxable sales","Sales tax collected","Tips (not taxed)"],
    ...tax.days.map(day=>[day.date,String(day.orders),dollars(day.grossSalesCents),dollars(day.taxableSalesCents),dollars(day.nonTaxableSalesCents),dollars(day.taxCents),dollars(day.tipsCents)]),
    ["Total",String(tax.totals.orders),dollars(tax.totals.grossSalesCents),dollars(tax.totals.taxableSalesCents),dollars(tax.totals.nonTaxableSalesCents),dollars(tax.totals.taxCents),dollars(tax.totals.tipsCents)],
    ["Refunds in range","","-"+dollars(tax.refunds.refundCents),"","","-"+dollars(tax.refunds.taxCents),""],
    ["Net sales tax","","","","",dollars(tax.totals.netTaxCents),""],
    ["Taxable sales excluding tax","","","",dollars(tax.totals.taxableSalesExTaxCents),"",""],
    ["Tax rate",`${(tax.rateBps/100).toFixed(3)}%`,"","","","",""]];
  const blob=new Blob([rows.map(row=>row.map(cell=>`"${cell.replaceAll('"','""')}"`).join(",")).join("\n")],{type:"text/csv"});
  const link=document.createElement("a");link.href=URL.createObjectURL(blob);link.download=`${business.replace(/\s+/g,"-").toLowerCase()}-sales-tax-${start}-to-${end}.csv`;link.click();URL.revokeObjectURL(link.href);
}

function SalesTaxCard({business,start,end,tax}:{business:string;start:string;end:string;tax:SalesTax}){
  return <section className="posReportCard posReportTax"><h2>Sales tax</h2>
    {tax.warnings.map(warning=><p key={warning} className="posReportWarning" role="alert">{warning}</p>)}
    <div className="posReportRows">
      <div><span>Taxable sales<small>tax included · rate {(tax.rateBps/100).toFixed(3)}%</small></span><strong>{cents(tax.totals.taxableSalesCents)}</strong></div>
      <div><span>Non-taxable sales</span><strong>{cents(tax.totals.nonTaxableSalesCents)}</strong></div>
      <div><span>Tax collected</span><strong>{cents(tax.totals.taxCents)}</strong></div>
      {tax.refunds.refundCents>0&&<div><span>Tax returned on refunds<small>{cents(tax.refunds.refundCents)} refunded</small></span><strong>-{cents(tax.refunds.taxCents)}</strong></div>}
      <div><span><b>Net sales tax</b><small>taxable sales before tax {cents(tax.totals.taxableSalesExTaxCents)}</small></span><strong>{cents(tax.totals.netTaxCents)}</strong></div>
      <div><span>Tips<small>not taxed</small></span><strong>{cents(tax.totals.tipsCents)}</strong></div>
    </div>
    <button type="button" className="posReportExport" onClick={()=>downloadTaxCsv(business,start,end,tax)} disabled={!tax.days.length}>Download daily CSV</button>
  </section>;
}

export default function PosReports({ business }: { business: Business }) {
  const today=new Date(); const initialEnd=dateKey(today); const initialStart=dateKey(new Date(today.getTime()-6*86400000));
  const [start,setStart]=useState(initialStart),[end,setEnd]=useState(initialEnd),[report,setReport]=useState<Report|null>(null),[error,setError]=useState(""),[loading,setLoading]=useState(true);
  useEffect(()=>{const controller=new AbortController();setLoading(true);setError("");fetch(`/api/ordering/reports?${new URLSearchParams({business,start,end})}`,{cache:"no-store",signal:controller.signal}).then(async response=>{const payload=await response.json();if(!response.ok)throw new Error(payload.error||"Report could not be loaded.");setReport(payload)}).catch(reason=>{if(reason.name!=="AbortError"){setReport(null);setError(reason.message)}}).finally(()=>setLoading(false));return()=>controller.abort()},[business,start,end]);
  const summary=report?.summary||{};
  return <main className="posReportPage"><header className="posReportHeader"><div><p>{business} manager reporting</p><h1>Sales & operations</h1></div><div className="posReportDates"><label>From<input type="date" value={start} max={end} onChange={event=>setStart(event.target.value)}/></label><label>Through<input type="date" value={end} min={start} onChange={event=>setEnd(event.target.value)}/></label></div></header>
    {loading?<div className="posReportState" role="status">Loading authoritative transaction data…</div>:error?<div className="posReportState error" role="alert"><strong>Report unavailable</strong><span>{error}</span></div>:report&&<>
      <section className="posReportMetrics"><article><span>Gross merchandise</span><strong>{cents(summary.gross_merchandise_cents)}</strong></article><article><span>Modifier revenue</span><strong>{cents(summary.modifier_revenue_cents)}</strong></article><article><span>Promotion discounts</span><strong>-{cents(summary.promotion_discount_cents)}</strong></article><article><span>Loyalty discounts</span><strong>-{cents(summary.loyalty_discount_cents)}</strong></article><article><span>Delivery fees</span><strong>{cents(summary.delivery_fees_cents)}</strong></article><article><span>Sales tax (included)</span><strong>{cents(summary.tax_cents)}</strong></article><article><span>Tips</span><strong>{cents(summary.tip_cents)}</strong></article><article><span>Order total</span><strong>{cents(summary.order_total_cents)}</strong><small>{summary.orders||0} finalized orders</small></article></section>
      <section className="posReportAlerts"><article className={report.openOrderSummary.overdueCount?"warning":""}><strong>{report.openOrderSummary.count} open / unpaid</strong><span>{cents(report.openOrderSummary.amountDueCents)} due</span></article><article className={report.openOrderSummary.overdueCount?"danger":""}><strong>{report.openOrderSummary.overdueCount} overdue</strong><span>Open more than 30 minutes</span></article><article><strong>{report.voids.order_voids||0} voided orders</strong><span>{cents(report.voids.voided_order_cents)}</span></article></section>
      <div className="posReportGrid">{report.salesTax&&<SalesTaxCard business={business} start={start} end={end} tax={report.salesTax}/>}<Breakdown title="Tender breakdown" rows={report.tenders} valueKey="payments_cents"/><Breakdown title="Tender reversals" rows={report.tenders.filter(row=>Number(row.reversals_cents)>0)} valueKey="reversals_cents"/><Breakdown title="Gift-card loads & redemptions" rows={report.giftCards} valueKey="amount_cents"/><Breakdown title="Sales by service type" rows={report.salesByServiceType}/><Breakdown title="Sales by channel" rows={report.salesByChannel}/><Breakdown title="Sales by category" rows={report.salesByCategory}/><Breakdown title="Sales by item" rows={report.salesByItem}/>
      <section className="posReportCard"><h2>Employee operational actions</h2>{report.employeeActions.length?<div className="posReportRows">{report.employeeActions.map((row,index)=><div key={`${row.actor_id}-${row.event_type}-${index}`}><span>{row.actor_id||"Unknown actor"}<small>{label(row.event_type)}</small></span><strong>{row.count}</strong></div>)}</div>:<p className="posReportEmpty">No employee actions in this range.</p>}</section></div>
      {report.openOrders.length>0&&<section className="posReportCard posReportOpen"><h2>Open and unpaid orders</h2><div className="posReportRows">{report.openOrders.map(order=><div className={order.overdue?"overdue":""} key={order.id}><span>#{order.display_number||order.id.slice(0,8)} · {label(order.service_type)}<small>{label(order.status)} · {new Date(order.created_at).toLocaleString()}</small></span><strong>{cents(order.amount_due_cents)}</strong></div>)}</div></section>}
      <footer className="posReportNotes">{report.notes.map(note=><span key={note}>{note}</span>)}</footer></>}
  </main>;
}
