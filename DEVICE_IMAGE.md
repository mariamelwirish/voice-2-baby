# Building the golden Pi image (zero-touch speakers)

This is the last piece: build ONE SD-card image, and every card flashed from it
self-registers on first boot. After the image exists, adding a speaker is:
**flash card → plug in Pi → it appears in the Speakers tab.** No SSH, no per-device
certs, no steps for doctors or IT.

## Prerequisites (do these once, first)

1. **Phase 2 complete:** you ran `scripts/aws/setup-fleet-provisioning.sh`. It
   produced the shared claim cert in `scripts/certs/claim/` and printed your IoT
   endpoint + template name.
2. **Fill in `pi/provisioning_config.py`** with that `IOT_ENDPOINT` and
   `PROVISIONING_TEMPLATE` (the defaults already match this project, but confirm).
3. A spare "builder" Pi + SD card, and Raspberry Pi Imager on your laptop.

## Step 1 — Flash the base OS

In **Raspberry Pi Imager**: choose **Raspberry Pi OS Lite (64-bit)**, then edit
the OS customisation settings before writing:
- **Username** — pick one (e.g. `admin`). The services use `%h`, so any name works.
- **Wi-Fi** — your home Wi-Fi SSID + password for now (WPA2-Personal). This is
  the only network-specific bit; swapping to the hospital network later is just
  a re-flash with different Wi-Fi here.
- **Enable SSH** — on (you need it only to build the image).

Write the card, boot the builder Pi, and SSH in.

## Step 2 — Copy the software + claim cert onto the builder Pi

From your laptop, in the repo root (adjust `admin@raspberrypi.local`):

```bash
PI=admin@raspberrypi.local

# Pi software (agent, subscriber, shared config, deps, systemd units)
scp pi/provision_agent.py pi/pi_subscriber.py pi/provisioning_config.py pi/requirements.txt pi/setup-pi.sh "$PI:~/"
ssh "$PI" 'mkdir -p ~/systemd ~/certs/claim'
scp pi/systemd/pi-provision.service pi/systemd/pi-subscriber.service "$PI:~/systemd/"

# Shared claim cert + Amazon root CA (same on every Pi)
scp scripts/certs/claim/claim.cert.pem scripts/certs/claim/claim.private.key "$PI:~/certs/claim/"
scp scripts/certs/AmazonRootCA1.pem "$PI:~/certs/"
```

## Step 3 — Install + enable (do NOT let it provision yet)

```bash
ssh "$PI" 'chmod +x ~/setup-pi.sh && ~/setup-pi.sh'
```

`setup-pi.sh` installs `mpg123` + the Python deps, installs the two **user**
services (with lingering, so they run at boot without a login), and **enables
but does not start** them. That's deliberate: the builder must not provision
itself, or the image would carry one device's identity.

## Step 4 — Capture the golden image

Shut the builder down **before it reboots**:

```bash
ssh "$PI" 'sudo shutdown -h now'
```

Pull the SD card, put it in your laptop, and read it back to a file:
- **Raspberry Pi Imager** has no "read" mode; use **balenaEtcher** (has a clone
  feature) or `dd`:
  ```bash
  # macOS: find the disk with `diskutil list`, unmount, then (BE CAREFUL with of=)
  sudo dd if=/dev/rdiskN of=golden-speaker.img bs=4m
  ```

`golden-speaker.img` is your master. Optionally shrink it with `pishrink` for
faster flashing.

## Step 5 — Make a speaker (the "one button")

For each new speaker: flash `golden-speaker.img` onto a card (Raspberry Pi
Imager → "Use custom" → select the image → write), pop it in a Pi, plug in
power. On first boot it:
1. joins Wi-Fi,
2. runs `provision_agent.py` → gets its own cert + `PI-#####`,
3. starts `pi_subscriber.py` → shows up **Online, unassigned** in the Speakers tab.

The admin's only action is **Assign to baby** in the UI.

## What happens on later boots / re-flash

- **Reboot:** `provision_agent.py` sees it's already provisioned and exits
  instantly; the subscriber comes straight up.
- **Re-flash the same Pi:** it provisions again, but the backend keys on the Pi's
  hardware serial, so it **reuses the same `PI-#####`** — no duplicate speaker.

## Troubleshooting (build/test only — needs SSH)

```bash
systemctl --user status pi-provision.service    # first-boot provisioning
systemctl --user status pi-subscriber.service   # normal running
journalctl --user -u pi-provision.service -b     # provisioning logs
cat ~/device_config.py                           # the assigned PI-#####
```

Common issues: provisioning rejected → check the pre-provisioning Lambda's
CloudWatch logs (usually the shared secret or the backend URL). No audio →
confirm the subscriber runs as a **user** service with lingering (system
services can't reach PipeWire).
