// recordingCascade.js
//
// Shared helper for permanently deleting recordings and everything that
// references them. There is no ON DELETE CASCADE in the schema, so the child
// rows (playback_log, status history, schedules) must be cleared before the
// recordings themselves, in dependency order, inside a caller-owned transaction.
//
// The caller passes an existing transactional `connection` (so the whole
// parent operation — baby/parent delete — stays atomic). S3 objects are NOT
// touched here: the caller collects the s3_keys and deletes them best-effort
// AFTER the DB transaction commits (S3 isn't transactional with MySQL).

// Fetch id + s3_key for every recording belonging to a column value
// (e.g. baby_id or parent_id). Returns [] if none.
async function getRecordingsBy(connection, column, value) {
    const allowed = ['baby_id', 'parent_id'];
    if (!allowed.includes(column)) throw new Error(`Unsupported column: ${column}`);
    const [rows] = await connection.query(
        `SELECT id, s3_key FROM recordings WHERE ${column} = ?`,
        [value]
    );
    return rows;
}

// Delete the given recordings and all rows that reference them, in FK-safe
// order. No-op when the list is empty.
async function deleteRecordingsCascade(connection, recordingIds) {
    if (!recordingIds || recordingIds.length === 0) return;
    await connection.query('DELETE FROM playback_log WHERE recording_id IN (?)', [recordingIds]);
    await connection.query('DELETE FROM recording_status_history WHERE recording_id IN (?)', [recordingIds]);
    await connection.query('DELETE FROM schedules WHERE recording_id IN (?)', [recordingIds]);
    await connection.query('DELETE FROM recordings WHERE id IN (?)', [recordingIds]);
}

module.exports = { getRecordingsBy, deleteRecordingsCascade };
