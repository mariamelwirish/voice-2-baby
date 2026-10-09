# Remote Reading for Newborns — Local Development Setup

NICU parents upload voice recordings; nurses review and schedule them for playback to their babies through Raspberry Pi speakers.

**Stack:** React + Vite · Node.js / Express · MySQL 8.4 · AWS (S3, SES, IoT Core) · Raspberry Pi + MQTT

Locally, MySQL runs in Docker and AWS S3/SES are emulated by **LocalStack**, so you don't need any real AWS credentials to work on most of the app.

---

## Table of Contents
1. [Prerequisites](#1-prerequisites)
2. [Clone & Branch](#2-clone--branch)
3. [Environment Files](#3-environment-files)
4. [Start the Containers](#4-start-the-containers)
5. [Verify Database & LocalStack](#5-verify-database--localstack)
6. [Seed the Admin Account](#6-seed-the-admin-account)
7. [Run the App](#7-run-the-app)
8. [Activate Nurse & Parent Accounts](#8-activate-nurse--parent-accounts)
9. [Smoke Test](#9-smoke-test)
10. [What Doesn't Work Locally](#10-what-doesnt-work-locally)
11. [Everyday Commands](#11-everyday-commands)
12. [Troubleshooting](#12-troubleshooting)
13. [Git Workflow](#13-git-workflow)

---

## 1. Prerequisites

| Tool | Notes |
|---|---|
| **Git** | — |
| **Node.js 22+** | Node 20 works today, but the AWS SDK requires ≥22 for releases after Jan 2027 |
| **Docker Desktop** | Keep it updated — old versions ship an outdated Compose |
| **Python 3** | Only used to pretty-print JSON in a few commands |

---

## 2. Clone & Branch

```bash
git clone https://github.com/mariamelwirish/remote-reading.git
cd remote-reading
git checkout dev
git checkout -b feature/<your-feature>
```

> ⚠️ **Never push to `main`.** Every push to `main` triggers GitHub Actions, which deploys straight to the production server. See [Git Workflow](#13-git-workflow).

---

## 3. Environment Files

You need **three** env files. None of them (except `client/.env.production`) are committed.

### 3.1 Root `.env` — read by Docker Compose

Must sit in the **same folder as `docker-compose.yml`**. Compose reads `${...}` values from here.

```env
MYSQL_ROOT_PASSWORD=<pick-a-root-password>
DB_NAME=remote_reading
DB_USER=rr_app
DB_PASSWORD=<pick-an-app-password>
```

> `DB_USER` must **not** be `root` — the MySQL image refuses to create a user called `root`.

### 3.2 `server/.env` — read by the Node backend

The `DB_*` values **must match** the root `.env`.

```env
PORT=3000

# Database (Docker MySQL)
DB_HOST=localhost
DB_PORT=3306
DB_NAME=remote_reading
DB_USER=rr_app
DB_PASSWORD=<same-app-password-as-root-.env>

# Auth
JWT_SECRET=<any-long-random-string>

# CORS
ALLOWED_ORIGINS=http://localhost:5173

# AWS → LocalStack
AWS_REGION=us-east-1
AWS_ENDPOINT_URL=http://localhost:4566
AWS_ACCESS_KEY_ID=test
AWS_SECRET_ACCESS_KEY=test
AWS_S3_BUCKET=remote-reading-audio
SES_SENDER_EMAIL=remotereading@hotmail.com
```

> 🔑 **`AWS_ENDPOINT_URL` is what routes S3 and SES to LocalStack.** If it's missing or misspelled, the SDK talks to *real* AWS with the dummy `test` keys and you'll get `InvalidClientTokenId`. In production this variable is simply not set.

Generate a JWT secret quickly with:
```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

### 3.3 `client/.env.development` — read by Vite

```env
VITE_API_URL=http://localhost:3000/api/v1
```

`client/.env.production` is already committed and points at the production URL — don't edit it.

---

## 4. Start the Containers

From the folder that contains `docker-compose.yml`:

```bash
# 1. Sanity-check that Compose sees your variables
docker compose config | grep -A6 environment
#    → MYSQL_ROOT_PASSWORD must show a value, not ""

# 2. Start fresh (safe on first run — there's no data yet)
docker compose down -v
docker compose up -d

# 3. Watch MySQL initialise
docker logs -f remote-reading-mysql2
```

Wait until you see **`ready for connections`**, then press `Ctrl+C` to stop following the logs.

What happens automatically on first boot:

| Container | What it does |
|---|---|
| `remote-reading-mysql2` | Runs `database/schema.sql` from `docker-entrypoint-initdb.d` — creates all tables and the `enforce_max_two_parents` trigger |
| `remote-reading-localstack2` | Runs the scripts in `localstack-init/` — creates the S3 bucket and verifies the SES sender |

> ℹ️ The schema only loads when the MySQL volume is **empty**. After any change to `schema.sql`, you must reset with `docker compose down -v && docker compose up -d` (this wipes local data).

---

## 5. Verify Database & LocalStack

```bash
# Tables + trigger
docker exec -it remote-reading-mysql2 mysql -u root -p remote_reading \
  -e "SHOW TABLES; SHOW TRIGGERS;"

# S3 bucket
docker exec remote-reading-localstack2 awslocal s3 ls
```

You should see:
- ✅ The schema tables (`users`, `rooms`, `babies`, `parent_baby`, `recordings`, `recording_status_history`, `schedules`, `playback_log`, …)
- ✅ The `enforce_max_two_parents` trigger
- ✅ The `remote-reading-audio` bucket

---

## 6. Seed the Admin Account

There is no signup for admins — the first one is inserted by hand.

### 6.1 Install server dependencies and hash a password

```bash
cd server
npm install
node -e "console.log(require('bcryptjs').hashSync('YourLocalPassword', 12))"
```

Copy the output (starts with `$2b$12$...`).

### 6.2 Open MySQL

```bash
docker exec -it remote-reading-mysql2 mysql -u root -p remote_reading
```

Enter your `MYSQL_ROOT_PASSWORD`.

### 6.3 Insert the admin

```sql
INSERT INTO users
  (id, hospital_id, first_name, last_name, email, role,
   password_hash, is_active, invite_used, created_by)
VALUES
  (UUID(), 'A-00001', 'Local', 'Admin', 'you@example.com', 'admin',
   '<paste-hash-here>', TRUE, TRUE, NULL);
```

> ✍️ **Type the email by hand** — pasting from rendered markdown/chat can silently corrupt it.

### 6.4 Check it

```sql
SELECT hospital_id, email, role, is_active,
       LEFT(password_hash, 7) AS hash_prefix
FROM users;
exit
```

`hash_prefix` should read `$2b$12$` (or `$2a$12$`).

---

## 7. Run the App

**Terminal 1 — backend**
```bash
cd server
npm run dev
```

Expected output:
```
Database connected successfully
[migrate] Applying 001_... ✓
[migrate] Done.
Scheduler started — ...
Server running on port 3000
```

> Migrations in `server/` are applied **automatically on startup** — don't run them by hand.

**Terminal 2 — frontend**
```bash
cd client
npm install
npm run dev
```

Check:
- `http://localhost:3000/` → `{"message":"Remote Reading API is running"}`
- `http://localhost:5173` → log in with the admin email + password from step 6

> 🔁 nodemon only watches `.js/.mjs/.cjs/.json` files. **After editing `server/.env`, type `rs`** in the server terminal to restart.

---

## 8. Activate Nurse & Parent Accounts

Nurses and parents are created by the admin and activate their account via an invite token. Locally there are two ways to get that token:

### Option A — Server log (fastest)

When an invite is created, the server prints:
```
RAW TOKEN (dev only): d6f578ca0064a190...
```

Open:
```
http://localhost:5173/signup?token=<RAW_TOKEN>
```

### Option B — LocalStack SES inbox

LocalStack captures emails instead of sending them:
```bash
curl -s http://localhost:4566/_aws/ses | python3 -m json.tool
```

Copy the signup link/token from the email body.

### Then
1. Open the signup link — a **private/incognito window** keeps your admin session intact
2. Set a password (8+ characters) → **Activate Account**
3. Log in at `/login` with that user's email and new password

Tokens are **single-use** and expire after **48 hours**. Use *Resend invite* to generate a new one.

---

## 9. Smoke Test

Run this once after setup to confirm everything works end to end:

1. **Admin** → create a room
2. **Admin** → create a baby in that room
3. **Admin** → invite a nurse and a parent (linked to the baby)
4. Activate both accounts ([step 8](#8-activate-nurse--parent-accounts))
5. **Parent** → upload a recording
6. **Nurse** → approve + schedule it, and confirm the status updates on both dashboards

If all six pass, your setup is good.

---

## 10. What Doesn't Work Locally

| Feature | Why | Workaround |
|---|---|---|
| **Play / Stop / scheduled playback** | LocalStack (free) doesn't emulate AWS IoT Core | Only needed if you're working on the playback path — requires real AWS credentials with `iot:Connect`, `iot:Subscribe`, `iot:Receive`, `iot:Publish`, `iot:DescribeEndpoint`, plus a device registered with `scripts/register-device.sh` |
| **Real email delivery** | SES is emulated | Read emails via `curl http://localhost:4566/_aws/ses` |
| **Persistent audio files** | LocalStack doesn't persist S3 data across restarts | Old recordings will 404 after a restart — just upload new ones |

You may see IoT-related errors in the server log without real credentials. Everything else (auth, rooms, babies, recordings, review, discharge, dashboards) works normally.

---

## 11. Everyday Commands

```bash
# Start / stop containers (keeps data)
docker compose up -d
docker compose stop

# Full reset — wipes the DB, reloads schema.sql
docker compose down -v && docker compose up -d

# Open MySQL shell
docker exec -it remote-reading-mysql2 mysql -u root -p remote_reading

# Container status / logs
docker compose ps
docker logs --tail 50 remote-reading-mysql2
docker logs --tail 50 remote-reading-localstack2

# LocalStack: list bucket contents / captured emails
docker exec remote-reading-localstack2 awslocal s3 ls s3://remote-reading-audio --recursive
curl -s http://localhost:4566/_aws/ses | python3 -m json.tool
```

> `docker compose ...` commands must be run from the folder with `docker-compose.yml`. `docker exec` / `docker logs` work from anywhere.

---

## 12. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| MySQL `Exited (1)` with *"Database is uninitialized and password option is not specified"* | Compose didn't find the root `.env` → `MYSQL_ROOT_PASSWORD` empty | Create/fix the root `.env` ([3.1](#31-root-env--read-by-docker-compose)), then `docker compose down -v && docker compose up -d`. Restarting the container alone won't help — env is baked in at creation |
| MySQL `Exited (1)` with *"ERROR ... in file schema.sql"* | Schema failed during init | Fix the SQL, then `down -v` and `up -d` |
| MySQL `Exited (0)` after reboot | No restart policy | `docker start remote-reading-mysql2` (or `docker compose up -d`) |
| `port is already allocated` on 3306 | Another MySQL (Homebrew, an older container) is using the port | Stop it (`brew services stop mysql`, `docker ps -a`), or map `"3307:3306"` and set `DB_PORT=3307` |
| `container ... is not running` on `docker exec` | Container stopped/crashed | `docker logs remote-reading-mysql2` to see why |
| `InvalidClientTokenId` / 403 from SES or S3 | `AWS_ENDPOINT_URL` not set → requests go to real AWS | Add `AWS_ENDPOINT_URL=http://localhost:4566` to `server/.env`, then `rs` |
| `Database connection failed` on server start | Container not ready, or `DB_*` mismatch between the two `.env` files | Wait for `ready for connections`; double-check credentials match |
| Schema change not showing up | Init scripts only run on an empty volume | `docker compose down -v && docker compose up -d` |
| Bucket missing (esp. on Windows clones) | `localstack-init/*.sh` has CRLF line endings or lost its executable bit | Add `*.sh text eol=lf` to `.gitattributes`, re-clone or re-checkout, and run `chmod +x localstack-init/*.sh` |
| `Invalid or expired invite token` | Token already used or older than 48h | Resend the invite and use the new `RAW TOKEN` |
| CORS error in the browser | Frontend origin not allowed | Make sure `ALLOWED_ORIGINS=http://localhost:5173` in `server/.env` |

---

## 13. Git Workflow

```
feature/<name>  ──PR──▶  dev  ──merge──▶  main  ──▶  🚀 auto-deploy to production
```

- Branch from `dev`, open PRs into `dev`
- Only the maintainer merges `dev` → `main`
- **Never push directly to `main`**
- Never commit `.env` files, keys, or certificates (`client/.env.production` is the one intentional exception — it holds only the public API URL)
- Schema changes go through a new migration file; production database changes are applied only **after** the code is merged to `main`

Before changing backend logic, schema, or IoT code, read the project's architecture decisions doc — several invariants (room-availability checks, transaction boundaries, S3 key handling) are easy to break.