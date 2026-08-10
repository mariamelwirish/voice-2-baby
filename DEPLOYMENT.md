# Deployment Notes

## Server Setup (EC2)

### Domain
- Domain: remotereading.duckdns.org
- Provider: DuckDNS (free subdomain)
- Points to: 3.208.245.69 (Elastic IP)

### Nginx
- Installed on EC2 as reverse proxy
- Listens on port 80 and 443
- Forwards requests to Node.js on port 3000
- Config file: /etc/nginx/conf.d/remote-reading.conf

### HTTPS
- Certificate provider: Let's Encrypt (via Certbot)
- Auto-renews every 90 days
- Certificate location: /etc/letsencrypt/live/remotereading.duckdns.org/

### PM2
- Node.js process manager
- App name: remote-reading-server
- Auto-starts on server reboot

### Environment
- Node.js: v20.20.2
- npm: 11.12.1
- PM2: 6.0.14

## Database migrations

Schema changes live as ordered `*.sql` files in `database/migrations/`
(`001_...`, `002_...`). A small runner (`server/migrate.js`) applies any that
haven't run yet and records them in a `schema_migrations` table, so each file
runs exactly once per database.

**Automatic (server):** migrations run on startup, before the app serves
traffic. So a normal deploy applies them with no extra step:

```bash
cd server && git pull && npm install
pm2 restart remote-reading-server   # runs pending migrations, then starts
```

If a migration fails, the server refuses to start (visible failure beats a
half-migrated schema). Opt out with `RUN_MIGRATIONS=false` in the env.

**Manual (local or server):** run them without (re)starting the app:

```bash
cd server && npm run migrate
```

Reads DB creds from the same `.env` as the app. Safe to run repeatedly —
already-applied files are skipped.

**Fresh database:** load `database/schema.sql` first (it's the full current
schema), then `npm run migrate` — the migrations are written idempotent, so
they no-op cleanly on a schema that already has the change.

**Adding a migration:** create the next-numbered file in `database/migrations/`
and, where practical, make it safe to re-run (guard `ALTER`s with an
`information_schema` check — MySQL has no `ADD COLUMN IF NOT EXISTS`). Also
update `schema.sql` so fresh installs get the change directly.