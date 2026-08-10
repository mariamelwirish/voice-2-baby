// admin.js
const express = require('express');
const router = express.Router();
const { generateRawToken, hashToken } = require('../utils/tokens');
const pool = require('../config/db');
const authenticate = require('../middleware/auth');
const requireRole = require('../middleware/requireRole');
const { v4: uuidv4 } = require('uuid');
const { notifyInvite } = require('../utils/ses');
const { generateSequentialId } = require('../utils/ids');
const { deleteAudio } = require('../utils/s3');
const { getRecordingsBy, deleteRecordingsCascade } = require('../utils/recordingCascade');

// Simple email sanity check — not exhaustive, just catches obvious junk.
const isValidEmail = (email) =>
    typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

// POST /api/v1/admin/nurses
// Provision a nurse account and send an invite email.
router.post('/nurses', authenticate, requireRole('admin', 'nurse'), async (req, res) => {
    const { first_name, last_name, email } = req.body;

    // 1. Validate input
    if (!first_name || first_name.trim() === '') {
        return res.status(400).json({ error: 'First name is required!' });
    }
    if (!last_name || last_name.trim() === '') {
        return res.status(400).json({ error: 'Last name is required!' });
    }
    if (!email || !isValidEmail(email)) {
        return res.status(400).json({ error: 'A valid email is required!' });
    }

    const trimmedEmail = email.trim().toLowerCase();

    try {
        // 2. Guard against duplicate email (schema is UNIQUE; this returns a clean 409)
        const [existing] = await pool.query(
            'SELECT id FROM users WHERE email = ?',
            [trimmedEmail]
        );
        if (existing.length > 0) {
            return res.status(409).json({ error: 'A user with that email already exists!' });
        }

        // 3. Generate identifiers + invite token
        const id = uuidv4();
        const hospital_id = await generateSequentialId('users', 'hospital_id', 'N');
        const rawToken = generateRawToken();       // emailed to the nurse
        const tokenHash = hashToken(rawToken);     // stored in the DB  
        console.log('RAW TOKEN (dev only):', rawToken);
        const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000)
            .toISOString().slice(0, 19).replace('T', ' ');

        // 4. Insert nurse — password_hash stays NULL until activation
        await pool.query(
            `INSERT INTO users
                (id, hospital_id, first_name, last_name, email, role,
                is_active, invite_token, invite_token_expires_at, invite_used, created_by)
            VALUES (?, ?, ?, ?, ?, 'nurse', TRUE, ?, ?, FALSE, ?)`,
            [id, hospital_id, first_name.trim(), last_name.trim(), trimmedEmail,
            tokenHash, expiresAt, req.user.id]     // <-- tokenHash, not rawToken
        );

        // 5. Send invite (account already exists; email is best-effort → resend-invite covers failures)
        try {
            await notifyInvite(trimmedEmail, first_name.trim(), 'nurse', rawToken);  
        } catch (emailErr) {
            console.error('SES invite email failed (nurse):', emailErr);
            return res.status(201).json({
                message: 'Nurse account created but invite email failed to send. Use resend-invite.',
                nurse: { id, hospital_id, first_name: first_name.trim(), last_name: last_name.trim(), email: trimmedEmail, role: 'nurse' }
            });
        }

        // 6. Success
        return res.status(201).json({
            message: 'Nurse account created and invite email sent.',
            nurse: { id, hospital_id, first_name: first_name.trim(), last_name: last_name.trim(), email: trimmedEmail, role: 'nurse' }
        });

    } catch (err) {
        console.error('POST /admin/nurses error:', err);
        return res.status(500).json({ error: 'Failed to create nurse account!' });
    }
});

// POST /api/v1/admin/parents
// Provision (or link) a parent to a baby.
// Two paths: brand-new parent (create + invite + link) OR existing parent (link only).
// Both writes are wrapped in a transaction — user + link succeed together or not at all.
router.post('/parents', authenticate, requireRole('admin', 'nurse'), async (req, res) => {
    const { first_name, last_name, email, baby_id, relationship } = req.body;

    // 1. Validate the link fields first (needed on BOTH paths)
    if (!baby_id) {
        return res.status(400).json({ error: 'baby_id is required!' });
    }
    if (relationship !== 'primary' && relationship !== 'secondary') {
        return res.status(400).json({ error: "relationship must be 'primary' or 'secondary'!" });
    }

    if (!email || !isValidEmail(email)) {
        return res.status(400).json({ error: 'A valid email is required!' });
    }
    const trimmedEmail = email.trim().toLowerCase();

    // Grab a dedicated connection so all our queries run on ONE transaction.
    const connection = await pool.getConnection();

    try {
        // 2. Confirm the baby exists and is active (can't link to a discharged/missing baby)
        const [babies] = await connection.query(
            "SELECT id, first_name FROM babies WHERE id = ? AND status = 'active'",
            [baby_id]
        );
        if (babies.length === 0) {
            connection.release();
            return res.status(404).json({ error: 'Active baby not found!' });
        }

        // 3. Does a user with this email already exist?
        const [existingUsers] = await connection.query(
            'SELECT id, role FROM users WHERE email = ?',
            [trimmedEmail]
        );

        // ---- PATH A: existing user ----
        if (existingUsers.length > 0) {
            const existing = existingUsers[0];

            // Only a parent account can be linked as a parent.
            if (existing.role !== 'parent') {
                connection.release();
                return res.status(409).json({ error: 'That email belongs to a non-parent account and cannot be linked as a parent.' });
            }

            // Guard: is this parent ALREADY linked to this baby?
            const [alreadyLinked] = await connection.query(
                'SELECT id FROM parent_baby WHERE parent_id = ? AND baby_id = ?',
                [existing.id, baby_id]
            );
            if (alreadyLinked.length > 0) {
                connection.release();
                return res.status(409).json({ error: 'This parent is already linked to this baby.' });
            }

            // Link only — no new account, no invite. Single write, but keep it simple.
            try {
                await connection.query(
                    `INSERT INTO parent_baby (id, parent_id, baby_id, relationship)
                     VALUES (?, ?, ?, ?)`,
                    [uuidv4(), existing.id, baby_id, relationship]
                );
            } catch (linkErr) {
                connection.release();
                if (linkErr.sqlState === '45000') {
                    return res.status(409).json({ error: 'This baby already has two parents.' });
                }
                throw linkErr;
            }

            connection.release();
            return res.status(201).json({
                message: 'Existing parent linked to baby. No new invite sent.',
                parent_id: existing.id,
                baby_id,
                relationship
            });
        }

        // ---- PATH B: brand-new parent ----
        // Now the name fields matter (a new account needs them).
        if (!first_name || first_name.trim() === '') {
            connection.release();
            return res.status(400).json({ error: 'First name is required for a new parent!' });
        }
        if (!last_name || last_name.trim() === '') {
            connection.release();
            return res.status(400).json({ error: 'Last name is required for a new parent!' });
        }

        const id = uuidv4();
        const hospital_id = await generateSequentialId('users', 'hospital_id', 'P');
        const rawToken = generateRawToken();
        console.log('RAW TOKEN (dev only):', rawToken);
        const tokenHash = hashToken(rawToken);
        const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000)
            .toISOString().slice(0, 19).replace('T', ' ');

        // Two writes → transaction.
        await connection.beginTransaction();

        try {
            // Write 1: the user
            await connection.query(
                `INSERT INTO users
                    (id, hospital_id, first_name, last_name, email, role,
                     is_active, invite_token, invite_token_expires_at, invite_used, created_by)
                 VALUES (?, ?, ?, ?, ?, 'parent', TRUE, ?, ?, FALSE, ?)`,
                [id, hospital_id, first_name.trim(), last_name.trim(), trimmedEmail,
                 tokenHash, expiresAt, req.user.id]
            );

            // Write 2: the parent_baby link (may trip the max-2-parents trigger)
            await connection.query(
                `INSERT INTO parent_baby (id, parent_id, baby_id, relationship)
                 VALUES (?, ?, ?, ?)`,
                [uuidv4(), id, baby_id, relationship]
            );

            await connection.commit();
        } catch (txErr) {
            await connection.rollback();
            connection.release();
            if (txErr.sqlState === '45000') {
                return res.status(409).json({ error: 'This baby already has two parents.' });
            }
            throw txErr;
        }

        connection.release();

        // Email is best-effort, OUTSIDE the transaction (email isn't a DB write to roll back).
        try {
            await notifyInvite(trimmedEmail, first_name.trim(), 'parent', rawToken);
        } catch (emailErr) {
            console.error('SES invite email failed (parent):', emailErr);
            return res.status(201).json({
                message: 'Parent account created and linked, but invite email failed. Use resend-invite.',
                parent: { id, hospital_id, email: trimmedEmail, baby_id, relationship }
            });
        }

        return res.status(201).json({
            message: 'Parent account created, linked to baby, and invite email sent.',
            parent: { id, hospital_id, email: trimmedEmail, baby_id, relationship }
        });

    } catch (err) {
        // Safety net: if we threw before releasing, release now.
        try { connection.release(); } catch (_) {}
        console.error('POST /admin/parents error:', err);
        return res.status(500).json({ error: 'Failed to create/link parent account!' });
    }
});

// POST /api/v1/admin/resend-invite
// Re-issue an invite to a user who was provisioned but hasn't activated yet.
// Overwrites the old token hash + expiry with fresh ones, re-sends the email.
router.post('/resend-invite', authenticate, requireRole('admin', 'nurse'), async (req, res) => {
    const { email } = req.body;

    // 1. Validate
    if (!email || !isValidEmail(email)) {
        return res.status(400).json({ error: 'A valid email is required!' });
    }
    const trimmedEmail = email.trim().toLowerCase();

    try {
        // 2. Find the user
        const [users] = await pool.query(
            'SELECT id, first_name, role, invite_used FROM users WHERE email = ?',
            [trimmedEmail]
        );
        if (users.length === 0) {
            return res.status(404).json({ error: 'No account found with that email!' });
        }
        const user = users[0];

        // 3. Guard: only un-activated nurse/parent accounts can be re-invited
        if (user.role === 'admin') {
            return res.status(409).json({ error: 'Admin accounts are not invite-based.' });
        }
        if (user.invite_used === 1) {
            return res.status(409).json({ error: 'This account is already activated. Nothing to resend.' });
        }

        // 4. Mint a fresh token + expiry, overwrite the old ones
        const rawToken = generateRawToken();
        const tokenHash = hashToken(rawToken);
        const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000)
            .toISOString().slice(0, 19).replace('T', ' ');

        await pool.query(
            `UPDATE users
             SET invite_token = ?, invite_token_expires_at = ?, invite_used = FALSE
             WHERE id = ?`,
            [tokenHash, expiresAt, user.id]
        );

        // 5. Re-send (best-effort, same pattern as create)
        try {
            await notifyInvite(trimmedEmail, user.first_name, user.role, rawToken);
        } catch (emailErr) {
            console.error('SES resend-invite email failed:', emailErr);
            return res.status(200).json({
                message: 'Invite token refreshed, but the email failed to send. Try again.'
            });
        }

        return res.status(200).json({
            message: 'Invite email re-sent successfully.'
        });

    } catch (err) {
        console.error('POST /admin/resend-invite error:', err);
        return res.status(500).json({ error: 'Failed to resend invite!' });
    }
});

// ===================================================================
// ADMIN OVERSIGHT (read-only) — lets an admin see the whole system:
// the nurse roster + each nurse's work, and the parent roster + which
// baby each parent is linked to. Admin-only by design.
// ===================================================================

// GET /api/v1/admin/nurses
// Nurse roster with an activity summary (how much each nurse has done).
router.get('/nurses', authenticate, requireRole('admin'), async (req, res) => {
    try {
        const [rows] = await pool.query(
            `SELECT
                u.id, u.hospital_id, u.first_name, u.last_name, u.email,
                u.is_active, u.invite_used, u.created_at,
                COALESCE(a.total_actions, 0)   AS total_actions,
                COALESCE(a.scheduled_count, 0) AS scheduled_count,
                COALESCE(a.played_count, 0)    AS played_count,
                COALESCE(a.rejected_count, 0)  AS rejected_count,
                a.last_action_at
             FROM users u
             LEFT JOIN (
                SELECT changed_by,
                    COUNT(*)                        AS total_actions,
                    SUM(to_status = 'scheduled')    AS scheduled_count,
                    SUM(to_status = 'played')       AS played_count,
                    SUM(to_status = 'rejected')     AS rejected_count,
                    MAX(changed_at)                 AS last_action_at
                FROM recording_status_history
                GROUP BY changed_by
             ) a ON a.changed_by = u.id
             WHERE u.role = 'nurse'
             ORDER BY u.created_at DESC`
        );
        return res.status(200).json(rows);
    } catch (err) {
        console.error('GET /admin/nurses error:', err);
        return res.status(500).json({ error: 'Failed to load nurses.' });
    }
});

// GET /api/v1/admin/nurses/:id/activity
// Full audit trail of one nurse's actions (what, which baby, when, note).
router.get('/nurses/:id/activity', authenticate, requireRole('admin'), async (req, res) => {
    const { id } = req.params;
    try {
        const [nurses] = await pool.query(
            "SELECT id, hospital_id, first_name, last_name, email, is_active, invite_used, created_at FROM users WHERE id = ? AND role = 'nurse'",
            [id]
        );
        if (nurses.length === 0) {
            return res.status(404).json({ error: 'Nurse not found.' });
        }

        const [activity] = await pool.query(
            `SELECT
                h.id, h.from_status, h.to_status, h.note, h.changed_at,
                r.id AS recording_id, r.title AS recording_title,
                b.id AS baby_id, b.record_number,
                b.first_name AS baby_first_name, b.last_name AS baby_last_name
             FROM recording_status_history h
             JOIN recordings r ON r.id = h.recording_id
             JOIN babies b ON b.id = r.baby_id
             WHERE h.changed_by = ?
             ORDER BY h.changed_at DESC
             LIMIT 200`,
            [id]
        );

        return res.status(200).json({ nurse: nurses[0], activity });
    } catch (err) {
        console.error('GET /admin/nurses/:id/activity error:', err);
        return res.status(500).json({ error: 'Failed to load nurse activity.' });
    }
});

// GET /api/v1/admin/parents
// Parent roster, each with the babies they're linked to (name, ID, relationship).
router.get('/parents', authenticate, requireRole('admin'), async (req, res) => {
    try {
        const [parents] = await pool.query(
            `SELECT id, hospital_id, first_name, last_name, email, is_active, invite_used, created_at
             FROM users WHERE role = 'parent'
             ORDER BY created_at DESC`
        );

        const [links] = await pool.query(
            `SELECT pb.parent_id, pb.relationship,
                    b.id AS baby_id, b.record_number, b.status,
                    b.first_name AS baby_first_name, b.last_name AS baby_last_name
             FROM parent_baby pb
             JOIN babies b ON b.id = pb.baby_id`
        );

        // Group linked babies under each parent.
        const byParent = new Map();
        for (const l of links) {
            if (!byParent.has(l.parent_id)) byParent.set(l.parent_id, []);
            byParent.get(l.parent_id).push({
                baby_id: l.baby_id,
                record_number: l.record_number,
                first_name: l.baby_first_name,
                last_name: l.baby_last_name,
                relationship: l.relationship,
                status: l.status,
            });
        }

        const result = parents.map(p => ({ ...p, babies: byParent.get(p.id) ?? [] }));
        return res.status(200).json(result);
    } catch (err) {
        console.error('GET /admin/parents error:', err);
        return res.status(500).json({ error: 'Failed to load parents.' });
    }
});

// DELETE /api/v1/admin/parents/:id/babies/:babyId
// Admin only: unlink a baby from a parent (e.g. a baby was linked by mistake).
// Hard rule: a parent must always keep at least one baby — the LAST link can
// never be removed here. To fully remove a parent, use DELETE /parents/:id.
// The baby and any recordings stay intact; only the parent_baby link is removed.
router.delete('/parents/:id/babies/:babyId', authenticate, requireRole('admin'), async (req, res) => {
    const { id, babyId } = req.params;

    try {
        // Confirm the parent exists.
        const [parents] = await pool.query(
            "SELECT id FROM users WHERE id = ? AND role = 'parent'",
            [id]
        );
        if (parents.length === 0) {
            return res.status(404).json({ error: 'Parent not found.' });
        }

        // Confirm the link exists.
        const [links] = await pool.query(
            'SELECT id FROM parent_baby WHERE parent_id = ? AND baby_id = ?',
            [id, babyId]
        );
        if (links.length === 0) {
            return res.status(404).json({ error: 'This parent is not linked to that baby.' });
        }

        // Guard: never leave a parent with zero babies.
        const [[{ total }]] = await pool.query(
            'SELECT COUNT(*) AS total FROM parent_baby WHERE parent_id = ?',
            [id]
        );
        if (Number(total) <= 1) {
            return res.status(409).json({
                error: 'A parent must stay linked to at least one baby. Link another baby first, or delete the parent entirely.',
                remaining: Number(total),
            });
        }

        await pool.query(
            'DELETE FROM parent_baby WHERE parent_id = ? AND baby_id = ?',
            [id, babyId]
        );
        return res.status(200).json({ message: 'Baby unlinked from parent.' });
    } catch (err) {
        console.error('DELETE /admin/parents/:id/babies/:babyId error:', err);
        return res.status(500).json({ error: 'Failed to unlink baby from parent.' });
    }
});

// DELETE /api/v1/admin/nurses/:id
// Admin only: permanently delete a nurse account. A nurse who has reviewed,
// scheduled, or played messages has audit rows (recording_status_history) and
// schedules tied to recordings that still exist — deleting the nurse erases
// that trail. So a plain delete is refused with a 409 + count; the caller must
// opt in with ?force=true (surfaced as an explicit "delete anyway" step).
router.delete('/nurses/:id', authenticate, requireRole('admin'), async (req, res) => {
    const { id } = req.params;
    const force = req.query.force === 'true';

    const connection = await pool.getConnection();
    try {
        const [nurses] = await connection.query(
            "SELECT id, first_name, last_name FROM users WHERE id = ? AND role = 'nurse'",
            [id]
        );
        if (nurses.length === 0) {
            connection.release();
            return res.status(404).json({ error: 'Nurse not found.' });
        }
        const nurse = nurses[0];

        // Count the audit trail this nurse is responsible for.
        const [[{ historyCount }]] = await connection.query(
            'SELECT COUNT(*) AS historyCount FROM recording_status_history WHERE changed_by = ?', [id]
        );
        const [[{ scheduleCount }]] = await connection.query(
            'SELECT COUNT(*) AS scheduleCount FROM schedules WHERE scheduled_by = ?', [id]
        );
        const activity = Number(historyCount) + Number(scheduleCount);

        if (activity > 0 && !force) {
            connection.release();
            return res.status(409).json({
                error: `${nurse.first_name} ${nurse.last_name} has ${activity} recorded action(s) in the system’s history. Deleting this nurse permanently erases that activity log. This cannot be undone.`,
                activity_records: activity,
            });
        }

        await connection.beginTransaction();
        // Clear the nurse's audit/scheduling rows (only reachable under force).
        await connection.query('DELETE FROM recording_status_history WHERE changed_by = ?', [id]);
        await connection.query('DELETE FROM schedules WHERE scheduled_by = ?', [id]);
        await connection.query("DELETE FROM users WHERE id = ? AND role = 'nurse'", [id]);
        await connection.commit();
        connection.release();

        return res.status(200).json({
            message: `${nurse.first_name} ${nurse.last_name} was permanently deleted${activity ? `, along with ${activity} history record(s).` : '.'}`
        });
    } catch (err) {
        try { await connection.rollback(); } catch (_) {}
        connection.release();
        if (err.errno === 1451 || err.code === 'ER_ROW_IS_REFERENCED_2') {
            return res.status(409).json({ error: 'This nurse is still referenced by other records and can’t be fully deleted.' });
        }
        console.error('DELETE /admin/nurses/:id error:', err);
        return res.status(500).json({ error: 'Failed to delete nurse.' });
    }
});

// DELETE /api/v1/admin/parents/:id
// Admin only: permanently delete a parent account. Their baby links are always
// cleaned automatically. Their recordings (and each recording's playback /
// history / schedule rows) are clinical history — a plain delete is refused
// with a 409 + count, and the caller must opt in with ?force=true.
router.delete('/parents/:id', authenticate, requireRole('admin'), async (req, res) => {
    const { id } = req.params;
    const force = req.query.force === 'true';

    const connection = await pool.getConnection();
    try {
        const [parents] = await connection.query(
            "SELECT id, first_name, last_name FROM users WHERE id = ? AND role = 'parent'",
            [id]
        );
        if (parents.length === 0) {
            connection.release();
            return res.status(404).json({ error: 'Parent not found.' });
        }
        const parent = parents[0];

        const recordings = await getRecordingsBy(connection, 'parent_id', id);
        if (recordings.length > 0 && !force) {
            connection.release();
            return res.status(409).json({
                error: `${parent.first_name} ${parent.last_name} has sent ${recordings.length} recording(s). Deleting this parent permanently erases those messages and their history. This cannot be undone.`,
                recordings: recordings.length,
            });
        }

        const s3Keys = recordings.map(r => r.s3_key);
        const recordingIds = recordings.map(r => r.id);

        await connection.beginTransaction();
        await deleteRecordingsCascade(connection, recordingIds);
        await connection.query('DELETE FROM parent_baby WHERE parent_id = ?', [id]);
        await connection.query("DELETE FROM users WHERE id = ? AND role = 'parent'", [id]);
        await connection.commit();
        connection.release();

        for (const key of s3Keys) await deleteAudio(key);

        return res.status(200).json({
            message: `${parent.first_name} ${parent.last_name} was permanently deleted${recordingIds.length ? `, along with ${recordingIds.length} recording(s).` : '.'}`
        });
    } catch (err) {
        try { await connection.rollback(); } catch (_) {}
        connection.release();
        if (err.errno === 1451 || err.code === 'ER_ROW_IS_REFERENCED_2') {
            return res.status(409).json({ error: 'This parent is still referenced by other records and can’t be fully deleted.' });
        }
        console.error('DELETE /admin/parents/:id error:', err);
        return res.status(500).json({ error: 'Failed to delete parent.' });
    }
});

module.exports = router;