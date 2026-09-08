# Build & test the Voice2Baby speaker image

This is the full runbook to build the small image doctors will flash, then test
it. You do the **build** once (and again only if you change the Pi software);
doctors never do any of this.

Building means mounting the image's Linux (ext4) partition, which **macOS can't
do directly**. There are two ways around that — pick one:

- **Option A — Build on your Mac with Docker (recommended; no extra hardware).**
  Docker runs a real Linux kernel, so one command builds the whole image:
  ```bash
  ./pi/build-image-docker.sh
  ```
  It downloads Raspberry Pi OS, runs the builder inside a throwaway privileged
  Linux container, and writes `~/v2b-build/voice2baby-speaker.img`. Requires
  Docker Desktop running and the claim cert at `scripts/certs/claim/`. Then skip
  straight to **Stage 4 — Test it**.

- **Option B — Build on a spare Raspberry Pi** (Stages 0–3 below). Use this if you
  don't want Docker: a freshly-flashed Pi running Raspberry Pi OS Lite acts as a
  temporary Linux build machine. (Note: the build Pi needs plain internet —
  Ethernet or a password WiFi — because Raspberry Pi Imager can't join enterprise
  WiFi like eduroam.)

Either way, **Stage 4** (flash + set `wifi.txt` + boot) and **Stage 5** (host it)
are identical.

---

## Prerequisites

- **Phase 2 is done** — `scripts/aws/setup-fleet-provisioning.sh` was run, so the
  claim cert exists on your Mac at `scripts/certs/claim/`.
- This repo is on your Mac.

---

## Stage 0 — Make the Pi a reachable build machine

The build has to run on Linux (mounting the image's ext4 partition, which macOS
can't do), so we use the Pi. It must be running a **plain official** OS you can
SSH into. If its card currently holds a NICU image (or anything you can't log
into), reflash it first:

1. In **Raspberry Pi Imager**, flash **Raspberry Pi OS Lite (64-bit)** — the
   *official* one. For the official image, Imager's customization **works**, so
   in **Edit Settings** set: **username `admin`** + password, your **WiFi**, and
   **Enable SSH**. Write it.
2. Put the card in the Pi, power on, wait ~1 min, then find it on your network
   and set a shortcut on your **Mac**:
   ```bash
   PI=admin@<your-pi-ip>     # or admin@pi.local
   ssh "$PI" 'echo connected'
   ```
   Once `connected` prints, you have a build machine. Continue to Stage 1.

---

## Stage 1 — Put the build ingredients on the Pi (run on your Mac)

From the repo root, recreate the minimal structure the build script needs on the
Pi (the `pi/` folder + the claim cert, which is gitignored so it must be copied):
```bash
ssh "$PI" 'mkdir -p ~/nicu-build/scripts/certs/claim'
scp -r pi "$PI:~/nicu-build/"
scp scripts/certs/claim/claim.cert.pem \
    scripts/certs/claim/claim.private.key \
    scripts/certs/claim/AmazonRootCA1.pem \
    "$PI:~/nicu-build/scripts/certs/claim/"
```

---

## Stage 2 — Build the image on the Pi (SSH into the Pi)

```bash
ssh "$PI"
cd ~/nicu-build
sudo apt-get update && sudo apt-get install -y xz-utils

# Download the official Raspberry Pi OS Lite 64-bit (stable "latest" redirect):
wget -O raspios-lite.img.xz https://downloads.raspberrypi.com/raspios_lite_arm64_latest
xz -d raspios-lite.img.xz          # -> raspios-lite.img (a few GB)

# Build the thin image (injects our bootstrap + user + wifi.txt into the official image):
sudo ./pi/build-thin-image.sh raspios-lite.img nicu-speaker.img
ls -lh nicu-speaker.img            # ~2.8 GB raw (we compress later, on the Mac)
```
Don't compress on the Pi — it's very slow there. We flash the raw image for the
test and compress on the Mac only when hosting (Stage 5).

If the build errors: you must be on the Pi (Linux) with `sudo`, and the claim
cert must be present under `~/nicu-build/scripts/certs/claim/`.

---

## Stage 3 — Copy the finished image to your Mac (run on your Mac)

```bash
scp "$PI:~/nicu-build/nicu-speaker.img" ~/nicu-speaker.img
```

Now shut the Pi down so you can reuse its card for the test:
```bash
ssh "$PI" 'sudo shutdown -h now'
```
Wait for the green light to stop, then move the SD card to your Mac.

---

## Stage 4 — Test it (this IS the real doctor flow)

1. Open **Raspberry Pi Imager** on your Mac.
2. **Choose OS** → **Use custom** → select `~/nicu-speaker.img`.
3. **Choose Storage** → the SD card.
4. **Write.** If it asks *"apply OS customisation settings?"*, choose **No** —
   the image already has the user + SSH baked in, and you set WiFi next.
5. When it finishes, **re-insert the card** into your Mac. A drive named
   **`bootfs`** appears. Open **`wifi.txt`** on it and fill in the network type
   for your site (the file documents all three), save, then eject:
   ```bash
   nano /Volumes/bootfs/wifi.txt
   diskutil eject /Volumes/bootfs
   ```
   - **Home / clinic Wi-Fi:** `security=wpa-psk` + `ssid=` + `password=`
   - **University / enterprise (eduroam-style):** `security=wpa-eap` + `ssid=` +
     `identity=` (username) + `password=`; for full security also drop the campus
     CA `.pem` on `bootfs` and set `ca_cert=/boot/firmware/ca.pem` +
     `domain_suffix_match=<their-domain>`
   - **Open Wi-Fi:** `security=open` + `ssid=`

   > The network is re-applied on **every boot** (via `nicu-wifi.service`), so you
   > can change it later by editing `wifi.txt` on the card and reinserting it — no
   > re-flash. It only re-applies when the file actually changes.
6. Put the card in the Pi and plug in power.
7. **Wait ~5 minutes.** On first boot it connects to WiFi, installs its software,
   **reboots itself once**, then registers. Don't touch it.
8. Check the **prod Speakers tab** (`https://voice2baby.com`) → a new
   `PI-####` should appear **Online**, all by itself.

**If it comes Online → the polished doctor image works end to end.** 🎉

The baked-in login for debugging is user **`nicu`** / password **`nicuspeaker`**
(SSH is on). If it doesn't come Online, SSH in and send me
`sudo cat /var/log/nicu-firstboot.log`.

### If it does NOT come Online
SSH in and read the first-boot log (this is why we enabled SSH for the test):
```bash
ssh "$PI"
sudo cat /var/log/nicu-firstboot.log                      # every setup step is logged here
systemctl --user status pi-provision.service --no-pager
journalctl --user -u pi-provision.service -b --no-pager
cat ~/device_config.py 2>/dev/null                        # should hold DEVICE_CODE = "PI-000xx"
```
Paste me the log and I'll pinpoint it.

---

## Stage 5 — Host it + fill in the doctor link

Once the test passes:
1. Upload `~/nicu-speaker.img.xz` somewhere with a public download link
   (S3 bucket, GitHub Release, or Google Drive).
2. Put that link into `DOCTOR_SETUP.md` where the download placeholder is.

Done. From now on a new speaker = a doctor downloads that file, flashes it with
Raspberry Pi Imager (their own WiFi), and powers on the Pi. It self-registers.
No terminal, ever.

---

## What the doctor's Pi does on first boot (behind the scenes)

1. Boots official Raspberry Pi OS, joins the WiFi they set in Imager.
2. `nicu-firstboot.service` runs once: installs `mpg123` + Python deps, copies the
   software + claim cert into the user's home, enables the provision + subscriber
   user services, then reboots.
3. After that reboot: `provision_agent.py` registers the Pi (self-allocates
   `PI-#####`) and `pi_subscriber.py` connects → it shows Online, unassigned.

Everything logs to `/var/log/nicu-firstboot.log` on the Pi for debugging.

## Updating the Pi software later

Change the files under `pi/`, rebuild (Stages 1–3), re-host (Stage 5). New Pis
flashed from the new image get the update; already-deployed Pis keep running the
version they were set up with.
