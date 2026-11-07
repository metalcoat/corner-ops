#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { localValidationEnv } from "./validation-env";

localValidationEnv();

const EMPLOYEE_ID = "11110000-0000-4000-8000-000000000001";
const TEST_PIN = "1111";

async function main() {
  const { getSql, withTransaction } = await import("../src/lib/db");
  const { ensureEmployeeDirectorySchema } = await import("../src/lib/employee-directory");
  const { authenticateDeliPosPin, hashEmployeePin } = await import("../src/lib/pos-auth");
  await ensureEmployeeDirectorySchema();
  const hash = hashEmployeePin("Corner Deli", TEST_PIN);

  await withTransaction(async () => {
    const sql = getSql();
    const collision = (await sql`
      SELECT id,name FROM employees
      WHERE business='Corner Deli' AND pin_hash=${hash} AND id<>${EMPLOYEE_ID}
      LIMIT 1
    `)[0];
    if (collision) throw new Error(`PIN 1111 is already assigned to ${collision.name}.`);

    await sql`
      INSERT INTO employees(
        id,business,name,pin_hash,pin_enabled,position,role_group,
        counts_for_tips,active,pos_role
      ) VALUES(
        ${EMPLOYEE_ID},'Corner Deli','Development Test Login',${hash},TRUE,
        'Test Manager','In-House',FALSE,TRUE,'manager'
      )
      ON CONFLICT(id) DO UPDATE SET
        name=EXCLUDED.name,pin_hash=EXCLUDED.pin_hash,pin_enabled=TRUE,
        position=EXCLUDED.position,role_group=EXCLUDED.role_group,
        counts_for_tips=FALSE,active=TRUE,pos_role='manager',updated_at=NOW()
    `;
    await sql`
      INSERT INTO time_entries(
        id,business,employee_id,employee_name,position,role_group,
        clock_in,source,status,notes
      )
      SELECT ${randomUUID()},'Corner Deli',${EMPLOYEE_ID},'Development Test Login',
        'Test Manager','In-House',NOW(),'Development fixture','Open',
        'Local development PIN 1111; not a payroll employee'
      WHERE NOT EXISTS(
        SELECT 1 FROM time_entries
        WHERE employee_id=${EMPLOYEE_ID} AND business='Corner Deli' AND clock_out IS NULL
      )
    `;
  });

  const session = await authenticateDeliPosPin(TEST_PIN, `configure-local-test-pin-${Date.now()}`);
  if (session.employeeId !== EMPLOYEE_ID || session.clockInRequired || session.posRole !== "manager")
    throw new Error("Development test PIN did not produce the expected active manager session.");
  console.log(JSON.stringify({ pin: TEST_PIN, name: session.name, role: session.posRole, clockInRequired: session.clockInRequired }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
