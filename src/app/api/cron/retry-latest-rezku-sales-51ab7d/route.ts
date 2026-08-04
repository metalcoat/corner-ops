import { createHash } from "node:crypto";
import { getSql } from "@/lib/db";
import { ensureRezkuProductSalesSchema } from "@/lib/rezku-product-sales";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const BUSINESS_DATE = "2026-08-03";
const ROWS = [["Beverage","20oz Cool Blue Gatorade",2.75,2.54,3,7.62,0.006899674031148135],["Beverage","20 oz Mountain Dew Code Red",2.75,2.54,1,2.54,0.002299891343716045],["Beverage","20 Oz Pepsi",2.75,2.54,1,2.54,0.002299891343716045],["Beverage","2L Diet Mountain Dew",3.5,3.24,2,6.48,0.005867439333574791],["Beverage","2L Diet Pepsi",3.5,3.24,2,6.48,0.005867439333574791],["Beverage","2L Mountain Dew",3.5,3.24,2,6.48,0.005867439333574791],["Beverage","2L Orange",3.5,3.1,2,6.2,0.005613908004346252],["Food","$1",1,0.92,4,3.68,0.003332126041289388],["Food","4 oz Marinara",1.75,1.62,2,3.24,0.002933719666787396],["Food","4 oz Mild",1.75,1.62,1,1.62,0.001466859833393698],["Food","4 oz Sweet & Sassy",1.75,1.62,1,1.62,0.001466859833393698],["Food","AntiPasto",0,7,1,7,0.006338283230713509],["Food","Baked Beans",0,3.5,1,3.5,0.003169141615356755],["Food","Blue Balls",7.5,6.94,1,6.94,0.006283955088735966],["Food","Blue Cheese (4oz)",1.75,1.62,5,8.1,0.00733429916696849],["Food","Breaded Mushrooms",6.5,6.01,1,6.01,0.005441868888084027],["Food","Buffalo Chips",8,7.865,2,15.73,0.01424302788844621],["Food","Cheeseburger (1/4lbs)",7.25,10.736,5,53.68,0.04860557768924303],["Food","Chocolate Overload",6.5,6.01,1,6.01,0.005441868888084027],["Food","Cole Slaw",0,6.5,1,6.5,0.005885548714233973],["Food","Fathead Special",13,12.03,2,24.06,0.02178558493299529],["Food","Ham",0,13.65,1,13.65,0.01235965229989134],["Food","Hamburger",0,12.03,1,12.03,0.01089279246649765],["Food","Ham Sandwich",5,5.09,1,5.09,0.004608837377761681],["Food","Hot Sausage",0,5.55,1,5.55,0.005025353132922854],["Food","Humpty Dumpty Ketchup Chips",4,4,2,8,0.007243752263672582],["Food","Humpty Dumpty Salt & Vinegar",4,4,1,4,0.003621876131836291],["Food","Julienne Sal",11.5,11.34,1,11.34,0.01026801883375589],["Food","Kit Kat",2,1.85,1,1.85,0.001675117710974285],["Food","Large Curly Fries",3.75,3.47,1,3.47,0.003141977544367983],["Food","Large French Fries",3.5,4.952,5,24.76,0.02241941325606664],["Food","LG Tossed Sal",6,6.476666666666667,3,19.43,0.01759326331039478],["Food","Mac Salad",0,5,2,10,0.009054690329590729],["Food","Milky Caramel Mile High Cake",7,6.48,1,6.48,0.005867439333574791],["Food","Mixed Italian",0,9.49,1,9.49,0.008592901122781601],["Food","Mozzarella Sticks",8,7.4,5,37,0.03350235421948569],["Food","Nacho Supreme",11,11.11,1,11.11,0.0100597609561753],["Food","Pasta Salad",0,7.75,2,15.5,0.01403477001086563],["Food","Pizza",0,17.0275,16,272.44,0.2466859833393698],["Food","Pizza Logs",8,7.4,1,7.4,0.006700470843897139],["Food","Potato Salad",0,7,4,28,0.02535313292285404],["Food","Roast Beef",0,11.57,1,11.57,0.01047627671133647],["Food","Roast Beef Sandwich",5.5,5.55,10,55.5,0.05025353132922854],["Food","Spaghetti",10,9.87,3,29.61,0.02681093806591815],["Food","Spaghetti Supreme",15.5,14.35,1,14.35,0.0129934806229627],["Food","Steak",0,10.64,2,21.28,0.01926838102136907],["Food","Turkey",0,10.18,1,10.18,0.009217674755523361],["Food","Turkey Big Boss",0,10.87,1,10.87,0.009842448388265122],["Food","Turkey Sandwich",5,5.09,15,76.35,0.0691325606664252],["Food","Wings",0,16.55181818181818,11,182.07,0.1648587468308584]] as const;

function sourceKey(category: string, product: string) {
  return createHash("sha256")
    .update(["rezku-sales-by-product", BUSINESS_DATE, category.toLowerCase(), product.toLowerCase()].join("|"))
    .digest("hex");
}

export async function GET() {
  await ensureRezkuProductSalesSchema();
  const sql = getSql();
  const batchId = crypto.randomUUID();
  await sql`
    INSERT INTO rezku_product_sales_import_batches (
      id, report_type, business_date, file_name, row_count, imported_by
    ) VALUES (
      ${batchId}, 'sales_by_product', ${BUSINESS_DATE}, 'sales-by-product.xlsx',
      ${ROWS.length}, 'Attached workbook one-time import'
    )
  `;
  await sql`DELETE FROM rezku_product_sales WHERE business_date = ${BUSINESS_DATE}::date`;

  for (const [category, product, listPrice, averagePrice, quantity, sales, percentSales] of ROWS) {
    await sql`
      INSERT INTO rezku_product_sales (
        id, source_key, batch_id, business_date, category, product,
        list_price, average_price, quantity, sales, percent_sales,
        average_profit, profit, percent_profit, raw
      ) VALUES (
        ${crypto.randomUUID()}, ${sourceKey(category, product)}, ${batchId}, ${BUSINESS_DATE},
        ${category}, ${product}, ${listPrice}, ${averagePrice}, ${quantity}, ${sales},
        ${percentSales}, 0, 0, 0,
        ${JSON.stringify({ category, product, listPrice, averagePrice, quantity, sales, percentSales })}::jsonb
      )
    `;
  }

  const summary = await sql`
    SELECT COUNT(*)::INTEGER AS rows,
      COALESCE(SUM(quantity), 0) AS quantity,
      COALESCE(SUM(sales), 0) AS sales
    FROM rezku_product_sales
    WHERE business_date = ${BUSINESS_DATE}::date
  ` as unknown as Array<{ rows: number; quantity: string; sales: string }>;
  return Response.json({ batchId, businessDate: BUSINESS_DATE, ...summary[0] });
}
