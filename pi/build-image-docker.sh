#!/bin/bash
# build-image-docker.sh
#
# Build the Voice2Baby speaker image ON A MAC (or any Docker host) — no Raspberry
# Pi, no Ethernet adapter, no monitor needed.
#
# Why this exists: the real builder, build-thin-image.sh, must run on LINUX
# because it loop-mounts the image's ext4 root partition — something macOS cannot
# do. Docker runs a small real Linux VM, so we run the build inside a throwaway,
# privileged Ubuntu container. The container:
#   1. installs the build tools (losetup/mount/xz/openssl/...),
#   2. downloads the official Raspberry Pi OS Lite (arm64),
#   3. runs OUR build-thin-image.sh to inject the Voice2Baby bootstrap,
#   4. copies the finished .img back out to your Mac.
#
# Usage:
#   ./pi/build-image-docker.sh [OUTPUT_IMG]
#     OUTPUT_IMG  where to write the finished image on your Mac.
#                 Default: ~/v2b-build/voice2baby-speaker.img
#
# Requirements:
#   - Docker Desktop installed and running (`docker info` works).
#   - The claim cert present at scripts/certs/claim/ (from the Phase-2 AWS setup,
#     scripts/aws/setup-fleet-provisioning.sh). Everything else is installed
#     inside the container, so your Mac stays clean.
#
# After it finishes: flash the image with Raspberry Pi Imager (Use custom), then
# edit wifi.txt on the "bootfs" drive for your network (home / enterprise / open),
# and boot the Pi. See BUILD_THIN_IMAGE.md and DOCTOR_SETUP.md.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

OUT_HOST="${1:-$HOME/v2b-build/voice2baby-speaker.img}"
OUT_NAME="$(basename "$OUT_HOST")"
OUT_DIR="$(dirname "$OUT_HOST")"

# --- Preflight -------------------------------------------------------------
command -v docker >/dev/null 2>&1 || {
    echo "ERROR: Docker isn't installed. Install Docker Desktop: https://www.docker.com/products/docker-desktop/"; exit 1; }
docker info >/dev/null 2>&1 || {
    echo "ERROR: the Docker daemon isn't running. Open Docker Desktop, wait for it to start, then retry."; exit 1; }
for f in claim.cert.pem claim.private.key AmazonRootCA1.pem; do
    [ -f "$REPO_ROOT/scripts/certs/claim/$f" ] || {
        echo "ERROR: missing scripts/certs/claim/$f — run scripts/aws/setup-fleet-provisioning.sh first."; exit 1; }
done

mkdir -p "$OUT_DIR"
OUT_DIR="$(cd "$OUT_DIR" && pwd)"   # absolutize for the bind mount

echo "==> Building '$OUT_NAME' inside a privileged Ubuntu container."
echo "    (Downloads ~1 GB of Raspberry Pi OS the first time; takes several minutes.)"

# --privileged  : lets the container use loop devices (losetup) + mount ext4/vfat.
# -v REPO:/work : the container reads pi/ and the claim cert from here.
# -v OUT:/out   : the finished image is copied here so your Mac can see it.
# The image work happens in the container's /tmp (a real Linux fs) — NOT on the
# bind mount — because loop-mounting a file on macOS's shared filesystem fails.
docker run --rm --privileged \
    -v "$REPO_ROOT":/work -v "$OUT_DIR":/out -w /work \
    -e OUT_NAME="$OUT_NAME" \
    ubuntu:24.04 bash -c '
set -e
export DEBIAN_FRONTEND=noninteractive
echo "[0/3] Installing build tools in the container..."
apt-get update -qq
apt-get install -y -qq util-linux dosfstools e2fsprogs xz-utils wget ca-certificates openssl parted kpartx >/dev/null
cd /tmp
# Cache the decompressed base OS image on the output volume so repeat builds skip
# the download + decompress. Delete it to force a fresh download.
#
# We build on Raspberry Pi OS "Desktop" (Trixie) — the exact image the deployer
# uses and trusts on the Pi 5. Unlike the Lite image, Desktop does not take the
# racy cloud-init user path; combined with the custom.toml baked in by
# build-thin-image.sh, the account is created cleanly and headless. Desktop also
# has a real audio session, which helps playback later.
CACHE=/out/raspios-trixie-desktop-arm64.img
if [ ! -f "$CACHE" ]; then
    echo "[1/3] Downloading Raspberry Pi OS Desktop (Trixie, arm64) — large (~1.3 GB), be patient..."
    wget -q -O raspios.img.xz https://downloads.raspberrypi.com/raspios_arm64_latest
    echo "[2/3] Decompressing + caching..."
    xz -d raspios.img.xz
    cp raspios.img "$CACHE"
else
    echo "[1-2/3] Using cached base image ($CACHE)."
fi
echo "[3/3] Injecting Voice2Baby bootstrap (build-thin-image.sh)..."
# build-thin-image.sh copies the base to /tmp (local fs) before loop-mounting —
# loop-mounting a file on the macOS-shared /out volume would fail.
/work/pi/build-thin-image.sh "$CACHE" /tmp/out.img
cp /tmp/out.img "/out/$OUT_NAME"
ls -lh "/out/$OUT_NAME"
'

echo ""
echo "==> Done. Image is at: $OUT_DIR/$OUT_NAME"
echo "    Next: flash it with Raspberry Pi Imager (Use custom), edit wifi.txt on"
echo "    the bootfs drive for your network, then boot the Pi. See BUILD_THIN_IMAGE.md."
