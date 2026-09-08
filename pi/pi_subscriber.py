#!/usr/bin/env python3
# pi_subscriber.py
#
# Runs on the Raspberry Pi. Connects to AWS IoT Core over MQTT using this
# device's certificate, subscribes to its own play/stop topics, and acts
# on incoming commands.
#
# This file is IDENTICAL across every physical Pi — the only thing that
# differs per device is DEVICE_CODE, imported from device_config.py
# (auto-generated per device by register-device.sh). Never hardcode a
# device code in this file.

import json
import signal
import ssl
import subprocess
import sys
import threading
import time
from pathlib import Path

import paho.mqtt.client as mqtt
import requests

from device_config import DEVICE_CODE

# ── CONFIG ────────────────────────────────────────────────────────────
# DEVICE_CODE MUST match:
#   1. The Thing name registered in AWS IoT Core
#   2. The device_code column in your devices table
#   3. What the backend uses to build the topic (devices/{device_code}/play)

# Endpoint comes from the shared provisioning_config (baked into the image) so
# the subscriber and the provisioning agent can never drift to different
# endpoints. Falls back to the literal value for older, manually-provisioned Pis
# that predate fleet provisioning and have no provisioning_config.py.
try:
    from provisioning_config import IOT_ENDPOINT
except ImportError:
    IOT_ENDPOINT = "ad6mtn56o2o34-ats.iot.us-east-1.amazonaws.com"
# Connect over 443 (not the MQTT-standard 8883): 443 is the HTTPS port, which
# restrictive networks (university/hospital firewalls) leave open. AWS IoT accepts
# MQTT on 443 via the ALPN protocol "x-amzn-mqtt-ca" (set on the TLS context in
# main()). Change back to 8883 only if a network blocks 443 (rare).
IOT_PORT = 443

CERTS_DIR = Path.home() / "certs"
CA_PATH = CERTS_DIR / "AmazonRootCA1.pem"
CERT_PATH = CERTS_DIR / f"{DEVICE_CODE}_certificate.crt"
KEY_PATH = CERTS_DIR / f"{DEVICE_CODE}_private.key"

PLAY_TOPIC = f"devices/{DEVICE_CODE}/play"
STOP_TOPIC = f"devices/{DEVICE_CODE}/stop"

DOWNLOAD_PATH = "/tmp/current_recording"        # raw file as downloaded (any format)
PLAY_PATH = "/tmp/current_recording_play.wav"   # decoded, always-fully-playable copy

# Playback state. play_lock serializes starting/replacing playback so two
# near-simultaneous play commands (an MQTT QoS-1 redelivery, or overlapping
# triggers) can't launch two mpg123 processes at once — that overlap is exactly
# what causes the "echo". current_recording_id lets us ignore an exact duplicate
# command for something that's already playing.
current_process = None
current_recording_id = None
play_lock = threading.Lock()
stop_event = threading.Event()

# How often to re-announce "online" so the backend's last_seen_at stays fresh.
# The backend treats a device with no contact for ~45 seconds as offline, so this
# must be comfortably under that — 15s means ~3 heartbeats fit in the window, so
# a single blip won't flip it offline, but a real drop shows within ~45s.
HEARTBEAT_SECONDS = 15


# ── MQTT CALLBACKS ────────────────────────────────────────────────────

def on_connect(client, userdata, flags, reason_code, properties=None):
    print(f"Connected to AWS IoT Core (reason code: {reason_code})")
    client.subscribe(PLAY_TOPIC, qos=1)
    client.subscribe(STOP_TOPIC, qos=1)
    print(f"Subscribed to: {PLAY_TOPIC}")
    print(f"Subscribed to: {STOP_TOPIC}")

    # Explicit "I'm here" signal — the positive counterpart to the will
    # message registered in main(). No recording_id, since this is a
    # device-level status, not tied to any specific playback.
    status_topic = f"devices/{DEVICE_CODE}/status"
    client.publish(status_topic, json.dumps({"status": "online"}), qos=1)
    print(f"Published status 'online' to {status_topic}")


def on_message(client, userdata, msg):
    print(f"Message received on {msg.topic}")

    try:
        payload = json.loads(msg.payload.decode("utf-8"))
    except json.JSONDecodeError:
        print("Received malformed JSON payload, ignoring.")
        return

    if msg.topic == PLAY_TOPIC:
        handle_play(client, payload)
    elif msg.topic == STOP_TOPIC:
        handle_stop()


# ── COMMAND HANDLERS ──────────────────────────────────────────────────

def handle_play(client, payload):
    thread = threading.Thread(target=_play_worker, args=(client, payload), daemon=True)
    thread.start()


def _play_worker(client, payload):
    global current_process, current_recording_id

    recording_id = payload.get("recording_id")
    presigned_url = payload.get("presigned_url")
    trigger_type = payload.get("trigger_type", "manual")

    if not presigned_url:
        print("Play message missing presigned_url, discarding.")
        publish_status(client, recording_id, "fetch_failed", trigger_type=trigger_type)
        return

    # If this exact recording is already playing, don't restart it (that would
    # interrupt a good playback) and don't launch a second copy (that would echo).
    # But do NOT silently drop it: re-publish the playing status so the backend and
    # UI stay consistent and the event is visible — never swallow a command.
    if (recording_id == current_recording_id
            and current_process is not None
            and current_process.poll() is None):
        print(f"Play for {recording_id} arrived while it's already playing — re-affirming status, not restarting.")
        publish_status(client, recording_id, "started", trigger_type=trigger_type)
        return

    print(f"Fetching audio for recording {recording_id}...")
    try:
        response = requests.get(presigned_url, timeout=15)
        response.raise_for_status()
        with open(DOWNLOAD_PATH, "wb") as f:
            f.write(response.content)
    except requests.RequestException as e:
        print(f"Failed to fetch audio: {e}")
        publish_status(client, recording_id, "fetch_failed", trigger_type=trigger_type)
        return

    # Decode to a clean WAV before playing. Browser microphone recordings are
    # WebM/Opus written as a live stream, so their container has no reliable
    # duration/index — ffplay trusts that and stops after a couple of seconds.
    # ffmpeg reads the ACTUAL audio packets to the real end and writes a proper
    # WAV, so the full message plays. MP3/other uploads decode fine too, so this
    # is uniform for every format.
    try:
        # -ar 48000 -ac 2: normalize to 48 kHz STEREO. Browser mic recordings are
        # mono, and a mono stream makes some speakers/outputs cut out mid-playback;
        # forcing stereo (mono is duplicated to both channels) fixes it and makes
        # every recording — mic or uploaded — a uniform, speaker-friendly format.
        subprocess.run(
            ["ffmpeg", "-y", "-loglevel", "error", "-i", DOWNLOAD_PATH,
             "-ar", "48000", "-ac", "2", "-c:a", "pcm_s16le", PLAY_PATH],
            check=True,
        )
    except (subprocess.CalledProcessError, FileNotFoundError) as e:
        print(f"Failed to decode audio: {e}")
        publish_status(client, recording_id, "play_failed", trigger_type=trigger_type)
        return

    # Start playback under the lock so two workers can't launch a player at the
    # same time (the cause of the echo). Stop whatever is currently playing first.
    # Uses the system's default audio output — this MUST run inside the user's
    # session (a systemd *user* service with lingering) or it can't reach the
    # Pi's audio (PipeWire).
    with play_lock:
        if current_process is not None and current_process.poll() is None:
            current_process.terminate()
            try:
                current_process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                current_process.kill()
        stop_event.clear()
        start_time = time.time()
        print("Playing audio...")
        proc = subprocess.Popen(["ffplay", "-nodisp", "-autoexit", "-loglevel", "error", PLAY_PATH])
        current_process = proc
        current_recording_id = recording_id

    publish_status(client, recording_id, "started", trigger_type=trigger_type)

    was_stopped_early = False
    while proc.poll() is None:
        if stop_event.is_set():
            proc.terminate()
            proc.wait()
            was_stopped_early = True
            break
        time.sleep(0.1)

    returncode = proc.returncode
    duration_played = round(time.time() - start_time)

    # Only clear the shared state if we're still the active playback — a newer
    # command may have replaced us while this one was finishing.
    with play_lock:
        if current_process is proc:
            current_process = None
            current_recording_id = None
            stop_event.clear()

    if was_stopped_early:
        print(f"Playback stopped early ({duration_played}s).")
        publish_status(client, recording_id, "stopped", duration_played, trigger_type=trigger_type)
    elif returncode != 0:
        # ffplay exited with an error — it couldn't open the audio device or
        # couldn't decode the file. Report a failure so the backend reverts the
        # recording to pending_review (with a note) instead of logging a false
        # success.
        print(f"Playback FAILED (ffplay exit {returncode}, {duration_played}s).")
        publish_status(client, recording_id, "play_failed", duration_played, trigger_type=trigger_type)
    else:
        print(f"Playback finished ({duration_played}s).")
        publish_status(client, recording_id, "played", duration_played, trigger_type=trigger_type)


def handle_stop():
    print("Stop command received.")
    if current_process is not None:
        stop_event.set()
    else:
        print("Nothing is currently playing.")


def publish_status(client, recording_id, status, duration_played=None, trigger_type=None):
    topic = f"devices/{DEVICE_CODE}/status"
    payload = {
        "recording_id": recording_id,
        "status": status,
        "reported_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    if duration_played is not None:
        payload["duration_played_seconds"] = duration_played
    if trigger_type is not None:
        payload["trigger_type"] = trigger_type

    client.publish(topic, json.dumps(payload), qos=1)
    print(f"Published status '{status}' to {topic}")


def start_heartbeat(client):
    """Re-announce 'online' every HEARTBEAT_SECONDS so the backend keeps this
    device marked online (it otherwise treats no-contact-for-~2-minutes as
    offline, which made the UI flip to offline mid-playback)."""
    status_topic = f"devices/{DEVICE_CODE}/status"

    def loop():
        while True:
            time.sleep(HEARTBEAT_SECONDS)
            try:
                client.publish(status_topic, json.dumps({"status": "online"}), qos=1)
            except Exception as e:
                print(f"Heartbeat publish failed: {e}")

    threading.Thread(target=loop, daemon=True).start()


# ── MAIN ───────────────────────────────────────────────────────────────

def main():
    client = mqtt.Client(client_id=DEVICE_CODE, protocol=mqtt.MQTTv311)
    client.on_connect = on_connect
    client.on_message = on_message

    # Build the TLS context ourselves so we can set ALPN to "x-amzn-mqtt-ca",
    # which is what lets AWS IoT accept MQTT over port 443 (see IOT_PORT above).
    # (paho's plain tls_set() has no ALPN option, so we use tls_set_context.)
    ssl_ctx = ssl.create_default_context(ssl.Purpose.SERVER_AUTH, cafile=str(CA_PATH))
    ssl_ctx.load_cert_chain(certfile=str(CERT_PATH), keyfile=str(KEY_PATH))
    ssl_ctx.set_alpn_protocols(["x-amzn-mqtt-ca"])
    client.tls_set_context(ssl_ctx)

    # Last Will and Testament: AWS IoT Core will publish this automatically
    # on our behalf the moment it detects this connection dropped —
    # crash, power loss, network failure, anything ungraceful. No code on
    # the Pi runs at that moment; the broker does this entirely on its own.
    status_topic = f"devices/{DEVICE_CODE}/status"
    will_payload = json.dumps({"status": "offline"})
    client.will_set(status_topic, payload=will_payload, qos=1, retain=False)

    # Graceful shutdown (systemd stop / reboot sends SIGTERM): publish "offline"
    # right away so a clean stop shows instantly, instead of waiting for the
    # heartbeat window. Power loss / crashes can't run this — that's what the
    # Last Will above covers (~45s).
    def handle_shutdown(signum, frame):
        try:
            client.publish(status_topic, json.dumps({"status": "offline"}), qos=1)
            time.sleep(0.5)  # give the publish a moment to flush
            client.disconnect()
        except Exception:
            pass
        sys.exit(0)

    signal.signal(signal.SIGTERM, handle_shutdown)
    signal.signal(signal.SIGINT, handle_shutdown)

    print(f"Connecting to {IOT_ENDPOINT}...")
    # Retry the initial connection. On boot (or after a power cut) the Wi-Fi /
    # network is often not up yet, and a plain connect() would raise and crash
    # the service before it ever starts — so the Pi would never reconnect until
    # someone restarted it by hand. Keep trying until it succeeds; after that,
    # loop_forever() handles any later drops (Wi-Fi blips, router reboots) on its own.
    while True:
        try:
            # keepalive=30: AWS declares the connection dead ~45s after the last
            # traffic and fires the Last Will ("offline") — so a power cut is
            # reflected in the UI within ~45s instead of a couple of minutes.
            client.connect(IOT_ENDPOINT, IOT_PORT, keepalive=30)
            break
        except Exception as e:
            print(f"Initial connect failed ({e}); network may not be up yet — retrying in 5s...")
            time.sleep(5)

    start_heartbeat(client)
    client.loop_forever()


if __name__ == "__main__":
    main()