// migrate.js
//
// Tiny zero-dependency migration runner. Applies every *.sql file in
// database/migrations that hasn't been applied yet, in filename order, and
// records each one in a `schema_migrations` table so it never runs twice.
//
// Two ways it runs:
//   1. Locally / manually:  npm run migrate   (from server/)
//   2. Automatically:       called by index.js on server startup, so a deploy
//      brings the DB up to date on its own (set RUN_MIGRATIONS=false to skip).
//
// Migrations should be written idempotent where practical (see 001) — DDL in
// MySQL auto-commits, so a file can't be rolled back as one unit if it fails
// halfway. Keep each migration small and safe to re-run.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'database', 'migrations');

async function runMigrations() {
    // A dedicated connection with multipleStatements — migration files contain
    // several statements. We do NOT enable this on the shared app pool (config/db)
    // on purpose: it widens SQL-injection blast radius, and app queries are all
    // single-statement.
    const connection = await mysql.createConnection({
        host: process.env.DB_HOST,
        port: process.env.DB_PORT,
        database: process.env.DB_NAME,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        multipleStatements: true,
        timezone: 'Z',
    });

    try {
        await connection.query(`
            CREATE TABLE IF NOT EXISTS schema_migrations (
                filename   VARCHAR(255) PRIMARY KEY,
                applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        if (!fs.existsSync(MIGRATIONS_DIR)) {
            console.log('[migrate] No migrations directory — nothing to do.');
            return { applied: 0, skipped: 0 };
        }

        const files = fs.readdirSync(MIGRATIONS_DIR)
            .filter(f => f.endsWith('.sql'))
            .sort(); // 001_, 002_, ... apply in order

        const [rows] = await connection.query('SELECT filename FROM schema_migrations');
        const done = new Set(rows.map(r => r.filename));

        let applied = 0, skipped = 0;
        for (const file of files) {
            if (done.has(file)) { skipped++; continue; }

            const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8').trim();
            if (sql) {
                console.log(`[migrate] Applying ${file} ...`);
                await connection.query(sql);
            }
            await connection.query('INSERT INTO schema_migrations (filename) VALUES (?)', [file]);
            applied++;
            console.log(`[migrate] ✓ ${file}`);
        }

        console.log(`[migrate] Done. ${applied} applied, ${skipped} already up to date.`);
        return { applied, skipped };
    } finally {
        await connection.end();
    }
}

module.exports = { runMigrations };

// Allow running directly: `node migrate.js` (npm run migrate).
if (require.main === module) {
    runMigrations()
        .then(() => process.exit(0))
        .catch(err => {
            console.error('[migrate] FAILED:', err.message);
            process.exit(1);
        });
}
