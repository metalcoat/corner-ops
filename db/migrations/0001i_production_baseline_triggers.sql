-- Baseline public triggers. Generated from validated production catalog.

CREATE TRIGGER bank_transactions_active_account_filter BEFORE INSERT OR UPDATE ON bank_transactions FOR EACH ROW EXECUTE FUNCTION corner_ops_filter_inactive_bank_account();
CREATE CONSTRAINT TRIGGER stage2_journal_balance_guard AFTER INSERT OR DELETE OR UPDATE ON journal_lines DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enforce_stage2_journal_balance();
CREATE TRIGGER rezku_employee_alias_normalization BEFORE INSERT OR UPDATE OF employee_name ON rezku_shifts FOR EACH ROW EXECUTE FUNCTION corner_ops_prepare_rezku_employee();
CREATE TRIGGER rezku_employee_directory_sync AFTER INSERT OR UPDATE OF employee_name, "position", role_group ON rezku_shifts FOR EACH ROW EXECUTE FUNCTION corner_ops_sync_rezku_employee();
CREATE TRIGGER corner_ops_schedule_shift_change AFTER INSERT OR UPDATE OF employee_id, starts_at, ends_at, status ON schedule_shifts FOR EACH ROW EXECUTE FUNCTION corner_ops_log_schedule_shift_change();
