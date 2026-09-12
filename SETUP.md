# Voice2Baby — Local Setup (A–Z)

This guide takes you from a fresh `git clone` to a running local stack: the
React client, the Node/Express API, a MySQL database, and LocalStack (a local
stand-in for AWS S3 + SES). No AWS account is required for local development.

> **What is Voice2Baby?** Parents record their voice remotely; the recording
> plays in the NICU room through a Raspberry Pi speaker so babies hear their
> parents when they can't be there.

---

## Architecture at a glance

| Piece      | Tech                     | Runs on (local)        |
| ---------- | ------------------------ | ---------------------- |
| **Client** | React + Vite             | http://localhost:5173  |
| **Server** | Node + Express, API `/api/v1` | http://localhost:3000  |
| **DB**     | MySQL 8.4 (Docker)       | localhost:3306         |
| **AWS**    | LocalStack (S3 + SES)    | http://localhost:4566  |
| **Device** | Raspberry Pi (Python) over AWS IoT MQTT | not needed for local dev |

The client talks to the server through Vite's dev proxy, so everything is
same-origin (no CORS headaches). The server talks to MySQL and to LocalStack.

---

## 0. Prerequisites

Install these first:

- **Node.js 18+** and npm — `node -v`
- **Docker Desktop** (for MySQL + LocalStack) — `docker -v`
- **Git**

---

## 1. Clone

```bash
git clone <repo-url>
cd Code
```

---

## 2. Configure environment files

There are **three** `.env` files. Copy each from its `.example` and fill in
values. See [Environment variable reference](#environment-variable-reference)
below for what every field means.

```bash
cp .env.example .env                     # root — used by docker-compose
cp server/.env.example server/.env       # backend
cp client/.env.example client/.env       # frontend
```

**Key rule:** `DB_NAME`, `DB_USER`, and `DB_PASSWORD` must be **identical** in
the root `.env` (which seeds the MySQL container) and `server/.env` (which the
app uses to connect). If they drift, the server can't log in to the database.

Generate the secrets:

```bash
# JWT_SECRET and DEVICE_PROVISION_SECRET
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

For local dev you can leave the AWS credentials as dummy values — LocalStack
doesn't check them.

---

## 3. Start the infrastructure (Docker)

From the repo root:

```bash
docker compose up -d
```

This starts two containers:

- **remote-reading-mysql** — MySQL 8.4 on port 3306. On first run it creates the
  database and applies `database/schema.sql`.
- **remote-reading-localstack** — S3 + SES on port 4566. On startup it creates
  the `remote-reading-audio` S3 bucket (`localstack-init/create-bucket.sh`).

Check they're healthy:

```bash
docker compose ps
docker compose logs -f mysql        # Ctrl-C to stop tailing
```

> **Note:** MySQL only runs `schema.sql` on a *fresh* volume. If you change the
> schema and need a clean slate: `docker compose down -v` (⚠️ deletes all local
> DB data) then `docker compose up -d`.

---

## 4. Install dependencies

```bash
cd server && npm install
cd ../client && npm install
```

---

## 5. Run database migrations

The server runs migrations automatically on startup (unless
`RUN_MIGRATIONS=false`), but you can run them manually:

```bash
cd server
npm run migrate
```

This applies every unapplied `*.sql` in `database/migrations/` in order and
records them in the `schema_migrations` table so they never run twice.

### (Optional) Seed an admin account

`database/seed.sql` inserts a starter admin user. It's gitignored (contains a
password hash), so ask a teammate for it if you don't have it, then:

```bash
docker exec -i remote-reading-mysql mysql -u root -p"$MYSQL_ROOT_PASSWORD" remote_reading < database/seed.sql
```

---

## 6. Run the app

Two terminals:

```bash
# Terminal 1 — backend
cd server && npm run dev        # nodemon, restarts on change

# Terminal 2 — frontend
cd client && npm run dev        # Vite
```

Open **http://localhost:5173**.

You should see `Database connected successfully` and `Server running on port
3000` in the backend terminal.

---

## Environment variable reference

### Root `.env` (consumed by `docker-compose.yaml`)

Only used to provision the **local** MySQL container.

| Variable              | What it does                                                        |
| --------------------- | ------------------------------------------------------------------- |
| `DB_NAME`             | Database created inside the container. Match `server/.env`.         |
| `DB_USER`             | App DB user created inside the container. Match `server/.env`.      |
| `DB_PASSWORD`         | Password for that user. Match `server/.env`.                        |
| `MYSQL_ROOT_PASSWORD` | Root password for the local MySQL container. Local-only; pick anything. |

### `server/.env` (backend)

**Server**
| Variable     | What it does                                                             |
| ------------ | ------------------------------------------------------------------------ |
| `PORT`       | Port the API listens on. Keep `3000` — the client dev proxy targets it.  |
| `NODE_ENV`   | `development` or `production`. Logging/behaviour only.                   |

**JWT (login tokens)**
| Variable         | What it does                                                                       |
| ---------------- | ---------------------------------------------------------------------------------- |
| `JWT_SECRET`     | Signs/verifies login tokens. Long random string. Rotating it logs everyone out.    |
| `JWT_EXPIRES_IN` | Token lifetime, e.g. `8h`, `1d`, `30m`.                                             |

**Database (MySQL)**
| Variable         | What it does                                                          |
| ---------------- | --------------------------------------------------------------------- |
| `DB_HOST`        | `127.0.0.1` for local Docker; the RDS endpoint in production.         |
| `DB_PORT`        | `3306`.                                                               |
| `DB_NAME`        | Database name. Must match root `.env`.                                |
| `DB_USER`        | DB user. Must match root `.env`.                                      |
| `DB_PASSWORD`    | DB password. Must match root `.env`.                                  |
| `RUN_MIGRATIONS` | `false` skips auto-migration on startup. Default is to run them.      |

**AWS**
| Variable                | What it does                                                                                          |
| ----------------------- | ---------------------------------------------------------------------------------------------------- |
| `AWS_REGION`            | AWS region, e.g. `us-east-1`.                                                                         |
| `AWS_S3_BUCKET`         | Bucket for audio recordings (`remote-reading-audio`).                                                |
| `AWS_ENDPOINT_URL`      | **Local dev only.** Set to `http://localhost:4566` to hit LocalStack. **Leave unset in production** so the SDK uses real AWS. |
| `AWS_ACCESS_KEY_ID`     | AWS key. Dummy value works locally. In prod use a real IAM key *or* omit and rely on the EC2 role.   |
| `AWS_SECRET_ACCESS_KEY` | AWS secret. Same rule as above.                                                                      |

**SES (email: invites, password resets)**
| Variable            | What it does                                             |
| ------------------- | -------------------------------------------------------- |
| `SES_SENDER_EMAIL`  | Verified "from" address for outgoing email.              |

**IoT Core (device MQTT)**
| Variable            | What it does                                                                                   |
| ------------------- | ---------------------------------------------------------------------------------------------- |
| `AWS_IOT_ENDPOINT`  | Account's AWS IoT ATS data endpoint (IoT Core → Settings → Device data endpoint). Not needed for local UI work. |

**Fleet provisioning**
| Variable                  | What it does                                                                                    |
| ------------------------- | ----------------------------------------------------------------------------------------------- |
| `DEVICE_PROVISION_SECRET` | Shared secret the pre-provisioning Lambda sends in the `x-provision-secret` header to `POST /api/v1/devices/provision`. Long random string. |

**Application URLs**
| Variable          | What it does                                                                              |
| ----------------- | ----------------------------------------------------------------------------------------- |
| `FRONTEND_URL`    | Base URL of the frontend; used to build invite/reset links in emails. Local: `http://localhost:5173`. |
| `ALLOWED_ORIGINS` | Comma-separated CORS allow-list. Defaults to `http://localhost:5173` if unset.            |

### `client/.env` (frontend)

Only `VITE_`-prefixed variables are exposed to the browser. **Never put secrets
here.**

| Variable        | What it does                                                                                                     |
| --------------- | ---------------------------------------------------------------------------------------------------------------- |
| `VITE_API_URL`  | API base URL. **Local: keep it relative** (`/api/v1`) so requests go through the Vite proxy — same-origin, no CORS. Production value lives in `client/.env.production` as an absolute URL. |

---

## Troubleshooting

- **`Database connection failed` on server start** — Is the MySQL container up
  (`docker compose ps`)? Do `DB_*` in `server/.env` match root `.env`? Is
  `DB_HOST=127.0.0.1`?
- **CORS errors in the browser** — In dev, `VITE_API_URL` must be relative
  (`/api/v1`). If you set an absolute URL, add that origin to `ALLOWED_ORIGINS`.
- **Uploads / email fail locally** — Is LocalStack running? Is
  `AWS_ENDPOINT_URL=http://localhost:4566` set in `server/.env`?
- **Schema changes not showing** — MySQL only runs `schema.sql` on a fresh
  volume; use a migration in `database/migrations/`, or reset with
  `docker compose down -v` (deletes local data).
- **Ports already in use** — Something else is on 3000/3306/4566/5173. Stop it
  or change the port.

---

## Related docs

- `DEPLOYMENT.md` — production deploy (EC2, PM2, GitHub Actions)
- `DEVICE_SETUP.md` / `DEVICE_IMAGE.md` / `BUILD_THIN_IMAGE.md` — Raspberry Pi
- `DOCTOR_SETUP.md` — device flashing / self-registration
- `DOMAIN_SETUP.md` — DNS / domain
