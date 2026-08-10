// babies.js

const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const authenticate = require('../middleware/auth');
const {getPresignedUrl, deleteAudio} = require('../utils/s3');
const {v4: uuidv4} = require('uuid');
const requireRole = require('../middleware/requireRole');
const { generateSequentialId } = require('../utils/ids');
const { getRecordingsBy, deleteRecordingsCascade } = require('../utils/recordingCascade');

// HELPERS
// Validate Room.
async function validateRoomAvailability(room_id, excludeBabyId = null) {
    const [roomRows] = await pool.query(
        'SELECT id, capacity, is_active FROM rooms WHERE id = ?',
        [room_id]
    );
    
    if (roomRows.length === 0) {
        return 'Room does not exist!';
    }

    if (roomRows[0].is_active !== 1) {
        return 'Room is inactive!';
    }

    const room = roomRows[0];

    let countQuery = "SELECT COUNT(*) AS occupied FROM babies WHERE room_id = ? AND status = 'active'";
    const params = [room_id];

    if (excludeBabyId) {
        countQuery += ' AND id != ?';
        params.push(excludeBabyId);
    }

    const [[{ occupied }]] = await pool.query(countQuery, params);

    if (occupied >= room.capacity) {
        return 'Room is at full capacity!';
    }

    return null;
}


// Validate Details.
function validateBabyFields({ first_name, last_name, date_of_birth, gender, room_id, admission_date }, requireAll = false) {
    const validGenders = ['male', 'female', 'other'];

    if (requireAll) {
        if (!first_name || !last_name || !date_of_birth || !gender || !room_id || !admission_date) {
            return 'All fields are required: First Name, Last Name, Date of Birth, Gender, Room ID, Admission Date!';
        }
    }

    if (first_name !== undefined && first_name.trim() === '') return 'First name cannot be empty!';
    if (last_name !== undefined && last_name.trim() === '')  return 'Last name cannot be empty!';
    if (date_of_birth !== undefined && isNaN(Date.parse(date_of_birth))) return 'Invalid date of birth!';
    if (gender !== undefined && !validGenders.includes(gender)) return 'Gender must be male, female, or other!';
    if (admission_date !== undefined && isNaN(Date.parse(admission_date))) return 'Invalid admission date!';



    return null;
}

// GET api/v1/babies/
// Admin + Nurse: all babies with optional ?status filter and ?search (matches record_number).
// Parent: only babies linked to them via parent_baby.
router.get('/', authenticate, async(req, res) => {
    const { role, id: userId } = req.user;

    // Parents get their own linked babies — no status/search filter needed
    if (role === 'parent') {
        try {
            const [rows] = await pool.query(
                `SELECT
                    b.id,
                    b.record_number,
                    b.first_name,
                    b.last_name,
                    b.date_of_birth,
                    b.gender,
                    b.admission_date,
                    b.discharge_date,
                    b.status,
                    b.created_at,
                    r.id AS room_id,
                    r.room_number,
                    pb.relationship
                FROM babies b
                JOIN parent_baby pb ON pb.baby_id = b.id
                LEFT JOIN rooms r ON b.room_id = r.id
                WHERE pb.parent_id = ?
                ORDER BY b.created_at DESC`,
                [userId]
            );
            return res.status(200).json(rows);
        } catch (err) {
            console.error('GET /babies (parent) error:', err);
            return res.status(500).json({ error: 'Internal server error!' });
        }
    }

    // Admin + Nurse: full list with optional status filter and record_number search
    if (role !== 'admin' && role !== 'nurse') {
        return res.status(403).json({ error: 'Forbidden' });
    }

    const { status, search } = req.query;

    const allowedStatuses = ['active', 'discharged'];
    if (status && !allowedStatuses.includes(status)) {
        return res.status(400).json({ error: 'Invalid status filter. Use active or discharged!' });
    }

    try {
        let query = `
            SELECT
                b.id,
                b.record_number,
                b.first_name,
                b.last_name,
                b.date_of_birth,
                b.gender,
                b.admission_date,
                b.discharge_date,
                b.status,
                b.created_at,
                r.id AS room_id,
                r.room_number
            FROM babies b
            LEFT JOIN rooms r ON b.room_id = r.id
        `;

        const conditions = [];
        const params = [];

        if (status) {
            conditions.push('b.status = ?');
            params.push(status);
        }

        if (search) {
            conditions.push('b.record_number LIKE ?');
            params.push(`%${search.trim()}%`);
        }

        if (conditions.length > 0) {
            query += ' WHERE ' + conditions.join(' AND ');
        }

        query += ' ORDER BY b.created_at DESC';

        const [rows] = await pool.query(query, params);

        return res.status(200).json(rows);
    } catch (err) {
        console.error('GET /babies error:', err);
        return res.status(500).json({ error: 'Internal server error!' });
    }
});


// GET api/v1/babies/:id/recordings
// Get all recordings for a specific baby
router.get('/:id/recordings', authenticate, async (req, res) => {
    try {
        const {id: baby_id} = req.params;
        const {id: user_id, role} = req.user;

        let query = `SELECT r.id, r.title, r.description, r.status, r.duration_seconds,
                        r.s3_key, r.uploaded_at, r.reviewed_at,
                        s.scheduled_time,
                        (SELECT h.note FROM recording_status_history h
                          WHERE h.recording_id = r.id AND h.note IS NOT NULL
                          ORDER BY h.changed_at DESC LIMIT 1) AS latest_note,
                        EXISTS(SELECT 1 FROM playback_log pl
                                WHERE pl.recording_id = r.id AND pl.played_at >= r.reviewed_at) AS confirmed_played
                    FROM recordings r
                    LEFT JOIN schedules s
                        ON s.recording_id = r.id AND s.status = 'pending'
                    WHERE r.baby_id = ?`;
        const queryParams = [baby_id]; // fills the '?' places.

        if (role === 'parent') {
            // Verify the parent is linked to the baby
            const [parentBaby] = await pool.query(
                'SELECT id FROM parent_baby WHERE parent_id = ? AND baby_id = ?',
                [user_id, baby_id]
            );

            if (parentBaby.length === 0) {
                return res.status(403).json({ error: 'You are not linked to this baby!'});
            }

            // The parent only sees their own recordings

            query += ' AND r.parent_id = ?'
            queryParams.push(user_id);
        }
        
        query += ' ORDER BY r.uploaded_at DESC';

        const [recordings] = await pool.query(query, queryParams);

        const recordingsWithUrls = await Promise.all( // Promise takes that array of promises, start them all at the same time, and returns all
            recordings.map(async (recording) => {
                const {s3_key, ...recordingData} = recording;
                const audio_url = await getPresignedUrl(s3_key);
                return { ...recordingData, audio_url};
            })
        );

        res.json({ recordings: recordingsWithUrls});
    } catch (err) {
        console.error('Error fetching recordings:', err);
        res.status(500).json({ error: 'Internal Server Error!'});
    }
});


// GET /api/v1/babies/:id
// Get a single baby's profile (role-scoped).
router.get('/:id', authenticate, async(req, res) => {
    try {
        const babyId = req.params.id;
        const user = req.user;

        // Role-based scoping
        if(user.role === 'parent') {
            const[link] = await pool.query(
                'SELECT id FROM parent_baby WHERE parent_id = ? AND baby_id = ?',
                [user.id, babyId]
            );

            if (link.length === 0) {
                return res.status(403).json({ error: 'Access Denied!' });
            }
        }

        if (user.role === 'nurse') {
            // NOTE FOR LATER: Nurses can access any active baby — room scoping enforced at dashboard level!
        }

        const [rows] = await pool.query(
            `SELECT
                b.id,
                b.record_number,
                b.first_name,
                b.last_name,
                b.date_of_birth,
                b.gender,
                b.admission_date,
                b.discharge_date,
                b.status,
                r.id AS room_id,
                r.room_number
            FROM babies b
            JOIN rooms r ON b.room_id = r.id
            WHERE b.id = ?`,
            [babyId]
        );

        if (rows.length === 0) {
            return res.status(404).json({ error: 'Baby not found!' });
        }

        return res.status(200).json(rows[0]);

    } catch(err) {
        console.error('GET /babies/:id error:', err);
        return res.status(500).json({error: 'Internal Server Error!'});
    }
});

// POST /api/v1/babies
// ADMIN ONLY - create a new baby record
router.post('/', authenticate, requireRole('admin', 'nurse'), async(req, res) => {
    try {
        const user = req.user;

        if (!req.body || typeof req.body !== 'object') {
            return res.status(400).json({ error: 'Request body is required!' });
        }

        const { first_name, last_name, date_of_birth, gender, room_id, admission_date } = req.body;

        // Error on Fields.
        const fieldError = validateBabyFields({ first_name, last_name, date_of_birth, gender, room_id, admission_date }, true);
        if (fieldError) return res.status(400).json({ error: fieldError });

        // Error on Room.
        const roomError = await validateRoomAvailability(room_id);
        if (roomError) {
            return res.status(400).json({ error: roomError });
        }

        

        const babyId = uuidv4();
        const record_number = await generateSequentialId('babies', 'record_number', 'B');

        await pool.query(
            `INSERT INTO babies (id, record_number, first_name, last_name, date_of_birth, gender, room_id, admission_date, status, created_by, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, NOW())
            `,
            [babyId, record_number, first_name, last_name, date_of_birth, gender, room_id, admission_date, user.id]
        );

        const [newBaby] = await pool.query(
            'SELECT * FROM babies WHERE id = ?',
            [babyId]
        );

        return res.status(201).json({ baby: newBaby[0] });

    } catch(err) {
        console.error('POST /babies error:', err);
        return res.status(500).json({ error: 'Internal Server Error!' });
    }
});

// PATCH /babies/:id
// Partial Baby Updates.
router.patch('/:id', authenticate, requireRole('admin', 'nurse'), async(req, res) => {
    try {
        const user = req.user;

        if (!req.body || typeof req.body !== 'object') {
            return res.status(400).json({ error: 'Request body is required!' });
        }

        const babyId = req.params.id;
        const { first_name, last_name, date_of_birth, gender, room_id } = req.body;

        // Validate Fields
        const fieldError = validateBabyFields({ first_name, last_name, date_of_birth, gender });
        if (fieldError) return res.status(400).json({ error: fieldError });

        // Validate room only if it was sent
        if (room_id !== undefined) {
            const roomError = await validateRoomAvailability(room_id, babyId);
            if (roomError) return res.status(400).json({ error: roomError });
        }

        // Build the UPDATE query dynamically
        const fields = [];
        const values = [];

        if (first_name !== undefined)    { fields.push('first_name = ?');    values.push(first_name);    }
        if (last_name !== undefined)     { fields.push('last_name = ?');     values.push(last_name);     }
        if (date_of_birth !== undefined) { fields.push('date_of_birth = ?'); values.push(date_of_birth); }
        if (gender !== undefined)        { fields.push('gender = ?');        values.push(gender);        }
        if (room_id !== undefined)       { fields.push('room_id = ?');       values.push(room_id);       }

        if (fields.length === 0) {
            return res.status(400).json({ error: 'No valid fields provided for update!' });
        }

        values.push(babyId);

        const [result] = await pool.query(
            `UPDATE babies SET ${fields.join(', ')} WHERE id = ?`,
            values
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Baby not found!' });
        }

        const [updatedBaby] = await pool.query(
            'SELECT * FROM babies WHERE id = ?',
            [babyId]
        );

        return res.status(200).json({ baby: updatedBaby[0] });

    } catch(err) {
        console.error('PATCH /babies/:id error:', err);
        return res.status(500).json({ error: 'Internal Server Error!' });
    }
});

// PATCH /babies/:id/discharge - Admin + Nurse.
// Soft-discharge a baby. Multi-write, so wrapped in a transaction:
// baby + its schedules + its recordings + history all move together or not at all.
router.patch('/:id/discharge', authenticate, requireRole('admin', 'nurse'), async (req, res) => {
    const { id } = req.params;

    const connection = await pool.getConnection();

    try {
        // 1. Guard reads (cheap validation before we open the transaction)
        const [rows] = await connection.query(
            'SELECT id, status FROM babies WHERE id = ?',
            [id]
        );

        if (rows.length === 0) {
            return res.status(404).json({ error: 'Baby not found!' });
        }

        if (rows[0].status === 'discharged') {
            return res.status(400).json({ error: 'Baby is already discharged!' });
        }

        // 2. Open the transaction — every write below is now all-or-nothing
        await connection.beginTransaction();

        // 3. Discharge the baby
        const today = new Date().toISOString().split('T')[0];
        await connection.query(
            `UPDATE babies
             SET status = 'discharged', discharge_date = ?
             WHERE id = ?`,
            [today, id]
        );

        // 4. Cancel all pending schedules for this baby's recordings
        await connection.query(
            `UPDATE schedules s
             JOIN recordings r ON s.recording_id = r.id
             SET s.status = 'cancelled'
             WHERE r.baby_id = ? AND s.status = 'pending'`,
            [id]
        );

        // 5. Fetch recordings about to be cancelled (need current status for history)
        const [recordingsToCancel] = await connection.query(
            `SELECT id, status FROM recordings
             WHERE baby_id = ? AND status IN ('pending_review', 'scheduled')`,
            [id]
        );

        // 6. Cancel those recordings
        await connection.query(
            `UPDATE recordings
             SET status = 'cancelled'
             WHERE baby_id = ? AND status IN ('pending_review', 'scheduled')`,
            [id]
        );

        // 7. Write one history row per cancelled recording
        if (recordingsToCancel.length > 0) {
            const historyValues = recordingsToCancel.map(r => [r.id, r.status, 'cancelled', req.user.id]);
            await connection.query(
                `INSERT INTO recording_status_history (recording_id, from_status, to_status, changed_by)
                 VALUES ?`,
                [historyValues]
            );
        }

        // 8. All writes succeeded — commit as one unit
        await connection.commit();

        // 9. Read back the updated baby (post-commit, just a read)
        const [updated] = await connection.query(
            'SELECT * FROM babies WHERE id = ?',
            [id]
        );

        return res.status(200).json(updated[0]);
    } catch (err) {
        await connection.rollback();
        console.error('PATCH /babies/:id/discharge error:', err);
        return res.status(500).json({ error: 'Internal Server Error!' });
    } finally {
        connection.release();
    }
});

// PATCH /babies/:id/readmit - Admin + Nurse.
// Undo discharge. Requires a room — readmission is a fresh placement,
// so the target room must be chosen and validated (never silently reuse the old one).
router.patch('/:id/readmit', authenticate, requireRole('admin', 'nurse'), async(req, res) => {
    const {id} = req.params;
    const { room_id } = req.body;

    // Validate input
    if (!room_id || typeof room_id !== 'string' || room_id.trim() === '') {
        return res.status(400).json({ error: 'room_id is required to readmit a baby!' });
    }

    try {
        // 1. Check if baby exists.
        const [rows] = await pool.query(
            'SELECT id, status FROM babies WHERE id = ?',
            [id]
        );

        if (rows.length === 0) {
            return res.status(404).json({ error: 'Baby not found!' });
        }

        // 2. Check baby is actually discharged
        if (rows[0].status === 'active') {
            return res.status(400).json({ error: 'Baby is already active!' });
        }

        // 3. Validate the target room (exists, active, free capacity).
        //    No excludeBabyId — the baby is currently discharged, so it isn't
        //    counted in occupancy anyway; it must genuinely fit as a new arrival.
        const roomError = await validateRoomAvailability(room_id);
        if (roomError) {
            return res.status(400).json({ error: roomError });
        }

        // 4. Readmit into the chosen room
        await pool.query(
            `UPDATE babies
            SET status = 'active', discharge_date = NULL, room_id = ?
            WHERE id = ?`,
            [room_id, id]
        );

        // 5. Return updated baby
        const [updated] = await pool.query(
            'SELECT * FROM babies WHERE id = ?',
            [id]
        );

        return res.status(200).json(updated[0]);
    } catch(err) {
        console.error('PATCH /babies/:id/readmit error:', err);
        return res.status(500).json({ error: 'Internal server error!' });
    }
});

// PATCH /api/v1/babies/:id/reassign-room
// Move a baby to a different room.
// Admin + Nurse. Target room must exist, be active, and have free capacity.
router.patch('/:id/reassign-room', authenticate, requireRole('admin', 'nurse'), async (req, res) => {
    const babyId = req.params.id;
    const { room_id } = req.body;

    // Validate input
    if (!room_id || typeof room_id !== 'string' || room_id.trim() === '') {
        return res.status(400).json({ error: 'room_id is required!' });
    }

    try {
        // 1. Confirm the baby exists and is active
        const [babies] = await pool.query(
            'SELECT id, status FROM babies WHERE id = ?',
            [babyId]
        );

        if (babies.length === 0) {
            return res.status(404).json({ error: 'Baby not found!' });
        }

        if (babies[0].status !== 'active') {
            return res.status(400).json({ error: 'Cannot reassign a discharged baby!' });
        }

        // 2. Validate the target room (exists, active, free capacity) —
        //    exclude this baby so re-submitting its current room isn't a false "full".
        const roomError = await validateRoomAvailability(room_id, babyId);
        if (roomError) {
            return res.status(400).json({ error: roomError });
        }

        // 3. Move the baby
        await pool.query(
            'UPDATE babies SET room_id = ? WHERE id = ?',
            [room_id, babyId]
        );

        // 4. Return the updated baby with its new room
        const [updated] = await pool.query(
            `SELECT b.id, b.record_number, b.first_name, b.last_name, b.status,
                    r.id AS room_id, r.room_number
             FROM babies b
             JOIN rooms r ON b.room_id = r.id
             WHERE b.id = ?`,
            [babyId]
        );

        return res.status(200).json({ baby: updated[0] });

    } catch (err) {
        console.error('PATCH /babies/:id/reassign-room error:', err);
        return res.status(500).json({ error: 'Internal Server Error!' });
    }
});

// DELETE /api/v1/babies/:id
// Admin only: permanently erase a baby and EVERYTHING tied to it. This is the
// hard delete — distinct from PATCH /:id/discharge (the reversible soft path).
//
// Cascade removes, atomically:
//   - the baby's recordings + their playback/history/schedule rows (+ S3 audio)
//   - a linked parent account ONLY when this is that parent's last/only baby —
//     then all of THAT parent's data goes too (their recordings, links, user
//     row). A parent still linked to another baby is merely UNLINKED here, and
//     their account + other data survive.
//   - the parent_baby links, and any speaker assignment (the speaker survives)
//
// Because this can delete parent accounts and recordings, a plain delete is
// refused with a 409 (carrying the recording + to-be-deleted-parent counts)
// whenever the baby has any such records. The caller opts in with ?force=true,
// which the UI surfaces as an explicit "delete anyway" confirmation.
router.delete('/:id', authenticate, requireRole('admin'), async (req, res) => {
    const { id } = req.params;
    const force = req.query.force === 'true';

    const connection = await pool.getConnection();
    try {
        const [babies] = await connection.query(
            'SELECT id, first_name, last_name FROM babies WHERE id = ?',
            [id]
        );
        if (babies.length === 0) {
            connection.release();
            return res.status(404).json({ error: 'Baby not found!' });
        }
        const baby = babies[0];

        // The baby's own recordings.
        const babyRecordings = await getRecordingsBy(connection, 'baby_id', id);

        // The parents linked to this baby. Split them: those linked ONLY to this
        // baby are deleted with it; those also linked elsewhere are just unlinked.
        const [linkedParents] = await connection.query(
            `SELECT u.id, u.first_name, u.last_name
             FROM parent_baby pb JOIN users u ON u.id = pb.parent_id
             WHERE pb.baby_id = ? AND u.role = 'parent'`,
            [id]
        );

        const parentsToDelete = [];
        const parentsToUnlink = [];
        for (const p of linkedParents) {
            const [[{ others }]] = await connection.query(
                'SELECT COUNT(*) AS others FROM parent_baby WHERE parent_id = ? AND baby_id != ?',
                [p.id, id]
            );
            (Number(others) === 0 ? parentsToDelete : parentsToUnlink).push(p);
        }

        // Guard: recordings, or a parent that would be deleted → require force.
        if ((babyRecordings.length > 0 || parentsToDelete.length > 0) && !force) {
            connection.release();
            return res.status(409).json({
                error: `Deleting ${baby.first_name} ${baby.last_name} will permanently remove ${babyRecordings.length} recording(s)${parentsToDelete.length ? ` and ${parentsToDelete.length} parent account(s) linked only to this baby` : ''}${parentsToUnlink.length ? ` (and unlink ${parentsToUnlink.length} parent(s) who have other babies)` : ''}. This cannot be undone.`,
                recordings: babyRecordings.length,
                parents: parentsToDelete.length,
                unlinked_parents: parentsToUnlink.length,
                requires_force: babyRecordings.length + parentsToDelete.length,
            });
        }

        // Recordings to erase: the baby's, plus every recording belonging to a
        // parent we're deleting (a to-delete parent has no other baby, but may
        // still hold recordings from a previously-unlinked baby — those FK-block
        // the user delete unless cleared, so gather them defensively).
        const s3Keys = [...babyRecordings.map(r => r.s3_key)];
        const recordingIds = [...babyRecordings.map(r => r.id)];
        for (const p of parentsToDelete) {
            const parentRecordings = await getRecordingsBy(connection, 'parent_id', p.id);
            for (const r of parentRecordings) {
                if (!recordingIds.includes(r.id)) { recordingIds.push(r.id); s3Keys.push(r.s3_key); }
            }
        }

        await connection.beginTransaction();
        // 1. Wipe all the recordings and their child rows.
        await deleteRecordingsCascade(connection, recordingIds);
        // 2. Unlink the parents who keep their account (only from THIS baby).
        for (const p of parentsToUnlink) {
            await connection.query('DELETE FROM parent_baby WHERE parent_id = ? AND baby_id = ?', [p.id, id]);
        }
        // 3. Delete the parents linked only to this baby: their links, then user.
        for (const p of parentsToDelete) {
            await connection.query('DELETE FROM parent_baby WHERE parent_id = ?', [p.id]);
            await connection.query("DELETE FROM users WHERE id = ? AND role = 'parent'", [p.id]);
        }
        // 4. Any remaining links to this baby, unassign its speaker, delete the baby.
        await connection.query('DELETE FROM parent_baby WHERE baby_id = ?', [id]);
        await connection.query('UPDATE devices SET baby_id = NULL WHERE baby_id = ?', [id]);
        await connection.query('DELETE FROM babies WHERE id = ?', [id]);
        await connection.commit();
        connection.release();

        // Best-effort S3 cleanup, only after the DB rows are gone.
        for (const key of s3Keys) await deleteAudio(key);

        const parts = [];
        if (parentsToDelete.length) parts.push(`${parentsToDelete.length} parent account(s)`);
        if (recordingIds.length) parts.push(`${recordingIds.length} recording(s)`);
        let message = `${baby.first_name} ${baby.last_name} was permanently deleted${parts.length ? `, along with ${parts.join(' and ')}` : ''}.`;
        if (parentsToUnlink.length) message += ` ${parentsToUnlink.length} parent(s) linked to other babies were kept and unlinked.`;
        return res.status(200).json({ message });
    } catch (err) {
        try { await connection.rollback(); } catch (_) {}
        connection.release();
        if (err.errno === 1451 || err.code === 'ER_ROW_IS_REFERENCED_2') {
            return res.status(409).json({ error: 'This baby is still referenced by other records and can’t be fully deleted.' });
        }
        console.error('DELETE /babies/:id error:', err);
        return res.status(500).json({ error: 'Failed to delete baby.' });
    }
});

module.exports = router;