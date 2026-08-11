#!/bin/bash
# build-thin-image.sh
#
# Builds the small "NICU Speaker" image by injecting our first-boot bootstrap
# into an OFFICIAL Raspberry Pi OS Lite image. Because we start from the official
# (unexpanded, ~2-3 GB) image and only ADD a few small files, the result stays
# small — no giant card capture, no shrinking.
#
# Run on LINUX (your Raspberry Pi works great — it has losetup + ext4). NOT macOS
# (macOS can't mount the ext4 root partition).
#
# Usage:
#   sudo ./build-thin-image.sh <raspios-lite.img> <output.img>
#
# Get <raspios-lite.img> by downloading "Raspberry Pi OS Lite (64-bit)" from
#   https://www.raspberrypi.com/software/operating-systems/
# and decompressing the .img.xz (xz -d file.img.xz).
#
# Requires the claim cert to exist (run scripts/aws/setup-fleet-provisioning.sh
# first) at scripts/certs/claim/.

set -euo pipefail

if [ "$#" -ne 2 ]; then
    echo "Usage: sudo ./build-thin-image.sh <raspios-lite.img> <output.img>"
    exit 1
fi
SRC="$1"
OUT="$2"

# Baked-in default account so our user services have a home + audio session
# (the doctor never logs in; the speaker runs autonomously). Override if you like:
#   NICU_USER=nicu NICU_PASS=... sudo ./build-thin-image.sh ...
DEFAULT_USER="${NICU_USER:-nicu}"
DEFAULT_PASS="${NICU_PASS:-nicuspeaker}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CLAIM_DIR="$REPO_ROOT/scripts/certs/claim"

# Preflight: the shared claim cert must be present (built by Phase 2 AWS setup).
for f in claim.cert.pem claim.private.key AmazonRootCA1.pem; do
    [ -f "$CLAIM_DIR/$f" ] || { echo "MISSING: $CLAIM_DIR/$f — run scripts/aws/setup-fleet-provisioning.sh first."; exit 1; }
done

echo "==> Copying base image to $OUT ..."
cp "$SRC" "$OUT"

echo "==> Loop-mounting the image ..."
LOOP="$(losetup --show -fP "$OUT")"
BOOT_PART="${LOOP}p1"   # FAT boot partition (the doctor sees this as "bootfs")
ROOT_PART="${LOOP}p2"   # ext4 root filesystem
MNT="$(mktemp -d)"
BOOT_MNT="$(mktemp -d)"
cleanup() {
    mountpoint -q "$MNT" && umount "$MNT" || true
    mountpoint -q "$BOOT_MNT" && umount "$BOOT_MNT" || true
    losetup -d "$LOOP" 2>/dev/null || true
    rmdir "$MNT" "$BOOT_MNT" 2>/dev/null || true
}
trap cleanup EXIT
mount "$ROOT_PART" "$MNT"
mount "$BOOT_PART" "$BOOT_MNT"

echo "==> Baking in the default user, SSH, and a wifi.txt for the doctor ..."
# 1. Create the account headlessly (Raspberry Pi OS reads userconf.txt on first
#    boot). This is the uid-1000 user our services + firstboot run as.
HASH="$(openssl passwd -6 "$DEFAULT_PASS")"
printf '%s:%s\n' "$DEFAULT_USER" "$HASH" > "$BOOT_MNT/userconf.txt"
# 2. Enable SSH (handy for support). Delete this line if you want SSH off in prod.
touch "$BOOT_MNT/ssh"
# 3. The one file a doctor MUST edit: their WiFi name + password. firstboot.sh reads it.
cat > "$BOOT_MNT/wifi.txt" <<'EOF'
# ---- NICU Speaker WiFi ----
# Type your WiFi network name and password between the = and the end of the line,
# then save this file. (Leave the "ssid=" and "password=" labels as they are.)
# If you are outside the US, change the country to your 2-letter code.
ssid=YOUR_WIFI_NAME
password=YOUR_WIFI_PASSWORD
country=US
EOF
# 4. Optional: let the user choose the SSH login. If left as-is, the baked
#    default (below) is used. firstboot.sh applies this.
cat > "$BOOT_MNT/login.txt" <<'EOF'
# ---- NICU Speaker device settings (OPTIONAL) ----
# Set your own SSH username/password and the device's name on the network.
# Leave any line unchanged to keep the default for that setting.
username=YOUR_USERNAME
password=YOUR_PASSWORD
hostname=YOUR_HOSTNAME
EOF

echo "==> Staging speaker software into /opt/nicu ..."
install -d "$MNT/opt/nicu/systemd" "$MNT/opt/nicu/certs/claim"
install -m 644 "$REPO_ROOT/pi/provision_agent.py"      "$MNT/opt/nicu/"
install -m 644 "$REPO_ROOT/pi/pi_subscriber.py"        "$MNT/opt/nicu/"
install -m 644 "$REPO_ROOT/pi/provisioning_config.py"  "$MNT/opt/nicu/"
install -m 644 "$REPO_ROOT/pi/systemd/pi-provision.service"  "$MNT/opt/nicu/systemd/"
install -m 644 "$REPO_ROOT/pi/systemd/pi-subscriber.service" "$MNT/opt/nicu/systemd/"
install -m 755 "$REPO_ROOT/pi/firstboot/firstboot.sh"  "$MNT/opt/nicu/firstboot.sh"

echo "==> Injecting claim cert ..."
install -m 644 "$CLAIM_DIR/AmazonRootCA1.pem"    "$MNT/opt/nicu/certs/AmazonRootCA1.pem"
install -m 644 "$CLAIM_DIR/claim.cert.pem"       "$MNT/opt/nicu/certs/claim/claim.cert.pem"
install -m 600 "$CLAIM_DIR/claim.private.key"    "$MNT/opt/nicu/certs/claim/claim.private.key"

echo "==> Installing + enabling the first-boot service ..."
install -m 644 "$REPO_ROOT/pi/firstboot/nicu-firstboot.service" "$MNT/etc/systemd/system/nicu-firstboot.service"
install -d "$MNT/etc/systemd/system/multi-user.target.wants"
ln -sf /etc/systemd/system/nicu-firstboot.service \
    "$MNT/etc/systemd/system/multi-user.target.wants/nicu-firstboot.service"

sync
echo "==> Done. Built: $OUT"
echo "    Compress for distribution:  xz -T0 -9 \"$OUT\"   (or gzip \"$OUT\")"
echo "    Doctors flash it with Raspberry Pi Imager (Use custom) + their WiFi."
