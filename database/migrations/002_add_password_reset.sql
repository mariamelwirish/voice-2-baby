-- 002_add_password_reset.sql
--
-- Adds password-reset ("forgot password") support to the users table:
--   reset_token             - SHA-256 hash of the emailed reset token (never the raw)
--   reset_token_expires_at  - when that token stops working
--
-- Same idempotent, guard-with-information_schema pattern as 001 so it is safe to
-- run on any database (fresh installs from schema.sql already have the columns)
-- and safe to re-run. MySQL has no "ADD COLUMN IF NOT EXISTS".

SET @has_token := (
    SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema = DATABASE()
      AND table_name = 'users'
      AND column_name = 'reset_token'
);
SET @ddl := IF(@has_token = 0,
    'ALTER TABLE users ADD COLUMN reset_token VARCHAR(255) NULL AFTER invite_used',
    'DO 0'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @has_expiry := (
    SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema = DATABASE()
      AND table_name = 'users'
      AND column_name = 'reset_token_expires_at'
);
SET @ddl := IF(@has_expiry = 0,
    'ALTER TABLE users ADD COLUMN reset_token_expires_at TIMESTAMP NULL AFTER reset_token',
    'DO 0'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
