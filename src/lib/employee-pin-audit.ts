import { randomUUID } from "node:crypto";
import { getSql } from "@/lib/db";
import type { Business } from "@/lib/types";

export async function recordEmployeePinAudit(input:{employeeId:string;business:Business;action:"pin_assigned"|"pin_changed"|"pin_reset";actor:string}){
  const sql=getSql();
  await sql`CREATE TABLE IF NOT EXISTS employee_pin_audit (id UUID PRIMARY KEY,employee_id UUID NOT NULL REFERENCES employees(id),business TEXT NOT NULL,action TEXT NOT NULL,actor TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`;
  await sql`INSERT INTO employee_pin_audit(id,employee_id,business,action,actor) VALUES(${randomUUID()},${input.employeeId},${input.business},${input.action},${input.actor})`;
}
