// scheduler.js
//
// Runs inside the same Node process as the Express server. Every minute,
// checks the schedules table for anything due and triggers playback —
// the exact same steps POST /recordings/:id/play does manually, just
// fired by a clock instead of an HTTP request.

const cron = require('node-cron');
const pool = require('./config/db');
const { getPresignedUrl } = require('./utils/s3');
const { publishPlay } = require('./utils/iot');

// Guards against overlapping runs: if one minute's pass is still working when
// the next cron tick fires, we skip the new run rather than let both SELECT the
// same 'pending' schedules and fire the play command twice (which the device
// would play as overlapping audio — an "echo").
let isProcessing = false;

async function processDueSchedules() {
    if (isProcessing) {
        console.warn('Scheduler: previous run still in progress, skipping this tick.');
        return;
    }
    isProcessing = true;

    const connection = await pool.getConnection();

    try {
        const [dueSchedules] = await connection.query(
            `SELECT s.id AS schedule_id, s.recording_id
             FROM schedules s
             WHERE s.status = 'pending' AND s.scheduled_time <= NOW()`
        );

        if (dueSchedules.length === 0) {
            return; // nothing to do this minute — the common case
        }

        console.log(`Scheduler: ${dueSchedules.length} recording(s) due for playback.`);

        for (const due of dueSchedules) {
            await triggerScheduledPlayback(due.schedule_id, due.recording_id);
        }
    } catch (err) {
        console.error('Scheduler: error checking due schedules:', err);
    } finally {
        connection.release();
        isProcessing = false;
    }
}

async function triggerScheduledPlayback(schedule_id, recording_id) {
    const connection = await pool.getConnection();

    try {
        const [recordings] = await connection.query(
            `SELECT r.*, b.id AS baby_id
             FROM recordings r
             JOIN babies b ON r.baby_id = b.id
             WHERE r.id = ?`,
            [recording_id]
        );

        if (recordings.length === 0) {
            console.error(`Scheduler: recording ${recording_id} not found, skipping.`);
            return;
        }

        const recording = recordings[0];

        // Guard: a recording could have been rejected, discharged-cancelled,
        // or already played through some other path between when it was
        // scheduled and now. Don't blindly force it to 'played'.
        if (recording.status !== 'scheduled') {
            console.warn(
                `Scheduler: recording ${recording_id} is '${recording.status}', not 'scheduled' — skipping and marking schedule cancelled.`
            );
            await connection.query(
                `UPDATE schedules SET status = 'cancelled' WHERE id = ?`,
                [schedule_id]
            );
            return;
        }

        const [devices] = await connection.query(
            'SELECT id, device_code, is_online FROM devices WHERE baby_id = ? AND is_active = TRUE',
            [recording.baby_id]
        );

        if (devices.length === 0) {
            console.error(
                `Scheduler: no active device assigned to baby ${recording.baby_id} for recording ${recording_id}, cannot play.`
            );
            // Leave the schedule as 'pending' rather than 'triggered' — there
            // was no device to trigger, so this isn't really "done." A nurse
            // can assign a device and the schedule will be picked up next run.
            return;
        }

        const device = devices[0];

        if (!device.is_online) {
            console.warn(
                `Scheduler: device ${device.device_code} is offline, cannot play recording ${recording_id}. Leaving schedule pending for next run.`
            );
            // Same reasoning as "no device assigned" — this wasn't genuinely
            // attempted, so the schedule stays 'pending' and will be retried
            // next minute, in case the device reconnects by then.
            return;
        }

        // Presigned URL generated before the transaction — same reasoning
        // as everywhere else this pattern appears.
        const presigned_url = await getPresignedUrl(recording.s3_key);

        await connection.beginTransaction();

        await connection.query(
            `UPDATE schedules SET status = 'triggered' WHERE id = ?`,
            [schedule_id]
        );

        await connection.query(
            `UPDATE recordings
             SET status = 'played', reviewed_at = COALESCE(reviewed_at, NOW())
             WHERE id = ?`,
            [recording_id]
        );

        // changed_by has no natural "user" here — it was the scheduler, not
        // a person. recording_status_history.changed_by is NOT NULL, so we
        // fall back to whoever originally reviewed/scheduled it, since that's
        // the closest real user tied to this event.
        const [reviewerRows] = await connection.query(
            'SELECT reviewed_by FROM recordings WHERE id = ?',
            [recording_id]
        );
        const changed_by = reviewerRows[0].reviewed_by;

        await connection.query(
            `INSERT INTO recording_status_history (recording_id, from_status, to_status, changed_by, note)
             VALUES (?, 'scheduled', 'played', ?, 'Automatic scheduled playback')`,
            [recording_id, changed_by]
        );

        await connection.commit();

        console.log(`Scheduler: recording ${recording_id} marked played, publishing to device ${device.device_code}...`);

        // MQTT publish after commit — same warn-don't-rollback pattern as
        // the manual /play route. If the Pi later reports a failure over
        // MQTT, iotSubscriber.js will revert this back to pending_review.
        try {
            await publishPlay(device.device_code, { recording_id, presigned_url, trigger_type: 'scheduled' });
            console.log(`Scheduler: play command sent to ${device.device_code}.`);
        } catch (mqttErr) {
            console.error(`Scheduler: IoT publish failed for ${device.device_code}:`, mqttErr);
            // DB state is already committed and correct; the device just
            // didn't receive it. This is exactly the gap the "Pi offline
            // recovery" sweep and Last Will and Testament are meant to catch.
        }
    } catch (err) {
        await connection.rollback();
        console.error(`Scheduler: error processing recording ${recording_id}:`, err);
    } finally {
        connection.release();
    }
}

// The ONLY thing that actively marks a device offline. The Last Will (LWT) path
// in iotSubscriber.js is best-effort and often doesn't fire (WiFi dies before
// the will registers, broker hiccup, subscriber briefly deaf). Without this
// sweep, is_online stays TRUE forever after a silent drop — which is exactly the
// "still shows online 10 minutes later" bug. A device that hasn't sent a
// heartbeat within the window is offline, period. Heartbeats are every 15s, so
// 45s = ~3 missed beats before we flip it (one blip won't).
const OFFLINE_AFTER_SECONDS = 45;

async function sweepOfflineDevices() {
    try {
        const [result] = await pool.query(
            `UPDATE devices
             SET is_online = FALSE
             WHERE is_online = TRUE
               AND (last_seen_at IS NULL OR last_seen_at < NOW() - INTERVAL ? SECOND)`,
            [OFFLINE_AFTER_SECONDS]
        );
        if (result.affectedRows > 0) {
            console.log(`Scheduler: marked ${result.affectedRows} device(s) offline (no heartbeat in ${OFFLINE_AFTER_SECONDS}s).`);
        }
    } catch (err) {
        console.error('Scheduler: error sweeping offline devices:', err);
    }
}

function startScheduler() {
    cron.schedule('* * * * *', () => {
        processDueSchedules();
        recoverStalePlaybacks();
    });
    // Offline detection runs on its own fast cadence (every 15s) so a dropped
    // device shows offline in ~45-60s, not once a minute.
    sweepOfflineDevices();
    setInterval(sweepOfflineDevices, 15000);
    console.log('Scheduler started — schedules every minute, device-offline sweep every 15s.');
}

// Runs alongside processDueSchedules() every minute. Catches recordings
// that were sent to a device but never got any confirmation back at all —
// the slow backstop for cases the fast paths (iotSubscriber.js message
// handling, Last Will and Testament) can't catch, e.g. a broker-side issue
// with the will message itself.
async function recoverStalePlaybacks() {
    const connection = await pool.getConnection();

    try {
        // Timeout is duration-aware: a recording needs at least its own
        // length to genuinely finish playing, plus a fixed buffer for
        // fetch time and network delay — not a flat window regardless
        // of how long the audio actually is.
        const BUFFER_SECONDS = 120;

        const [staleRecordings] = await connection.query(
            `SELECT r.id, r.duration_seconds, r.reviewed_at, r.reviewed_by
             FROM recordings r
             LEFT JOIN playback_log pl ON pl.recording_id = r.id AND pl.played_at >= r.reviewed_at
             WHERE r.status = 'played'
               AND pl.id IS NULL
               AND r.reviewed_at IS NOT NULL
               AND r.reviewed_at <= NOW() - INTERVAL (r.duration_seconds + ?) SECOND`,
            [BUFFER_SECONDS]
        );

        if (staleRecordings.length === 0) {
            return;
        }

        console.log(`Scheduler: ${staleRecordings.length} recording(s) never confirmed by their device, reverting.`);

        for (const stale of staleRecordings) {
            await connection.query(
                `UPDATE recordings SET status = 'pending_review' WHERE id = ?`,
                [stale.id]
            );

            await connection.query(
                `INSERT INTO recording_status_history (recording_id, from_status, to_status, changed_by, note)
                 VALUES (?, 'played', 'pending_review', ?, 'No confirmation received from device within timeout window')`,
                [stale.id, stale.reviewed_by]
            );

            console.warn(`Scheduler: recording ${stale.id} timed out waiting for device confirmation, reverted to pending_review.`);
        }
    } catch (err) {
        console.error('Scheduler: error checking for stale playbacks:', err);
    } finally {
        connection.release();
    }
}

module.exports = { startScheduler };