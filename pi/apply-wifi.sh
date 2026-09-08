#!/bin/bash
# apply-wifi.sh
#
# Configures the speaker's WiFi from /boot/firmware/wifi.txt using NetworkManager,
# supporting three network types (see the `security=` field):
#   wpa-psk   home / clinic WiFi      (ssid + password)                 [default]
#   wpa-eap   university / enterprise (ssid + identity + password; eduroam-style)
#   open      no password             (ssid only)
#
# Designed to run BOTH at first boot AND on every subsequent boot (via
# nicu-wifi.service), so the network can be changed in the field by editing
# wifi.txt on the SD card — no reflash. To stay safe on a live device it only
# re-applies when wifi.txt actually changed (checksum-guarded): a transient
# "nmcli up" failure can never wipe a working, persisted profile.
#
# Reliability choices baked in:
#   - connection.autoconnect + infinite retries  -> self-heals after any outage
#   - the profile is persisted by NetworkManager -> survives reboots
#   - wired Ethernet is left at default priority so it is preferred when present;
#     WiFi is the automatic fallback
#   - enterprise: optional CA cert + domain-suffix-match so the device only trusts
#     the real campus RADIUS server (also required by modern wpa_supplicant)
#
# Never exits non-zero on a config hiccup — it must not block boot.

set -u

# Serialize: on first boot both firstboot.sh and nicu-wifi.service invoke this.
# If another instance holds the lock, let it do the work and exit quietly.
exec 9>/run/nicu-apply-wifi.lock
flock -n 9 || { echo "[apply-wifi] another instance is running — skipping."; exit 0; }

CON_NAME="nicu-wifi"
STATE_DIR="/var/lib/nicu"
HASH_FILE="$STATE_DIR/wifi.hash"

WIFI_FILE=/boot/firmware/wifi.txt
[ -f "$WIFI_FILE" ] || WIFI_FILE=/boot/wifi.txt
[ -f "$WIFI_FILE" ] || { echo "[apply-wifi] no wifi.txt found — nothing to do."; exit 0; }

# Read "key=value" from wifi.txt: case-insensitive key, strips the CR, spaces
# around "=", and any leading/trailing spaces on the value (a stray trailing
# space would otherwise become part of the SSID/password and silently fail to
# connect). Internal spaces are kept — SSIDs and passwords can contain them.
_wf() {
    sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//Ip" "$WIFI_FILE" \
        | head -1 | tr -d '\r' | sed 's/[[:space:]]*$//'
}

SECURITY="$(_wf security | tr 'A-Z' 'a-z')"; SECURITY="${SECURITY:-wpa-psk}"
SSID="$(_wf ssid)"
PSK="$(_wf password)"
IDENTITY="$(_wf identity)"
ANON="$(_wf anonymous_identity)"
EAP="$(_wf eap | tr 'A-Z' 'a-z')"; EAP="${EAP:-peap}"
PHASE2="$(_wf phase2 | tr 'A-Z' 'a-z')"; PHASE2="${PHASE2:-mschapv2}"
CA_CERT="$(_wf ca_cert)"
DOMAIN="$(_wf domain_suffix_match)"
COUNTRY="$(_wf country)"; COUNTRY="${COUNTRY:-US}"

# Nothing to do until the doctor fills in a real SSID.
if [ -z "$SSID" ] || [ "$SSID" = "YOUR_WIFI_NAME" ]; then
    echo "[apply-wifi] wifi.txt still has placeholder values — relying on Ethernet if present."
    exit 0
fi

# Only (re)apply when wifi.txt changed AND the profile already exists. On first
# boot the profile is absent, so we always apply then.
mkdir -p "$STATE_DIR"
NEW_HASH="$(md5sum "$WIFI_FILE" | awk '{print $1}')"
OLD_HASH="$(cat "$HASH_FILE" 2>/dev/null || echo none)"
if [ "$NEW_HASH" = "$OLD_HASH" ] && nmcli -t -f NAME connection show 2>/dev/null | grep -qx "$CON_NAME"; then
    echo "[apply-wifi] wifi.txt unchanged and '$CON_NAME' exists — NetworkManager will reconnect on its own."
    exit 0
fi

echo "[apply-wifi] Configuring WiFi for SSID '$SSID' (security=$SECURITY, country $COUNTRY)..."
raspi-config nonint do_wifi_country "$COUNTRY" 2>/dev/null || iw reg set "$COUNTRY" 2>/dev/null || true
rfkill unblock wifi 2>/dev/null || true
nmcli radio wifi on 2>/dev/null || true

nmcli connection delete "$CON_NAME" 2>/dev/null || true
nmcli connection add type wifi con-name "$CON_NAME" ifname wlan0 ssid "$SSID" 2>/dev/null || true

# Self-healing: autoconnect forever (0 = infinite retries), keep the radio trying.
nmcli connection modify "$CON_NAME" \
    connection.autoconnect yes \
    connection.autoconnect-retries 0 2>/dev/null || true

case "$SECURITY" in
    wpa-eap|enterprise|eap|802.1x)
        # WPA2-Enterprise (PEAP/TTLS + MSCHAPv2): username (identity) + password.
        nmcli connection modify "$CON_NAME" \
            wifi-sec.key-mgmt wpa-eap \
            802-1x.eap "$EAP" \
            802-1x.phase2-auth "$PHASE2" \
            802-1x.identity "$IDENTITY" \
            802-1x.password "$PSK" 2>/dev/null || true
        [ -n "$ANON" ] && nmcli connection modify "$CON_NAME" 802-1x.anonymous-identity "$ANON" 2>/dev/null || true
        # CA cert + domain match = only ever trust the real campus RADIUS server.
        # Strongly recommended (and required by newer wpa_supplicant). If absent,
        # we still connect so the device isn't dead on arrival.
        if [ -n "$CA_CERT" ] && [ -f "$CA_CERT" ]; then
            nmcli connection modify "$CON_NAME" 802-1x.ca-cert "$CA_CERT" 2>/dev/null || true
        fi
        [ -n "$DOMAIN" ] && nmcli connection modify "$CON_NAME" 802-1x.domain-suffix-match "$DOMAIN" 2>/dev/null || true
        ;;
    open|none)
        nmcli connection modify "$CON_NAME" wifi-sec.key-mgmt none 2>/dev/null || true
        ;;
    *)
        # Home / clinic WPA2-PSK (default).
        nmcli connection modify "$CON_NAME" \
            wifi-sec.key-mgmt wpa-psk \
            wifi-sec.psk "$PSK" 2>/dev/null || true
        ;;
esac

if nmcli connection up "$CON_NAME" 2>/dev/null; then
    # Only remember the hash once the profile is in place, so a failed apply
    # is retried on the next boot instead of being skipped.
    echo "$NEW_HASH" > "$HASH_FILE"
    echo "[apply-wifi] WiFi profile '$CON_NAME' is up."
else
    echo "[apply-wifi] '$CON_NAME' saved; radio still settling — NetworkManager will keep retrying."
    echo "$NEW_HASH" > "$HASH_FILE"
fi

exit 0
