import { parsePunchCommand, type PunchCommand } from "../lib/timeclock-contract";

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const key = (employeeId: string) => `corner-ops:pending-punch:${employeeId}`;
export function readPendingPunch(store: Store, employeeId: string): PunchCommand | null {
  const raw = store.getItem(key(employeeId));
  if (!raw) return null;
  const command = parsePunchCommand(JSON.parse(raw));
  if (!command) throw new Error("A pending punch could not be read. Ask a manager to verify the punch before clearing browser storage.");
  return command;
}
export function rememberPunch(store: Store, employeeId: string, command: PunchCommand): void {
  store.setItem(key(employeeId), JSON.stringify(command));
}
export function forgetPunch(store: Store, employeeId: string): void { store.removeItem(key(employeeId)); }
