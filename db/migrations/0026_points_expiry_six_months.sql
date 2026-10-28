-- Points expire after 6 months with no qualifying purchase (was 12). Still a setting.
ALTER TABLE ordering_points_settings ALTER COLUMN expiry_months SET DEFAULT 6;
UPDATE ordering_points_settings SET expiry_months=6,updated_at=NOW(),updated_by='points-expiry-6-months' WHERE expiry_months=12 AND updated_by='';
