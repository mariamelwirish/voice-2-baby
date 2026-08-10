// rooms.js
const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const authenticate = require('../middleware/auth');
const requireRole = require('../middleware/requireRole');
const { v4: uuidv4 } = require('uuid');

// GET /api/v1/rooms
// List all rooms with live occupancy, optional filter on active state.
router.get('/', authenticate, requireRole('nurse', 'admin'), async(req, res) => {
    const {active} = req.query;

    const clauses = [
        `SELECT r.id, r.room_number, r.capacity, r.is_active,
                COUNT(b.id) AS occupied
         FROM rooms r
         LEFT JOIN babies b
                ON b.room_id = r.id AND b.status = 'active'`
    ];
    const params = [];

    if(active !== undefined) {
        if(active !== 'true' && active !== 'false') {
            return res.status(400).json({ error: "Query param 'active' must be 'true' or 'false'" });
        }
        clauses.push('WHERE r.is_active = ?');
        params.push(active === 'true');
    }

    clauses.push('GROUP BY r.id, r.room_number, r.capacity, r.is_active');
    clauses.push('ORDER BY r.room_number ASC');
    const sql = clauses.join(' ');

    try {
        const [rooms] = await pool.query(sql, params);
        return res.status(200).json(rooms);
    } catch (err) {
        console.error('GET /rooms error:', err);
        return res.status(500).json({ error: 'Failed to fetch rooms' });
    }
});
// GET /api/v1/rooms/available
// List only active rooms that still have free capacity.
// Feeds the reassignment UI so it never offers a full room.
router.get('/available', authenticate, requireRole('nurse', 'admin'), async (req, res) => {
    try {
        const [rooms] = await pool.query(
            `SELECT r.id, r.room_number, r.capacity,
                    COUNT(b.id) AS occupied
             FROM rooms r
             LEFT JOIN babies b
                    ON b.room_id = r.id AND b.status = 'active'
             WHERE r.is_active = TRUE
             GROUP BY r.id, r.room_number, r.capacity
             HAVING occupied < r.capacity
             ORDER BY r.room_number ASC`
        );

        return res.status(200).json(rooms);
    } catch (err) {
        console.error('GET /rooms/available error:', err);
        return res.status(500).json({ error: 'Failed to fetch available rooms' });
    }
});



// GET /api/v1/rooms/:id/babies
// All active babies in a given room (the core nurse dashboard query).
router.get('/:id/babies', authenticate, requireRole('nurse', 'admin'), async (req, res) => {
    const {id} = req.params;

    try {
        // Confirm the room exists and is active before returning babies
        const [rooms] = await pool.query(
            'SELECT id FROM rooms WHERE id = ? AND is_active = TRUE',
            [id]
        );

        if (rooms.length === 0) {
            return res.status(404).json({ error: 'Room not found!' });
        }

        const [babies] = await pool.query(
            `SELECT b.id, b.first_name, b.last_name, b.date_of_birth, b.gender,
                    b.admission_date, b.status,
                    SUM(CASE WHEN r.status = 'pending_review' THEN 1 ELSE 0 END) AS pending_review_count,
                    SUM(CASE WHEN r.status = 'scheduled'      THEN 1 ELSE 0 END) AS scheduled_count
             FROM babies b
             LEFT JOIN recordings r ON r.baby_id = b.id
             WHERE b.room_id = ? AND b.status = 'active'
             GROUP BY b.id, b.first_name, b.last_name, b.date_of_birth, b.gender, b.admission_date, b.status
             ORDER BY b.created_at DESC`,
            [id]
        );

        return res.status(200).json(babies);
    } catch(err) {
        console.error('GET /rooms/:id/babies error:', err);
        return res.status(500).json({ error: 'Failed to fetch babies for room' });
    }
});

// POST /api/v1/rooms
// Create a new room (Admin + Nurse).
router.post('/', authenticate, requireRole('admin', 'nurse'), async (req, res) => {
    const {room_number, capacity} = req.body;

    // Validate room_number
    if (!room_number || typeof room_number !== 'string' || room_number.trim() === '') {
        return res.status(400).json({ error: 'Room Number is required!' });
    }

    // Validate capacity: optional, defaults to 1, must be a positive integer
    let finalCapacity = 1;
    if (capacity !== undefined) {
        if (!Number.isInteger(capacity) || capacity < 1) {
            return res.status(400).json({ error: 'Capacity must be a positive integer!' });
        }
        finalCapacity = capacity;
    }

    const trimmedRoomNumber = room_number.trim();

    try {
        // Guard against duplicate room_number (schema enforces UNIQUE, but we check
        // first to return a clean 409 instead of a raw DB error).
        const [existing] = await pool.query(
            'SELECT id, is_active FROM rooms WHERE room_number = ?',
            [trimmedRoomNumber]
        );

        if (existing.length > 0) {
            const room = existing[0];
            if (room.is_active === 0) {
                return res.status(409).json({
                    error: `Room ${trimmedRoomNumber} already exists but is deactivated. Reactivate it instead of creating a new one.`,
                    room_id: room.id,
                    is_active: false
                });
            }
            return res.status(409).json({ error: 'A room with that number already exists!' });
        }

        const id = uuidv4();
        await pool.query(
            `INSERT INTO rooms (id, room_number, capacity, is_active)
             VALUES (?, ?, ?, TRUE)`,
            [id, trimmedRoomNumber, finalCapacity]
        );

        return res.status(201).json({
            id,
            room_number: trimmedRoomNumber,
            capacity: finalCapacity,
            is_active: true
        });

    } catch(err) {
        console.error('POST /rooms error:', err);
        return res.status(500).json({ error: 'Failed to create room!' });
    }
});

// PATCH /api/v1/rooms/:id
// Edit a room's number and/or capacity (Admin + Nurse).
router.patch('/:id', authenticate, requireRole('admin', 'nurse'), async (req, res) => {
    const { id } = req.params;
    const { room_number, capacity } = req.body;

    // At least one editable field must be present
    if (room_number === undefined && capacity === undefined) {
        return res.status(400).json({ error: 'Provide room_number and/or capacity to update!' });
    }

    // Validate room_number if sent
    let trimmedRoomNumber;
    if (room_number !== undefined) {
        if (typeof room_number !== 'string' || room_number.trim() === '') {
            return res.status(400).json({ error: 'Room Number must be a non-empty string!' });
        }
        trimmedRoomNumber = room_number.trim();
    }

    

    // Validate capacity if sent
    if (capacity !== undefined && (!Number.isInteger(capacity) || capacity < 1)) {
        return res.status(400).json({ error: 'Capacity must be a positive integer!' });
    }

    try {
        // 1. Confirm the room exists
        const [rooms] = await pool.query(
            'SELECT id, capacity FROM rooms WHERE id = ?',
            [id]
        );

        if (rooms.length === 0) {
            return res.status(404).json({ error: 'Room not found!' });
        }

        // 2. If shrinking capacity, ensure it doesn't drop below current occupancy
        if (capacity !== undefined) {
            const [[{ occupied }]] = await pool.query(
                "SELECT COUNT(*) AS occupied FROM babies WHERE room_id = ? AND status = 'active'",
                [id]
            );

            if (capacity < occupied) {
                return res.status(400).json({
                    error: `Cannot set capacity to ${capacity}: room currently has ${occupied} active ${occupied === 1 ? 'baby' : 'babies'}.`
                });
            }
        }

        // 3. Guard against duplicate room_number if it's being changed
        //    (surfaces the deactivated case with an actionable message)
        if (trimmedRoomNumber !== undefined) {
            const [existing] = await pool.query(
                'SELECT id, is_active FROM rooms WHERE room_number = ? AND id != ?',
                [trimmedRoomNumber, id]
            );

            if (existing.length > 0) {
                const room = existing[0];
                if (room.is_active !== 1) {
                    return res.status(409).json({
                        error: `Room ${trimmedRoomNumber} already exists but is deactivated. Reactivate it instead of renaming into its number.`,
                        room_id: room.id,
                        is_active: false
                    });
                }
                return res.status(409).json({ error: 'A room with that number already exists!' });
            }
        }
        
        // 4. Build the dynamic UPDATE
        const fields = [];
        const values = [];

        if (trimmedRoomNumber !== undefined) { fields.push('room_number = ?'); values.push(trimmedRoomNumber); }
        if (capacity !== undefined)          { fields.push('capacity = ?');    values.push(capacity);          }

        values.push(id);

        await pool.query(
            `UPDATE rooms SET ${fields.join(', ')} WHERE id = ?`,
            values
        );

        // 5. Return the updated room
        const [updated] = await pool.query(
            'SELECT id, room_number, capacity, is_active FROM rooms WHERE id = ?',
            [id]
        );

        return res.status(200).json(updated[0]);

    } catch (err) {
        console.error('PATCH /rooms/:id error:', err);
        return res.status(500).json({ error: 'Failed to update room!' });
    }
});

// PATCH /api/v1/rooms/:id/deactivate
// Soft-deactivate a room (Admin + Nurse). Blocked if active babies are present.
router.patch('/:id/deactivate', authenticate, requireRole('admin', 'nurse'), async (req, res) => {
    const { id } = req.params;

    try {
        // 1. Confirm the room exists
        const [rooms] = await pool.query(
            'SELECT id, is_active FROM rooms WHERE id = ?',
            [id]
        );

        if (rooms.length === 0) {
            return res.status(404).json({ error: 'Room not found!' });
        }

        // 2. Guard: already inactive
        if (rooms[0].is_active !== 1) {
            return res.status(400).json({ error: 'Room is already inactive!' });
        }

        // 3. Guard: block if active babies are still in the room
        const [babies] = await pool.query(
            `SELECT id, first_name, last_name
             FROM babies
             WHERE room_id = ? AND status = 'active'`,
            [id]
        );

        if (babies.length > 0) {
            return res.status(409).json({
                error: 'Cannot deactivate a room that still has active babies. Reassign or discharge them first.',
                babies
            });
        }

        // 4. Deactivate
        await pool.query(
            'UPDATE rooms SET is_active = FALSE WHERE id = ?',
            [id]
        );

        return res.status(200).json({ id, is_active: false });

    } catch (err) {
        console.error('PATCH /rooms/:id/deactivate error:', err);
        return res.status(500).json({ error: 'Failed to deactivate room!' });
    }
});

// PATCH /api/v1/rooms/:id/reactivate
// Restore a deactivated room (Admin + Nurse).
router.patch('/:id/reactivate', authenticate, requireRole('admin', 'nurse'), async (req, res) => {
    const { id } = req.params;

    try {
        // 1. Confirm the room exists
        const [rooms] = await pool.query(
            'SELECT id, is_active FROM rooms WHERE id = ?',
            [id]
        );

        if (rooms.length === 0) {
            return res.status(404).json({ error: 'Room not found!' });
        }

        // 2. Guard: already active
        if (rooms[0].is_active === 1) {
            return res.status(400).json({ error: 'Room is already active!' });
        }

        // 3. Reactivate
        await pool.query(
            'UPDATE rooms SET is_active = TRUE WHERE id = ?',
            [id]
        );

        return res.status(200).json({ id, is_active: true });

    } catch (err) {
        console.error('PATCH /rooms/:id/reactivate error:', err);
        return res.status(500).json({ error: 'Failed to reactivate room!' });
    }
});

// DELETE /api/v1/rooms/:id
// Admin only: permanently delete a room (hard delete, distinct from the
// reversible PATCH /:id/deactivate). Blocked while ANY baby — active or
// discharged — still references the room, since babies.room_id is a required
// foreign key. The admin must move or delete those babies first.
router.delete('/:id', authenticate, requireRole('admin'), async (req, res) => {
    const { id } = req.params;

    try {
        const [rooms] = await pool.query('SELECT id, room_number FROM rooms WHERE id = ?', [id]);
        if (rooms.length === 0) {
            return res.status(404).json({ error: 'Room not found!' });
        }
        const room = rooms[0];

        const [[{ n }]] = await pool.query('SELECT COUNT(*) AS n FROM babies WHERE room_id = ?', [id]);
        if (n > 0) {
            return res.status(409).json({
                error: `Room ${room.room_number} still has ${n} baby record(s) linked to it. Move or delete those babies first, then delete the room.`,
                babies: n,
            });
        }

        await pool.query('DELETE FROM rooms WHERE id = ?', [id]);
        return res.status(200).json({ message: `Room ${room.room_number} was permanently deleted.` });
    } catch (err) {
        if (err.errno === 1451 || err.code === 'ER_ROW_IS_REFERENCED_2') {
            return res.status(409).json({ error: 'This room is still referenced by other records and can’t be deleted.' });
        }
        console.error('DELETE /rooms/:id error:', err);
        return res.status(500).json({ error: 'Failed to delete room.' });
    }
});

module.exports = router;