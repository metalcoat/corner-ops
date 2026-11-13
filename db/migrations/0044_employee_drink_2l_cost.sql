-- Chris 2026-11-06: the 2 liter cost is $2.00 before the 5-cent deposit (employee price $2.25).
-- Only replaces the starting value; a cost a manager has since saved is left alone.
UPDATE ordering_employee_drink_prices SET cost_cents = 200, updated_by = 'initial (Chris 2026-11-06)', updated_at = now()
WHERE business = 'Corner Deli' AND size_key = '2l' AND cost_cents = 205 AND updated_by LIKE 'initial%';
