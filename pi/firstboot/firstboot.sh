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

# Mirror this log to the FAT boot partition on every exit (success OR failure), so
# it can be read by just opening the SD card on any computer — no Linux/SSH/debugfs
# needed. Appears as "nicu-firstboot.log" on the "bootfs" drive.
BOOT_OUT=/boot/firmware; [ -d "$BOOT_OUT" ] || BOOT_OUT=/boot
trap 'cp -f /var/log/nicu-firstboot.log "$BOOT_OUT/nicu-firstboot.log" 2>/dev/null || true' EXIT

STAGE=/opt/nicu

# 0. Wait for cloud-init to FULLY finish first. On current Raspberry Pi OS,
#    cloud-init creates (and briefly rewrites) the primary user account in a late
#    stage that runs CONCURRENTLY with us — so the account can be valid one moment
#    and invalid the next while we work ("install: invalid user 'pi'"). Blocking
#    here until cloud-init is done makes the account stable before we touch it.
#    `status --wait` returns when cloud-init reaches done/error; the timeout means
#    we never hang forever if cloud-init is degraded.
if command -v cloud-init >/dev/null 2>&1; then
    echo "waiting for cloud-init to finish so the user account is stable..."
    timeout 300 cloud-init status --wait >/dev/null 2>&1 || true
    echo "cloud-init finished (or timed out) — continuing."
fi

# 1. The primary user (uid 1000). Even after cloud-init, re-confirm the account is
#    fully resolvable by NAME (not just present by uid) before using it — belt and
#    suspenders. If it never becomes valid, bail and let systemd re-run us next boot.
USER_NAME=""
for i in $(seq 1 150); do
    _u="$(getent passwd 1000 | cut -d: -f1)"
    if [ -n "$_u" ] && id "$_u" >/dev/null 2>&1 && getent passwd "$_u" >/dev/null 2>&1; then
        USER_NAME="$_u"; break
    fi
    echo "waiting for the primary user account to finish being created ($i/150)..."
    sleep 2
done
if [ -z "$USER_NAME" ]; then
    echo "Primary user not fully created yet — will retry on next boot."
    exit 1
fi
USER_HOME="$(getent passwd "$USER_NAME" | cut -d: -f6)"
UID_NUM="$(id -u "$USER_NAME")"
echo "Primary user: $USER_NAME ($USER_HOME)"

# 1.4 Apply the SSH login the user set in login.txt (rename the primary account
#     and/or set its password). Left unedited, the baked default login stays.
LOGIN_FILE=/boot/firmware/login.txt
[ -f "$LOGIN_FILE" ] || LOGIN_FILE=/boot/login.txt
if [ -f "$LOGIN_FILE" ]; then
    NEW_USER="$(sed -n 's/^[[:space:]]*username[[:space:]]*=[[:space:]]*//Ip' "$LOGIN_FILE" | head -1 | tr -d '\r' | xargs)"
    NEW_PASS="$(sed -n 's/^[[:space:]]*password[[:space:]]*=[[:space:]]*//Ip' "$LOGIN_FILE" | head -1 | tr -d '\r')"
    # NOTE: we deliberately do NOT honor a custom username. Renaming the live
    # primary account on Raspberry Pi OS is unreliable — it half-completes and
    # corrupts the account (breaking sudo and first boot). The baked default user
    # is kept; only the password and hostname below are applied. (A custom SSH
    # username has little value anyway: enterprise networks block device-to-device
    # SSH, so debugging is done via the SD card, not SSH.)
    if [ -n "$NEW_USER" ] && [ "$NEW_USER" != "YOUR_USERNAME" ] && [ "$NEW_USER" != "$USER_NAME" ]; then
        echo "Note: custom username '$NEW_USER' ignored (keeping default '$USER_NAME'); applying password/hostname only."
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

# Some Raspberry Pi OS first-boot setups leave the primary account briefly without
# a login shell, which makes runuser/sudo refuse it ("entry does not contain all
# the required fields") and used to halt setup. Ensure a shell so every later
# per-user step is safe.
usermod -s /bin/bash "$USER_NAME" 2>/dev/null || true

# 1.5 Bring up WiFi from the doctor's wifi.txt (home WPA2 / university enterprise /
#     open). The logic lives in the shared apply-wifi.sh, which also runs on every
#     later boot via nicu-wifi.service so the network can be changed in the field
#     by editing wifi.txt on the SD card — no reflash. Skipped harmlessly if
#     Ethernet is already connected or wifi.txt still has placeholder values.
if [ -x /usr/local/sbin/nicu-apply-wifi.sh ]; then
    /usr/local/sbin/nicu-apply-wifi.sh || true
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
# Install the Python deps as ROOT, system-wide (--break-system-packages puts them
# on the global path). This makes them available to the user's services and avoids
# depending on the primary account's shell/entry being fully formed at this point.
python3 -m pip install --break-system-packages awsiotsdk paho-mqtt requests

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
# --no-block is REQUIRED: a plain `systemctl reboot` called from inside this
# service deadlocks (systemd waits to stop this service to reboot, but this
# service is blocked waiting on the reboot) — the Pi hangs until a manual power
# cycle. --no-block queues the reboot and lets ExecStart return first, so systemd
# reboots cleanly on its own. No manual replug needed.
systemctl --no-block reboot
