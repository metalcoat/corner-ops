-- Pay notices (LS55) that include the overtime-by-role agreement (29 CFR 778.419): each overtime
-- hour paid at 1.5 x the rate for the job being done. Payroll prices overtime by role only for
-- employees who signed one; everyone else gets the weighted-average overtime (29 CFR 778.115).
ALTER TABLE employment_forms ADD COLUMN IF NOT EXISTS overtime_by_role_agreement boolean NOT NULL DEFAULT false;
