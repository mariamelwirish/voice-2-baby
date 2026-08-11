// devices.js
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const pool = require('../config/db');
const authenticate = require('../middleware/auth');
const requireRole = require('../middleware/requireRole');
const { v4: uuidv4 } = require('uuid');

// Constant-time comparison of the machine-to-machine provisioning secret.
// Returns false on any mismatch (including a missing/empty secret either side)
// without leaking timing about how much matched.
function provisioningSecretMatches(provided) {
    const expected = process.env.DEVICE_PROVISION_SECRET || '';
    if (!expected || !provided) return false;
    const a = Buffer.from(String(provided));
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
}

// HELPERS

// Confirm a baby exists and is active before assigning a device to it.
async function validateBabyExists(baby_id) {
    const [rows] = await pool.query(
        'SELECT id, status FROM babies WHERE id = ?',
        [baby_id]
    );
    if (rows.length === 0) return 'Baby does not exist!';
    if (rows[0].status !== 'active') return 'Baby is not active!';
    return null;
}

// Next auto device_code, e.g. "PI-00003". Robust against mixed formats
// (the legacy "PI-001" vs padded "PI-00002") by taking the max numeric suffix
// rather than a lexicographic sort.
async function nextDeviceCode() {
    const [rows] = await pool.query("SELECT device_code FROM devices WHERE device_code LIKE 'PI-%'");
    let max = 0;
    for (const r of rows) {
        const num = parseInt(String(r.device_code).split('-')[1], 10);
        if (!Number.isNaN(num) && num > max) max = num;
    }
    return `PI-${String(max + 1).padStart(5, '0')}`;
}

// GET /api/v1/devices
// Admin + Nurse: list all devices with derived room (via baby), current baby, and online status.
// Room is looked up through the baby, not stored on the device — an unassigned device
// has no room until it's assigned to a baby.
router.get('/', authenticate, requireRole('nurse', 'admin'), async (req, res) => {
    const { active } = req.query;

    const clauses = [
        `SELECT d.id, d.device_code, d.is_active, d.last_seen_at,
                b.id AS baby_id, b.first_name AS baby_first_name, b.last_name AS baby_last_name,
                r.id AS room_id, r.room_number,
                CASE
                    -- Online = the live LWT/connect flag is TRUE *and* we've heard a
                    -- heartbeat recently. The flag flips to FALSE fast (~90s) when the
                    -- device drops (Last Will), while the last_seen window is the
                    -- fallback in case a Last Will message was ever missed.
                    WHEN d.is_online = TRUE
                         AND d.last_seen_at IS NOT NULL
                         AND d.last_seen_at > (NOW() - INTERVAL 45 SECOND)
                    THEN TRUE ELSE FALSE
                END AS is_online
         FROM devices d
         LEFT JOIN babies b ON b.id = d.baby_id
         LEFT JOIN rooms r ON r.id = b.room_id`
    ];
    const params = [];

    if (active !== undefined) {
        if (active !== 'true' && active !== 'false') {
            return res.status(400).json({ error: "Query param 'active' must be 'true' or 'false'" });
        }
        clauses.push('WHERE d.is_active = ?');
        params.push(active === 'true');
    }

    clauses.push('ORDER BY d.device_code ASC');
    const sql = clauses.join(' ');

    try {
        const [devices] = await pool.query(sql, params);
        return res.status(200).json(devices);
    } catch (err) {
        console.error('GET /devices error:', err);
        return res.status(500).json({ error: 'Failed to fetch devices' });
    }
});

// POST /api/v1/devices
// Admin only: register a new device (Pi) by its hardware code. No baby assigned yet —
// assignment is a separate, deliberate action via PATCH /devices/:id/assign-baby.
router.post('/', authenticate, requireRole('admin'), async (req, res) => {
    const { device_code } = req.body;
    const providedCode = typeof device_code === 'string' ? device_code.trim() : '';

    try {
        // ---- Path A: caller provided a code (e.g. the register-device.sh script) ----
        if (providedCode) {
            const [existing] = await pool.query(
                'SELECT id, is_active FROM devices WHERE device_code = ?',
                [providedCode]
            );
            if (existing.length > 0) {
                const device = existing[0];
                if (device.is_active === 0) {
                    return res.status(409).json({
                        error: `Device ${providedCode} already exists but is deactivated. Reactivate it instead of creating a new one.`,
                        device_id: device.id,
                        is_active: false
                    });
                }
                return res.status(409).json({ error: 'A device with that code already exists!' });
            }

            const id = uuidv4();
            await pool.query(`INSERT INTO devices (id, device_code, is_active) VALUES (?, ?, TRUE)`, [id, providedCode]);
            return res.status(201).json({
                message: 'Device registered.',
                device: { id, device_code: providedCode, baby_id: null, is_active: true }
            });
        }

        // ---- Path B: no code provided → auto-generate a unique one (UI flow) ----
        // Retry a couple of times in case two admins register at the same instant
        // and both compute the same next code (UNIQUE constraint is the backstop).
        for (let attempt = 0; attempt < 4; attempt++) {
            const code = await nextDeviceCode();
            const id = uuidv4();
            try {
                await pool.query(`INSERT INTO devices (id, device_code, is_active) VALUES (?, ?, TRUE)`, [id, code]);
                return res.status(201).json({
                    message: 'Device registered.',
                    device: { id, device_code: code, baby_id: null, is_active: true }
                });
            } catch (insErr) {
                if (insErr.code === 'ER_DUP_ENTRY') continue; // someone took it — recompute and retry
                throw insErr;
            }
        }
        return res.status(500).json({ error: 'Could not allocate a device ID. Please try again.' });
    } catch (err) {
        console.error('POST /devices error:', err);
        return res.status(500).json({ error: 'Failed to register device' });
    }
});

// POST /api/v1/devices/provision
// Machine-to-machine — called by the fleet-provisioning pre-provisioning Lambda
// on a Pi's first boot, NOT by a logged-in user. Authenticated by a shared
// secret header (x-provision-secret), never a user JWT. Allocates the next
// collision-free PI-##### and inserts the devices row so the speaker shows up
// (Online, unassigned) in the Speakers tab with no manual registration.
//
// Idempotent by the Pi's hardware serial: a re-flashed device with the same
// serial gets its EXISTING device_code back instead of a duplicate row.
router.post('/provision', async (req, res) => {
    if (!provisioningSecretMatches(req.get('x-provision-secret'))) {
        return res.status(401).json({ error: 'Unauthorized.' });
    }

    const serial = typeof req.body?.serial_number === 'string' ? req.body.serial_number.trim() : '';
    if (!serial) {
        return res.status(400).json({ error: 'serial_number is required.' });
    }

    try {
        // Already provisioned? Return the same code — the whole point of tracking
        // the serial is that re-flashing hardware never spawns a second speaker.
        const [existing] = await pool.query(
            'SELECT device_code, is_active FROM devices WHERE serial_number = ?',
            [serial]
        );
        if (existing.length > 0) {
            return res.status(200).json({
                device_code: existing[0].device_code,
                is_active: !!existing[0].is_active,
                reused: true,
            });
        }

        // New hardware — allocate a unique PI-##### and insert. Retry a few times
        // in case two devices provision at the same instant and compute the same
        // next code (the UNIQUE constraint is the backstop).
        for (let attempt = 0; attempt < 4; attempt++) {
            const code = await nextDeviceCode();
            const id = uuidv4();
            try {
                await pool.query(
                    'INSERT INTO devices (id, device_code, serial_number, is_active) VALUES (?, ?, ?, TRUE)',
                    [id, code, serial]
                );
                return res.status(201).json({ device_code: code, is_active: true, reused: false });
            } catch (insErr) {
                if (insErr.code === 'ER_DUP_ENTRY') {
                    // Could be a device_code race, or a serial race (the same Pi
                    // calling twice). If the serial now exists, hand back its code.
                    const [again] = await pool.query(
                        'SELECT device_code, is_active FROM devices WHERE serial_number = ?',
                        [serial]
                    );
                    if (again.length > 0) {
                        return res.status(200).json({
                            device_code: again[0].device_code,
                            is_active: !!again[0].is_active,
                            reused: true,
                        });
                    }
                    continue; // device_code collision — recompute and retry
                }
                throw insErr;
            }
        }
        return res.status(500).json({ error: 'Could not allocate a device ID. Please retry.' });
    } catch (err) {
        console.error('POST /devices/provision error:', err);
        return res.status(500).json({ error: 'Failed to provision device.' });
    }
});

// PATCH /api/v1/devices/:id
// Admin only: deactivate or reactivate a device.
router.patch('/:id', authenticate, requireRole('admin'), async (req, res) => {
    const { id } = req.params;
    const { is_active } = req.body;

    if (is_active === undefined) {
        return res.status(400).json({ error: 'is_active is required.' });
    }

    try {
        const [rows] = await pool.query('SELECT * FROM devices WHERE id = ?', [id]);
        if (rows.length === 0) {
            return res.status(404).json({ error: 'Device not found!' });
        }
        const device = rows[0];

        // Deactivating a device still serving a baby would silently stop playback
        // with no warning — guard it, same as deactivate-room guards against stranding babies.
        if (is_active === false && device.baby_id !== null) {
            return res.status(409).json({
                error: 'Device is currently assigned to a baby. Unassign it first (PATCH /devices/:id/assign-baby with baby_id: null) before deactivating.'
            });
        }

        await pool.query('UPDATE devices SET is_active = ? WHERE id = ?', [is_active, id]);

        const [[updated]] = await pool.query('SELECT * FROM devices WHERE id = ?', [id]);
        return res.status(200).json({ message: 'Device updated.', device: updated });
    } catch (err) {
        console.error('PATCH /devices/:id error:', err);
        return res.status(500).json({ error: 'Failed to update device' });
    }
});

// PATCH /api/v1/devices/:id/assign-baby
// Nurse + Admin: assign a device to a baby, or clear it (baby_id: null).
router.patch('/:id/assign-baby', authenticate, requireRole('nurse', 'admin'), async (req, res) => {
    const { id } = req.params;
    const { baby_id } = req.body;

    if (baby_id === undefined) {
        return res.status(400).json({ error: 'baby_id is required (pass null to unassign).' });
    }

    try {
        const [rows] = await pool.query('SELECT * FROM devices WHERE id = ?', [id]);
        if (rows.length === 0) {
            return res.status(404).json({ error: 'Device not found!' });
        }
        const device = rows[0];

        if (device.is_active !== 1) {
            return res.status(409).json({ error: 'Cannot assign a baby to an inactive device.' });
        }

        // Clearing the assignment — always safe.
        if (baby_id === null) {
            await pool.query('UPDATE devices SET baby_id = NULL WHERE id = ?', [id]);
            const [[updated]] = await pool.query('SELECT * FROM devices WHERE id = ?', [id]);
            return res.status(200).json({ message: 'Device unassigned.', device: updated });
        }

        const babyError = await validateBabyExists(baby_id);
        if (babyError) {
            return res.status(400).json({ error: babyError });
        }

        // Enforce one-to-one at the application level too (schema UNIQUE is the backstop).
        const [conflict] = await pool.query(
            'SELECT id, device_code FROM devices WHERE baby_id = ? AND id != ?',
            [baby_id, id]
        );
        if (conflict.length > 0) {
            return res.status(409).json({
                error: `This baby is already assigned to device ${conflict[0].device_code}. Unassign it there first.`,
                conflicting_device_id: conflict[0].id
            });
        }

        try {
            await pool.query('UPDATE devices SET baby_id = ? WHERE id = ?', [baby_id, id]);
        } catch (updateErr) {
            // Race-condition backstop: two requests both pass the check above, then both
            // try to claim the same baby_id — the schema's UNIQUE constraint catches it.
            if (updateErr.code === 'ER_DUP_ENTRY') {
                return res.status(409).json({ error: 'This baby was just assigned to another device.' });
            }
            throw updateErr;
        }

        const [[updated]] = await pool.query('SELECT * FROM devices WHERE id = ?', [id]);
        return res.status(200).json({ message: 'Device assigned to baby.', device: updated });
    } catch (err) {
        console.error('PATCH /devices/:id/assign-baby error:', err);
        return res.status(500).json({ error: 'Failed to assign device' });
    }
});

// DELETE /api/v1/devices/:id
// Admin only: permanently remove a device from the database (hard delete).
// Guards: must be unassigned first, and we refuse if it has confirmed playback
// history (deleting that would destroy clinical records — deactivate instead).
// ?force=true also deletes the device's playback history (an explicit,
// deliberate override — the UI asks for a second confirmation before sending it).
router.delete('/:id', authenticate, requireRole('admin'), async (req, res) => {
    const { id } = req.params;
    const force = req.query.force === 'true';

    try {
        const [rows] = await pool.query('SELECT id, device_code, baby_id FROM devices WHERE id = ?', [id]);
        if (rows.length === 0) {
            return res.status(404).json({ error: 'Device not found!' });
        }
        const device = rows[0];

        if (device.baby_id !== null) {
            return res.status(409).json({ error: 'This speaker is still assigned to a baby. Unassign it first, then delete.' });
        }

        const [[{ n }]] = await pool.query('SELECT COUNT(*) AS n FROM playback_log WHERE device_id = ?', [id]);

        // Default: protect the audit trail. Caller must opt in with force=true.
        if (n > 0 && !force) {
            return res.status(409).json({
                error: `This speaker has ${n} confirmed playback record(s) tied to it. Deleting it would erase clinical history, so it can’t be fully removed. Deactivate it instead.`,
                playback_records: n,
            });
        }

        // Force path: remove the playback records and the device together, atomically.
        if (n > 0) {
            const connection = await pool.getConnection();
            try {
                await connection.beginTransaction();
                await connection.query('DELETE FROM playback_log WHERE device_id = ?', [id]);
                await connection.query('DELETE FROM devices WHERE id = ?', [id]);
                await connection.commit();
            } catch (txErr) {
                await connection.rollback();
                throw txErr;
            } finally {
                connection.release();
            }
            return res.status(200).json({ message: `Device ${device.device_code} permanently deleted, along with ${n} playback record(s).` });
        }

        await pool.query('DELETE FROM devices WHERE id = ?', [id]);
        return res.status(200).json({ message: `Device ${device.device_code} permanently deleted.` });
    } catch (err) {
        // Backstop for any other FK reference we didn't anticipate.
        if (err.errno === 1451 || err.code === 'ER_ROW_IS_REFERENCED_2') {
            return res.status(409).json({ error: 'This speaker is referenced by other records and can’t be fully deleted. Deactivate it instead.' });
        }
        console.error('DELETE /devices/:id error:', err);
        return res.status(500).json({ error: 'Failed to delete device.' });
    }
});

module.exports = router;