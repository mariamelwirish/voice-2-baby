#!/bin/bash
# prepare-for-image.sh
#
# Run ON the Pi RIGHT BEFORE capturing its SD card as the golden image. It strips
# everything device-specific so that every clone made from the image gets a FRESH
# identity on first boot instead of being a copy of this one device.
#
# It removes:
#   - this Pi's provisioned identity (device_config.py + its PI-#### cert/key)
#     -> clones re-provision themselves on first boot
#   - saved Wi-Fi (so the doctor sets their own Wi-Fi when they flash)
#   - SSH host keys + machine-id (so clones aren't identical hosts; Raspberry Pi
#     OS regenerates both on next boot)
#   - logs + shell history
#
# It KEEPS the shared claim cert (~/certs/claim) and the software + enabled
# services — that's exactly what every clone needs.
#
# After it runs: `sudo shutdown -h now`, then capture the card (see DEVICE_IMAGE.md).

set -e
echo "Stripping per-device state for imaging..."

# 1. Remove this device's provisioned identity (NOT the shared claim cert).
rm -f "$HOME"/device_config.py
rm -f "$HOME"/certs/PI-*_certificate.crt "$HOME"/certs/PI-*_private.key

# 2. Make sure the services will start on boot but aren't running right now.
export XDG_RUNTIME_DIR="/run/user/$(id -u)"
systemctl --user stop pi-subscriber.service pi-provision.service 2>/dev/null || true
systemctl --user enable pi-provision.service pi-subscriber.service >/dev/null 2>&1 || true

# 3. Forget saved Wi-Fi — the doctor sets theirs at flash time in Raspberry Pi Imager.
sudo rm -f /etc/NetworkManager/system-connections/*.nmconnection 2>/dev/null || true

# 4. Regenerate host identity on next boot (unique per clone).
sudo rm -f /etc/ssh/ssh_host_* 2>/dev/null || true
sudo truncate -s 0 /etc/machine-id 2>/dev/null || true
sudo rm -f /var/lib/dbus/machine-id 2>/dev/null || true

# 5. Clear logs + history so the image is clean.
sudo journalctl --rotate 2>/dev/null || true
sudo journalctl --vacuum-time=1s 2>/dev/null || true
: > "$HOME/.bash_history" 2>/dev/null || true

echo "Done. Now run:  sudo shutdown -h now"
echo "Then capture the SD card as the golden image (see DEVICE_IMAGE.md)."
