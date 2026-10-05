-- Preserve production grants for the optional Rezku repair role when that role exists.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'corner_rezku_repair_tmp') THEN
    GRANT USAGE ON SCHEMA public TO corner_rezku_repair_tmp;
    GRANT SELECT, INSERT, UPDATE ON
      public.rezku_import_batches,
      public.rezku_inbound_emails,
      public.rezku_inbound_reports,
      public.rezku_orders,
      public.rezku_transactions
    TO corner_rezku_repair_tmp;
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.rezku_shifts TO corner_rezku_repair_tmp;
  END IF;
END
$$;
