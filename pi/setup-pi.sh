#!/bin/bash
# setup-pi.sh
#
# Run ON the Raspberry Pi (as the login user) to install the speaker software
# and enable the two services. Used once when building the golden image — see
# DEVICE_IMAGE.md. It does NOT start the services (so the builder Pi doesn't
# provision itself); they start on the next boot of a flashed card.
#
# Expects these already in place (copied by you before running):
#   ~/provision_agent.py  ~/pi_subscriber.py  ~/provisioning_config.py
#   ~/requirements.txt
#   ~/certs/AmazonRootCA1.pem
#   ~/certs/claim/claim.cert.pem  ~/certs/claim/claim.private.key
#   ~/systemd/pi-provision.service  ~/systemd/pi-subscriber.service

set -euo pipefail
cd "$HOME"

echo "==> Installing system + Python dependencies..."
sudo apt-get update -qq
sudo apt-get install -y -qq ffmpeg python3-pip
python3 -m pip install -r requirements.txt --break-system-packages

echo "==> Sanity-checking required files..."
for f in provision_agent.py pi_subscriber.py provisioning_config.py \
         certs/AmazonRootCA1.pem certs/claim/claim.cert.pem certs/claim/claim.private.key; do
    [ -f "$HOME/$f" ] || { echo "MISSING: ~/$f"; exit 1; }
done

echo "==> Installing user services (enabled, NOT started)..."
export XDG_RUNTIME_DIR="/run/user/$(id -u)"
mkdir -p ~/.config/systemd/user
cp systemd/pi-provision.service systemd/pi-subscriber.service ~/.config/systemd/user/
sudo loginctl enable-linger "$USER"
systemctl --user daemon-reload
systemctl --user enable pi-provision.service pi-subscriber.service

cat <<DONE

==> Done. Services are ENABLED but not started.
    - Building a golden image? Shut down now (sudo shutdown -h now) and capture
      the card BEFORE it boots again, so the image stays pre-provisioned.
    - Testing THIS Pi directly? Reboot (sudo reboot) — it will provision on boot
      and appear in the Speakers tab.
DONE
