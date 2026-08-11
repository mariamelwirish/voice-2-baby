# Domain cutover runbook — moving to your own domain

Follow these steps in order to move the app from `remotereading.duckdns.org` to
your own domain (registered on AWS Route 53). This also fixes the Chrome
"Dangerous site" warning by giving you real HTTPS.

Throughout, replace **`YOURDOMAIN`** with the domain you actually bought
(e.g. `remotereading.com`).

## Before you start — read this

- **Your speakers/Pis are NOT affected.** They talk to AWS IoT and S3, never the
  web domain. Nothing on any device changes. Don't touch them.
- **duckdns keeps working the whole time.** We add the new domain alongside it,
  so the site never goes down mid-switch. You retire duckdns later (Part 8),
  only once the new domain is proven.
- **What you need:** AWS console access, SSH access to the EC2 server
  (`ssh ec2-user@3.208.245.69`), and this repo on your laptop.
- Your EC2 Elastic IP is **`3.208.245.69`**.

## Checklist (tick as you go)

- [ ] Part 1 — Register the domain (Route 53)
- [ ] Part 2 — Add DNS records (Route 53)
- [ ] Part 3 — nginx server_name + HTTPS certificate (EC2)
- [ ] Part 4 — Server environment variables (EC2)
- [ ] Part 5 — Frontend + repo code changes (laptop → push)
- [ ] Part 6 — Provisioning Lambda URL (AWS console)
- [ ] Part 7 — Verify everything
- [ ] Part 8 — (Later) retire duckdns

---

## Part 1 — Register the domain (Route 53)

1. AWS console → **Route 53** → **Domains** → **Register domains**.
2. Search **`YOURDOMAIN`**. If available, register it (~$14/year for `.com`).
3. Wait for the registration email / status to show **registered** (can take a
   few minutes to a couple of hours). Route 53 automatically creates a **hosted
   zone** (DNS) for the domain.

---

## Part 2 — Add DNS records (Route 53)

1. Route 53 → **Hosted zones** → click **`YOURDOMAIN`**.
2. **Create record**:
   - **Record name:** *(leave empty — this is the bare/apex domain)*
   - **Record type:** `A`
   - **Value:** `3.208.245.69`
   - **TTL:** `300`
   - Create.
3. **Create record** again:
   - **Record name:** `www`
   - **Record type:** `A`
   - **Value:** `3.208.245.69`
   - **TTL:** `300`
   - Create.
4. From your laptop, confirm DNS resolves (may take a few minutes):
   ```bash
   dig YOURDOMAIN +short         # should print 3.208.245.69
   dig www.YOURDOMAIN +short     # should print 3.208.245.69
   ```
   Do not continue to Part 3 until both print the IP.

---

## Part 3 — nginx + HTTPS certificate (EC2)

1. SSH in:
   ```bash
   ssh ec2-user@3.208.245.69
   ```
2. Add the new names to nginx (keep duckdns so nothing breaks):
   ```bash
   sudo nano /etc/nginx/conf.d/remote-reading.conf
   ```
   Find the `server_name` line and add the two new names, e.g.:
   ```
   server_name remotereading.duckdns.org YOURDOMAIN www.YOURDOMAIN;
   ```
   Save (Ctrl+O, Enter) and exit (Ctrl+X).
3. Test and reload:
   ```bash
   sudo nginx -t && sudo systemctl reload nginx
   ```
4. Get a real HTTPS certificate for the new domain:
   ```bash
   sudo certbot --nginx -d YOURDOMAIN -d www.YOURDOMAIN
   ```
   - If it asks about redirecting HTTP→HTTPS, choose **Redirect**.
   - Certbot auto-renews; nothing else to do.
5. In a browser, open **`https://YOURDOMAIN`** — it should load the site with a
   padlock and no warning.

---

## Part 4 — Server environment variables (EC2)

Still on the EC2 server:

1. Edit the server env:
   ```bash
   nano /home/ec2-user/remote-reading/server/.env
   ```
2. Update these three (keep duckdns in ALLOWED_ORIGINS during transition):
   ```
   ALLOWED_ORIGINS=https://remotereading.duckdns.org,https://YOURDOMAIN,https://www.YOURDOMAIN
   FRONTEND_URL=https://YOURDOMAIN
   API_URL=https://YOURDOMAIN
   ```
   (If a line doesn't exist yet, add it. Leave `DEVICE_PROVISION_SECRET` and
   everything else untouched.)
3. Save, then restart the app:
   ```bash
   pm2 restart remote-reading-server
   ```

---

## Part 5 — Frontend + repo code changes (on your laptop)

These make the built website call the new domain. Do them in the repo, then push
(the deploy pipeline rebuilds and ships automatically).

1. **`client/.env.production`** — change the one line to:
   ```
   VITE_API_URL=https://YOURDOMAIN/api/v1
   ```
2. **`.github/workflows/deploy.yml`** — change the environment URL line to:
   ```yaml
       url: https://YOURDOMAIN
   ```
3. *(Optional docs cleanup — not functional)* update the domain mentions in
   `DEPLOYMENT.md`, `scripts/aws/README.md`, and the comment in
   `scripts/aws/preprovision-hook/index.js`.
4. Commit and push — this triggers a deploy:
   ```bash
   cd "/Users/mariamelwirish/Education/Projects/Remote Reading/Code"
   git add -A
   git commit -m "Point app at YOURDOMAIN"
   git push origin main
   ```
5. Watch the **Actions** tab until the deploy is green.

> Tip: instead of editing these by hand, you can tell Claude the exact domain and
> it will make the Part 5 file edits for you — then you just commit and push.

---

## Part 6 — Provisioning Lambda URL (AWS console)

So newly-flashed speakers register through the new domain.

1. AWS console → **Lambda** → **`nicu-preprovision-hook`**.
2. **Configuration** → **Environment variables** → **Edit**.
3. Change **`PROVISION_URL`** to:
   ```
   https://YOURDOMAIN/api/v1/devices/provision
   ```
   Leave **`PROVISION_SECRET`** unchanged. Save.

*(Not urgent — duckdns still resolves to the same server — but do it so the new
domain is the single source of truth.)*

---

## Part 7 — Verify everything

- [ ] `https://YOURDOMAIN` loads with a padlock, no browser warning.
- [ ] You can **log in** as admin on the new domain.
- [ ] Adding/viewing data works (no CORS errors — open the browser console and
      confirm there are no red CORS messages).
- [ ] Provisioning endpoint responds on the new domain:
  ```bash
  curl -i -X POST https://YOURDOMAIN/api/v1/devices/provision \
    -H 'Content-Type: application/json' \
    -H 'x-provision-secret: <your DEVICE_PROVISION_SECRET>' \
    -d '{"serial_number":"DOMAIN-TEST-1"}'
  ```
  Expect `201` + a `device_code`. Delete that test speaker in the UI afterward.
- [ ] Existing speakers still show Online (they were never affected).

---

## Part 8 — Retire duckdns (LATER — only after ~1–2 weeks of the new domain working)

Once you're confident:
1. EC2: remove `remotereading.duckdns.org` from the nginx `server_name`, reload nginx.
2. EC2 `server/.env`: remove the duckdns entry from `ALLOWED_ORIGINS`, `pm2 restart`.
3. (Optional) stop the duckdns updater if you run one.

Leave the duckdns DNS pointing at the server harmlessly, or delete it — your call.

---

## Troubleshooting

- **`dig` doesn't return the IP:** DNS hasn't propagated yet — wait a few minutes
  and retry. Don't run certbot until it resolves.
- **certbot fails ("challenge failed"):** almost always DNS not resolving yet, or
  port 80 blocked. Confirm `dig YOURDOMAIN +short` shows `3.208.245.69` first.
- **Site loads but login fails / "CORS" errors in console:** `ALLOWED_ORIGINS`
  (Part 4) is missing the new domain, or you forgot to `pm2 restart`.
- **Site loads on duckdns but not the new domain:** nginx `server_name` (Part 3)
  wasn't updated/reloaded, or the certificate wasn't issued for the new name.
- **Invite emails still link to duckdns:** `FRONTEND_URL` (Part 4) wasn't updated,
  or the app wasn't restarted.
