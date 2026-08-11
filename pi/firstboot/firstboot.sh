#!/bin/bash
# firstboot.sh
#
# Runs ONCE on a freshly-flashed Pi (as root, via nicu-firstboot.service) the
# first time it boots with network. It:
#   1. finds the user the doctor created in Raspberry Pi Imager (uid 1000),
#   2. installs the audio player + Python deps,
#   3. drops the speaker software + shared claim cert into that user's home,
#   4. enables the provision + subscriber USER services (audio needs a user
#      service + lingering),
#   5. disables itself and reboots so those services come up cleanly.
#
# After the reboot the normal flow takes over: provision_agent.py registers the
# Pi (it self-allocates PI-#####) and pi_subscriber.py connects. The doctor does
# nothing — they just flashed the card and powered it on.
#
# If the network isn't up yet it exits non-zero and systemd runs it again on the
# next boot (it stays enabled until it succeeds). All output is logged to
# /var/log/nicu-firstboot.log for debugging.

set -e
exec >>/var/log/nicu-firstboot.log 2>&1
echo "=== nicu-firstboot $(date -u) ==="

STAGE=/opt/nicu

# 1. The human user Imager created (uid 1000). May not exist on a very early
#    boot — if so, bail and retry next boot.
USER_NAME="$(getent passwd 1000 | cut -d: -f1 || true)"
USER_HOME="$(getent passwd 1000 | cut -d: -f6 || true)"
if [ -z "$USER_NAME" ] || [ -z "$USER_HOME" ]; then
    echo "No uid-1000 user yet — will retry on next boot."
    exit 1
fi
UID_NUM="$(id -u "$USER_NAME")"
echo "Primary user: $USER_NAME ($USER_HOME)"

# 1.4 Apply the SSH login the user set in login.txt (rename the primary account
#     and/or set its password). Left unedited, the baked default login stays.
LOGIN_FILE=/boot/firmware/login.txt
[ -f "$LOGIN_FILE" ] || LOGIN_FILE=/boot/login.txt
if [ -f "$LOGIN_FILE" ]; then
    NEW_USER="$(sed -n 's/^[[:space:]]*username[[:space:]]*=[[:space:]]*//Ip' "$LOGIN_FILE" | head -1 | tr -d '\r' | xargs)"
    NEW_PASS="$(sed -n 's/^[[:space:]]*password[[:space:]]*=[[:space:]]*//Ip' "$LOGIN_FILE" | head -1 | tr -d '\r')"
    if [ -n "$NEW_USER" ] && [ "$NEW_USER" != "YOUR_USERNAME" ] && [ "$NEW_USER" != "$USER_NAME" ] && ! id "$NEW_USER" >/dev/null 2>&1; then
        echo "Setting SSH username to '$NEW_USER'..."
        pkill -KILL -u "$USER_NAME" 2>/dev/null || true
        sleep 1
        usermod  -l "$NEW_USER" "$USER_NAME" 2>/dev/null || true
        groupmod -n "$NEW_USER" "$USER_NAME" 2>/dev/null || true
        usermod  -d "/home/$NEW_USER" -m "$NEW_USER" 2>/dev/null || true
        if id "$NEW_USER" >/dev/null 2>&1; then USER_NAME="$NEW_USER"; USER_HOME="/home/$NEW_USER"; fi
    fi
    if [ -n "$NEW_PASS" ] && [ "$NEW_PASS" != "YOUR_PASSWORD" ]; then
        echo "Setting SSH password for '$USER_NAME'."
        echo "$USER_NAME:$NEW_PASS" | chpasswd
    fi
    NEW_HOST="$(sed -n 's/^[[:space:]]*hostname[[:space:]]*=[[:space:]]*//Ip' "$LOGIN_FILE" | head -1 | tr -d '\r' | xargs)"
    if [ -n "$NEW_HOST" ] && [ "$NEW_HOST" != "YOUR_HOSTNAME" ]; then
        echo "Setting hostname to '$NEW_HOST'..."
        echo "$NEW_HOST" > /etc/hostname
        sed -i "s/^127\.0\.1\.1.*/127.0.1.1\t$NEW_HOST/" /etc/hosts 2>/dev/null || true
        hostnamectl set-hostname "$NEW_HOST" 2>/dev/null || true
    fi
fi
UID_NUM="$(id -u "$USER_NAME")"

# 1.5 Bring up WiFi from the doctor's wifi.txt (skipped if Ethernet already gave
#     us a connection, or if wifi.txt was left with the placeholder values).
WIFI_FILE=/boot/firmware/wifi.txt
[ -f "$WIFI_FILE" ] || WIFI_FILE=/boot/wifi.txt
if [ -f "$WIFI_FILE" ]; then
    SSID="$(sed -n 's/^[[:space:]]*ssid[[:space:]]*=[[:space:]]*//Ip'     "$WIFI_FILE" | head -1 | tr -d '\r')"
    PSK="$(sed -n  's/^[[:space:]]*password[[:space:]]*=[[:space:]]*//Ip' "$WIFI_FILE" | head -1 | tr -d '\r')"
    COUNTRY="$(sed -n 's/^[[:space:]]*country[[:space:]]*=[[:space:]]*//Ip' "$WIFI_FILE" | head -1 | tr -d '\r')"
    COUNTRY="${COUNTRY:-US}"
    if [ -n "$SSID" ] && [ "$SSID" != "YOUR_WIFI_NAME" ]; then
        echo "Configuring WiFi for SSID '$SSID' (country $COUNTRY)..."
        raspi-config nonint do_wifi_country "$COUNTRY" 2>/dev/null || iw reg set "$COUNTRY" 2>/dev/null || true
        rfkill unblock wifi 2>/dev/null || true
        nmcli radio wifi on 2>/dev/null || true
        nmcli connection delete nicu-wifi 2>/dev/null || true
        nmcli connection add type wifi con-name nicu-wifi ifname wlan0 ssid "$SSID" 2>/dev/null || true
        nmcli connection modify nicu-wifi wifi-sec.key-mgmt wpa-psk wifi-sec.psk "$PSK" connection.autoconnect yes 2>/dev/null || true
        nmcli connection up nicu-wifi 2>/dev/null || echo "WiFi will keep retrying as the radio settles."
    else
        echo "wifi.txt still has placeholder values — relying on Ethernet if present."
    fi
fi

# 2. Wait for real connectivity (apt/pip + AWS need it).
online=false
for i in $(seq 1 30); do
    if ping -c1 -W2 8.8.8.8 >/dev/null 2>&1; then online=true; break; fi
    echo "waiting for network ($i/30)..."
    sleep 5
done
if [ "$online" != true ]; then
    echo "Network never came up — will retry on next boot."
    exit 1
fi

# 2.5 Fix the clock BEFORE apt. A Pi has no battery-backed clock, so it boots
#     with a stale date (the OS build date). Debian Trixie's apt then rejects
#     repo signatures as "not live until <future date>" and installs fail. Sync
#     via NTP; if that's blocked, fall back to an HTTPS Date header.
echo "Clock before sync: $(date -u)"
timedatectl set-ntp true 2>/dev/null || true
for i in $(seq 1 20); do
    [ "$(timedatectl show -p NTPSynchronized --value 2>/dev/null)" = "yes" ] && break
    sleep 3
done
if [ "$(timedatectl show -p NTPSynchronized --value 2>/dev/null)" != "yes" ]; then
    echo "NTP didn't sync (port 123 may be blocked) — setting clock from an HTTPS header."
    HTTP_DATE="$(curl -sI https://deb.debian.org 2>/dev/null | sed -n 's/^[Dd]ate:[[:space:]]*//p' | tr -d '\r' | head -1)"
    [ -n "$HTTP_DATE" ] && date -u -s "$HTTP_DATE" 2>/dev/null || true
fi
echo "Clock after sync:  $(date -u)"

# 3. System + Python dependencies. ffmpeg gives us ffplay, which plays every
#    audio format (MP3 uploads AND WebM/Opus browser recordings) — mpg123 only
#    did MP3.
apt-get update -qq
apt-get install -y -qq ffmpeg python3-pip
sudo -u "$USER_NAME" python3 -m pip install --break-system-packages awsiotsdk paho-mqtt requests

# 4. Copy software + certs into the user's home.
for f in provision_agent.py pi_subscriber.py provisioning_config.py; do
    install -o "$USER_NAME" -g "$USER_NAME" -m 644 "$STAGE/$f" "$USER_HOME/$f"
done
install -d -o "$USER_NAME" -g "$USER_NAME" "$USER_HOME/certs" "$USER_HOME/certs/claim"
install -o "$USER_NAME" -g "$USER_NAME" -m 644 "$STAGE/certs/AmazonRootCA1.pem"     "$USER_HOME/certs/AmazonRootCA1.pem"
install -o "$USER_NAME" -g "$USER_NAME" -m 644 "$STAGE/certs/claim/claim.cert.pem"  "$USER_HOME/certs/claim/claim.cert.pem"
install -o "$USER_NAME" -g "$USER_NAME" -m 600 "$STAGE/certs/claim/claim.private.key" "$USER_HOME/certs/claim/claim.private.key"

# 5. Install the user services and enable them WITHOUT needing the user's systemd
#    manager to be running yet: symlink into default.target.wants directly, and
#    enable lingering so the manager starts at boot and brings them up.
UDIR="$USER_HOME/.config/systemd/user"
WANTS="$UDIR/default.target.wants"
install -d -o "$USER_NAME" -g "$USER_NAME" "$UDIR" "$WANTS"
for svc in pi-provision.service pi-subscriber.service; do
    install -o "$USER_NAME" -g "$USER_NAME" -m 644 "$STAGE/systemd/$svc" "$UDIR/$svc"
    ln -sf "../$svc" "$WANTS/$svc"
done
chown -R "$USER_NAME:$USER_NAME" "$USER_HOME/.config"
loginctl enable-linger "$USER_NAME"

# 6. Success — remove the payload + disable this unit so it never runs again,
#    then reboot so the lingering user services start the provisioning flow.
echo "Setup complete — disabling first-boot and rebooting."
systemctl disable nicu-firstboot.service || true
rm -rf "$STAGE"
echo "=== nicu-firstboot done $(date -u) ==="
systemctl reboot
