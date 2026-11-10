-- Driver bulk cash-out (Chris, 2026-11-09): one settlement can hold several drivers' orders, so each settled
-- order keeps the driver who took it. The settlement's own driver_employee_id is that driver when all the orders
-- are one driver's, otherwise the employee who posted it.
ALTER TABLE ordering_driver_cash_settlement_orders ADD COLUMN IF NOT EXISTS driver_employee_id UUID REFERENCES employees(id);
