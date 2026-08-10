-- 001_add_device_serial.sql
--
-- Adds devices.serial_number to support fleet self-provisioning (idempotent
-- re-flash by Pi hardware serial).
--
-- Written to be safe to run on ANY database: a fresh install created from
-- schema.sql already HAS this column, and the migration runner may still invoke
-- this file, so we guard the ALTER with an information_schema check instead of a
-- plain ADD (MySQL has no "ADD COLUMN IF NOT EXISTS"). Running it twice is a
-- harmless no-op.

SET @col_exists := (
    SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema = DATABASE()
      AND table_name = 'devices'
      AND column_name = 'serial_number'
);

SET @ddl := IF(@col_exists = 0,
    'ALTER TABLE devices ADD COLUMN serial_number VARCHAR(64) UNIQUE AFTER device_code',
    'DO 0'
);

PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
