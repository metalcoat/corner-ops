CREATE OR REPLACE FUNCTION enforce_stage2_journal_balance()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  target_entry UUID := COALESCE(NEW.entry_id, OLD.entry_id);
  entry_source TEXT;
  debit_total NUMERIC(14,2);
  credit_total NUMERIC(14,2);
BEGIN
  SELECT source INTO entry_source FROM journal_entries WHERE id = target_entry;
  IF NOT FOUND OR entry_source NOT IN ('Bank Import', 'Credit Card Import', 'Square', 'Reversal') THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  SELECT COALESCE(SUM(debit), 0), COALESCE(SUM(credit), 0)
    INTO debit_total, credit_total
  FROM journal_lines
  WHERE entry_id = target_entry;

  IF ABS(debit_total - credit_total) > 0.005 THEN
    RAISE EXCEPTION 'Journal entry % is out of balance: debit %, credit %', target_entry, debit_total, credit_total;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS stage2_journal_balance_guard ON journal_lines;
CREATE CONSTRAINT TRIGGER stage2_journal_balance_guard
AFTER INSERT OR UPDATE OR DELETE ON journal_lines
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_stage2_journal_balance();
