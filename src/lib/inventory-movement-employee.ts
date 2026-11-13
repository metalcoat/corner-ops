/**
 * employee_id is a staff UUID column. Online, kiosk and AI-phone orders are submitted by
 * non-employee actors ("web:…"), which made this insert fail and rolled back the whole
 * submission (a paid web order stayed a draft). They're recorded with no employee;
 * created_by keeps the actor id as text either way.
 */
export function movementEmployeeId(actor:{id:string;type?:string}):string|null{return actor.type==="employee"&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(actor.id)?actor.id:null}
