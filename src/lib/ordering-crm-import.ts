import { createHash, randomUUID } from "node:crypto";
import * as XLSX from "xlsx";
import { getSql } from "@/lib/db";
import { ensureOrderingCustomerSchema } from "@/lib/ordering-customer-schema";
import { displayPhone, mergeCustomers } from "@/lib/ordering-customers";
import { normalizeCallerPhone, type OrderingBusiness } from "@/lib/ordering-core";

type RawRow=Record<string,unknown>;
type Contact={first:string;last:string;phones:string[];emails:string[];addresses:Array<{line1:string;line2:string;city:string;state:string;postalCode:string}>;notes:string[];sourceRow:number};
type Group={contacts:Contact[];phones:string[];emails:string[];addresses:Contact["addresses"];first:string;last:string;notes:string[]};
const emailPattern=/^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const clean=(value:unknown)=>String(value??"").trim();
const key=(value:unknown)=>clean(value).toLowerCase().replace(/[^a-z0-9]/g,"");
const cell=(row:RawRow,...names:string[])=>{const entries=Object.entries(row);for(const name of names){const found=entries.find(([header])=>key(header)===key(name));if(found)return clean(found[1])}return ""};

function contactsFromFile(bytes:Buffer){
  const workbook=XLSX.read(bytes,{type:"buffer",raw:false}),sheet=workbook.Sheets[workbook.SheetNames[0]];
  if(!sheet)throw new Error("The CRM file does not contain a worksheet.");
  const rows=XLSX.utils.sheet_to_json<RawRow>(sheet,{defval:""});
  if(rows.length>20_000)throw new Error("CRM imports are limited to 20,000 rows at a time.");
  return rows.map((row,index)=>{
    const first=cell(row,"First Name","First","Given Name"),last=cell(row,"Last Name","Last","Surname"),full=cell(row,"Full Name","Customer Name","Name");
    const parts=!first&&full?full.split(/\s+/):[],resolvedFirst=first||parts.shift()||"",resolvedLast=last||parts.join(" ");
    const phones=Object.entries(row).filter(([header])=>/phone|mobile|telephone/i.test(header)).map(([,value])=>normalizeCallerPhone(clean(value))).filter(value=>/^\+1\d{10}$/.test(value));
    const emails=Object.entries(row).filter(([header])=>/e.?mail/i.test(header)).map(([,value])=>clean(value).toLowerCase()).filter(value=>emailPattern.test(value));
    const line1=cell(row,"Address","Address 1","Street","Street Address"),line2=cell(row,"Address 2","Apt","Apartment","Unit"),city=cell(row,"City"),state=cell(row,"State","Province"),postalCode=cell(row,"Postal Code","Zip","Zip Code");
    const addresses=line1&&city&&state&&postalCode?[{line1,line2,city,state,postalCode}]:[];
    const notes=[cell(row,"Notes","Note")];
    const birthday=[cell(row,"Birth Month"),cell(row,"Birth Day")].filter(Boolean).join("/");if(birthday)notes.push(`Birthday: ${birthday}`);
    const anniversary=[cell(row,"Anniversary Month"),cell(row,"Anniversary Day")].filter(Boolean).join("/");if(anniversary)notes.push(`Anniversary: ${anniversary}`);
    const points=cell(row,"Points");if(points)notes.push(`Legacy points: ${points}`);
    return{first:resolvedFirst,last:resolvedLast,phones:[...new Set(phones)],emails:[...new Set(emails)],addresses,notes:notes.filter(Boolean),sourceRow:index+2};
  }).filter(contact=>contact.first||contact.last||contact.phones.length||contact.emails.length||contact.addresses.length);
}

function groupContacts(contacts:Contact[]):Group[]{
  const parent=contacts.map((_,index)=>index),find=(x:number):number=>parent[x]===x?x:(parent[x]=find(parent[x])),join=(a:number,b:number)=>{a=find(a);b=find(b);if(a!==b)parent[b]=a};
  const identities=new Map<string,number>();
  contacts.forEach((contact,index)=>{
    const address=contact.addresses[0],name=key(`${contact.first}${contact.last}`);
    const keys=[...contact.phones.map(value=>`p:${value}`),...contact.emails.map(value=>`e:${value}`)];
    if(name&&address)keys.push(`na:${name}:${key(address.line1)}:${key(address.postalCode)}`);
    for(const identity of keys){const prior=identities.get(identity);if(prior===undefined)identities.set(identity,index);else join(index,prior)}
  });
  const grouped=new Map<number,Contact[]>();contacts.forEach((contact,index)=>{const root=find(index);(grouped.get(root)||grouped.set(root,[]).get(root)!).push(contact)});
  return [...grouped.values()].map(rows=>{
    const names=new Map<string,{first:string;last:string;count:number}>();for(const row of rows){const k=key(`${row.first}${row.last}`);if(k){const current=names.get(k);if(current)current.count++;else names.set(k,{first:row.first,last:row.last,count:1})}}
    const chosen=[...names.values()].sort((a,b)=>b.count-a.count||(b.first.length+b.last.length)-(a.first.length+a.last.length))[0]||{first:"Customer",last:"",count:1};
    const addresses=new Map<string,{address:Contact["addresses"][number];count:number}>();for(const row of rows)for(const address of row.addresses){const addressKey=`${key(address.line1)}|${key(address.line2)}|${key(address.postalCode)}`,current=addresses.get(addressKey);if(current)current.count++;else addresses.set(addressKey,{address,count:1})}
    return{contacts:rows,phones:[...new Set(rows.flatMap(row=>row.phones))],emails:[...new Set(rows.flatMap(row=>row.emails))],addresses:[...addresses.values()].sort((a,b)=>b.count-a.count).map(value=>value.address),first:chosen.first,last:chosen.last,notes:[...new Set(rows.flatMap(row=>row.notes))]};
  });
}

export function previewCrmImport(bytes:Buffer){
  const contacts=contactsFromFile(bytes),groups=groupContacts(contacts);
  return{sourceRows:contacts.length,customerGroups:groups.length,duplicatesCollapsed:contacts.length-groups.length,phones:[...new Set(groups.flatMap(group=>group.phones))].length,emails:[...new Set(groups.flatMap(group=>group.emails))].length,addresses:groups.reduce((sum,group)=>sum+group.addresses.length,0),sample:groups.slice(0,8).map(group=>({name:`${group.first} ${group.last}`.trim(),rows:group.contacts.length,phones:group.phones.map(displayPhone),emails:group.emails,addresses:group.addresses.map(address=>`${address.line1}${address.line2?`, ${address.line2}`:""}, ${address.city}, ${address.state} ${address.postalCode}`)}))};
}

export async function applyCrmImport(input:{business:OrderingBusiness;bytes:Buffer;fileName:string;actorId:string}){
  await ensureOrderingCustomerSchema();const hash=createHash("sha256").update(input.bytes).digest("hex"),sql=getSql();
  const prior=(await sql`SELECT * FROM ordering_crm_import_batches WHERE business=${input.business} AND file_hash=${hash}`)[0];if(prior)return{duplicateBatch:true,batch:prior};
  const contacts=contactsFromFile(input.bytes),groups=groupContacts(contacts);let created=0,updated=0,merged=0;
  for(const group of groups){
    const matches=await sql`SELECT DISTINCT c.id,c.created_at FROM ordering_customers c LEFT JOIN ordering_customer_phones p ON p.customer_id=c.id LEFT JOIN ordering_customer_emails e ON e.customer_id=c.id WHERE c.business=${input.business} AND c.active=TRUE AND c.merged_into_customer_id IS NULL AND (p.normalized_phone=ANY(${group.phones.length?group.phones:["__none__"]}::text[]) OR e.normalized_email=ANY(${group.emails.length?group.emails:["__none__"]}::text[])) ORDER BY c.created_at,c.id`;
    let customerId=matches[0]?.id as string|undefined;
    if(customerId){for(const duplicate of matches.slice(1)){await mergeCustomers({business:input.business,survivorId:customerId,mergedId:String(duplicate.id),actorId:input.actorId});merged++}updated++}
    else{customerId=randomUUID();await sql`INSERT INTO ordering_customers(id,business,display_name,first_name,last_name,email,notes)VALUES(${customerId},${input.business},${`${group.first} ${group.last}`.trim()||"Customer"},${group.first||"Customer"},${group.last},${group.emails[0]||""},${group.notes.join("\n")})`;created++}
    for(const phone of group.phones)await sql`INSERT INTO ordering_customer_phones(id,customer_id,normalized_phone,display_phone,label,is_primary)VALUES(${randomUUID()},${customerId},${phone},${displayPhone(phone)},'Imported',FALSE) ON CONFLICT(customer_id,normalized_phone)DO NOTHING`;
    for(const email of group.emails)await sql`INSERT INTO ordering_customer_emails(id,customer_id,normalized_email,display_email,label,is_primary)VALUES(${randomUUID()},${customerId},${email},${email},'Imported',FALSE) ON CONFLICT(customer_id,normalized_email)DO NOTHING`;
    for(const address of group.addresses)await sql`INSERT INTO ordering_customer_addresses(id,customer_id,label,line1,line2,city,state,postal_code,standardized_address,provider,is_primary)SELECT ${randomUUID()},${customerId},'Imported',${address.line1},${address.line2},${address.city},${address.state},${address.postalCode},${`${address.line1}, ${address.city}, ${address.state} ${address.postalCode}`},'legacy_crm',FALSE WHERE NOT EXISTS(SELECT 1 FROM ordering_customer_addresses existing WHERE existing.customer_id=${customerId} AND existing.active=TRUE AND lower(existing.line1)=lower(${address.line1}) AND lower(existing.line2)=lower(${address.line2}) AND existing.postal_code=${address.postalCode})`;
    await sql`UPDATE ordering_customer_phones SET is_primary=TRUE,updated_at=NOW() WHERE id=(SELECT id FROM ordering_customer_phones WHERE customer_id=${customerId} ORDER BY created_at LIMIT 1) AND NOT EXISTS(SELECT 1 FROM ordering_customer_phones WHERE customer_id=${customerId} AND is_primary=TRUE)`;
    await sql`UPDATE ordering_customer_emails SET is_primary=TRUE,updated_at=NOW() WHERE id=(SELECT id FROM ordering_customer_emails WHERE customer_id=${customerId} ORDER BY created_at LIMIT 1) AND NOT EXISTS(SELECT 1 FROM ordering_customer_emails WHERE customer_id=${customerId} AND is_primary=TRUE)`;
    await sql`UPDATE ordering_customer_addresses SET is_primary=TRUE,updated_at=NOW() WHERE id=(SELECT id FROM ordering_customer_addresses WHERE customer_id=${customerId} AND active=TRUE ORDER BY CASE WHEN provider='legacy_crm' THEN 0 ELSE 1 END,created_at LIMIT 1) AND NOT EXISTS(SELECT 1 FROM ordering_customer_addresses WHERE customer_id=${customerId} AND active=TRUE AND is_primary=TRUE)`;
    await sql`UPDATE ordering_customers SET email=COALESCE((SELECT display_email FROM ordering_customer_emails WHERE customer_id=${customerId} ORDER BY is_primary DESC,created_at LIMIT 1),email),updated_at=NOW() WHERE id=${customerId}`;
  }
  const id=randomUUID(),details={duplicatesCollapsed:contacts.length-groups.length,phones:[...new Set(groups.flatMap(group=>group.phones))].length,emails:[...new Set(groups.flatMap(group=>group.emails))].length,addresses:groups.reduce((sum,group)=>sum+group.addresses.length,0)};
  const batch=(await sql`INSERT INTO ordering_crm_import_batches(id,business,file_name,file_hash,source_rows,customer_groups,created_customers,updated_customers,merged_customers,imported_by,details)VALUES(${id},${input.business},${input.fileName.slice(0,200)},${hash},${contacts.length},${groups.length},${created},${updated},${merged},${input.actorId},${JSON.stringify(details)}::jsonb)RETURNING *`)[0];
  return{duplicateBatch:false,batch};
}
