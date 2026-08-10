-- Users table
CREATE TABLE users (
    id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
    hospital_id VARCHAR(20) UNIQUE NOT NULL,
    first_name VARCHAR(100) NOT NULL,
    last_name VARCHAR(100) NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255),
    role ENUM('admin', 'nurse', 'parent') NOT NULL,
    is_active BOOLEAN DEFAULT TRUE,
    invite_token VARCHAR(255),
    invite_token_expires_at TIMESTAMP,
    invite_used BOOLEAN DEFAULT FALSE,
    created_by CHAR(36),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Rooms table
CREATE TABLE rooms (
    id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
    room_number VARCHAR(20) UNIQUE NOT NULL,
    capacity INT NOT NULL DEFAULT 1,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Babies table
CREATE TABLE babies (
    id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
    record_number VARCHAR(20) UNIQUE NOT NULL,
    first_name VARCHAR(100) NOT NULL,
    last_name VARCHAR(100) NOT NULL,
    date_of_birth DATE NOT NULL,
    gender ENUM('male', 'female', 'other') NOT NULL,
    room_id CHAR(36) NOT NULL,
    admission_date DATE NOT NULL,
    discharge_date DATE,
    status ENUM('active', 'discharged') DEFAULT 'active',
    created_by CHAR(36),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (room_id) REFERENCES rooms(id)
);

-- Parent-Baby junction table
CREATE TABLE parent_baby (
    id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
    parent_id CHAR(36) NOT NULL,
    baby_id CHAR(36) NOT NULL,
    relationship ENUM('primary', 'secondary') NOT NULL,
    linked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (parent_id) REFERENCES users(id),
    FOREIGN KEY (baby_id) REFERENCES babies(id)
);

-- Recordings table
-- status flips to 'played' immediately when a play command is sent (manual
-- or scheduled) — optimistic, not confirmation-gated. The Pi's MQTT status
-- channel (started/played/stopped/fetch_failed) is monitored separately
-- (iotSubscriber.js): genuine device failure reverts to 'pending_review',
-- genuine success writes a playback_log row with the real duration.
CREATE TABLE recordings (
    id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
    baby_id CHAR(36) NOT NULL,
    parent_id CHAR(36) NOT NULL,
    title VARCHAR(255),
    description TEXT,
    s3_key VARCHAR(500) NOT NULL,
    duration_seconds INTEGER NOT NULL,
    status ENUM('pending_review', 'scheduled', 'played', 'rejected', 'cancelled') DEFAULT 'pending_review',
    uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    reviewed_at TIMESTAMP,
    reviewed_by CHAR(36),
    ai_transcript TEXT,
    ai_flags TEXT,
    ai_summary TEXT,
    FOREIGN KEY (baby_id) REFERENCES babies(id),
    FOREIGN KEY (parent_id) REFERENCES users(id)
);

-- Recording status history table
CREATE TABLE recording_status_history (
    id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
    recording_id CHAR(36) NOT NULL,
    from_status ENUM('pending_review', 'scheduled', 'played', 'rejected', 'cancelled'),
    to_status ENUM('pending_review', 'scheduled', 'played', 'rejected', 'cancelled') NOT NULL,
    changed_by CHAR(36) NOT NULL,
    note TEXT,
    changed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (recording_id) REFERENCES recordings(id),
    FOREIGN KEY (changed_by) REFERENCES users(id)
);

-- Schedules table
CREATE TABLE schedules (
    id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
    recording_id CHAR(36) NOT NULL,
    scheduled_by CHAR(36) NOT NULL,
    scheduled_time TIMESTAMP NOT NULL,
    trigger_type ENUM('scheduled', 'manual') NOT NULL,
    status ENUM('pending', 'triggered', 'cancelled') DEFAULT 'pending',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (recording_id) REFERENCES recordings(id),
    FOREIGN KEY (scheduled_by) REFERENCES users(id)
);

-- Devices table
-- baby_id is nullable + UNIQUE — enforces one-to-one device-to-baby at the
-- DB level. Room is derived via baby_id -> babies.room_id, not stored here.
-- is_online: maintained live by iotSubscriber.js via MQTT connect/online
-- messages and Last Will and Testament (offline) messages — checked by
-- /play and the scheduler BEFORE publishing, so a known-offline device is
-- rejected instantly instead of optimistically marking a recording played.
CREATE TABLE devices (
    id CHAR(36) PRIMARY KEY,
    device_code VARCHAR(50) UNIQUE NOT NULL,
    -- Pi hardware serial (/proc/cpuinfo). Set by fleet self-provisioning so a
    -- re-flashed device with the same serial reuses its existing device_code
    -- instead of creating a duplicate row. NULL for devices registered manually
    -- via the Speakers tab before they ever provision.
    serial_number VARCHAR(64) UNIQUE,
    baby_id CHAR(36) UNIQUE,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    is_online BOOLEAN DEFAULT FALSE,
    last_seen_at TIMESTAMP NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (baby_id) REFERENCES babies(id)
);

-- Playback log table
-- Written only after the Pi confirms genuine playback over MQTT.
-- Schedules/recordings.status = intentions. playback_log = confirmed reality.
CREATE TABLE playback_log (
    id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
    recording_id CHAR(36) NOT NULL,
    device_id CHAR(36) NOT NULL,
    triggered_by CHAR(36),
    played_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    duration_played_seconds INTEGER NOT NULL,
    trigger_source ENUM('scheduled', 'manual') NOT NULL,
    FOREIGN KEY (recording_id) REFERENCES recordings(id),
    FOREIGN KEY (device_id) REFERENCES devices(id)
);

-- Trigger: enforce maximum 2 parents per baby
DELIMITER //

CREATE TRIGGER enforce_max_two_parents
BEFORE INSERT ON parent_baby
FOR EACH ROW
BEGIN
  IF (SELECT COUNT(*) FROM parent_baby
      WHERE baby_id = NEW.baby_id) >= 2 THEN
    SIGNAL SQLSTATE '45000'
    SET MESSAGE_TEXT = 'A baby cannot have more than two parents';
  END IF;
END//

DELIMITER ;