#!/usr/bin/env python3
# provision_agent.py
#
# Runs ONCE on a Pi's first boot (before pi_subscriber.py). Using the shared
# claim certificate baked into the image, it performs the AWS IoT Fleet
# Provisioning handshake:
#
#   1. CreateKeysAndCertificate  -> AWS mints a unique per-device cert + key
#   2. RegisterThing (template)  -> the pre-provisioning Lambda allocates the
#                                   next PI-##### (and inserts the devices row);
#                                   AWS creates the Thing named PI-#####
#
# It then writes the device's own cert/key to ~/certs and its code to
# device_config.py, so pi_subscriber.py can connect as a normal device.
#
# Idempotent: if this Pi already has a device_config + matching cert, it exits
# immediately (a reboot never re-provisions). The whole image is identical
# across Pis — the identity is created here, at first boot, not baked in.

import json
import sys
import time
import uuid
from pathlib import Path

from awscrt import mqtt
from awsiot import iotidentity, mqtt_connection_builder

import provisioning_config as cfg

DEVICE_CONFIG_PATH = Path(__file__).resolve().parent / "device_config.py"

# ── helpers ───────────────────────────────────────────────────────────

def read_pi_serial():
    """Stable hardware ID for this board. Idempotency key: the same Pi always
    maps back to the same PI-##### (the backend keys on it)."""
    try:
        data = Path("/sys/firmware/devicetree/base/serial-number").read_text()
        s = data.strip("\x00\n ").strip()
        if s:
            return s
    except Exception:
        pass
    try:
        for line in Path("/proc/cpuinfo").read_text().splitlines():
            if line.startswith("Serial"):
                return line.split(":", 1)[1].strip()
    except Exception:
        pass
    # Last resort so provisioning still works on non-Pi hardware / dev boards.
    return f"mac-{uuid.getnode():012x}"


def already_provisioned():
    """True if a prior boot already provisioned this Pi (config + cert present)."""
    if not DEVICE_CONFIG_PATH.exists():
        return False
    try:
        ns = {}
        exec(DEVICE_CONFIG_PATH.read_text(), ns)
        code = ns.get("DEVICE_CODE")
        if not code:
            return False
        return (cfg.CERTS_DIR / f"{code}_certificate.crt").exists() and \
               (cfg.CERTS_DIR / f"{code}_private.key").exists()
    except Exception:
        return False


def connect():
    """Connect to AWS IoT with the shared claim cert, retrying until the network
    is up (first boot often races DHCP/Wi-Fi)."""
    while True:
        try:
            conn = mqtt_connection_builder.mtls_from_path(
                endpoint=cfg.IOT_ENDPOINT,
                # Connect over 443 (the HTTPS port) instead of the MQTT-standard
                # 8883. Restrictive networks (university/hospital firewalls) block
                # 8883 but always allow 443; AWS IoT accepts MQTT on 443 and the
                # SDK negotiates it via ALPN ("x-amzn-mqtt-ca") automatically.
                port=443,
                cert_filepath=str(cfg.CLAIM_CERT),
                pri_key_filepath=str(cfg.CLAIM_KEY),
                ca_filepath=str(cfg.CA_PATH),
                client_id=f"provision-{uuid.uuid4()}",
                clean_session=True,
                keep_alive_secs=30,
            )
            conn.connect().result()
            return conn
        except Exception as e:
            print(f"Provisioning connect failed ({e}); network may not be up — retrying in 5s...")
            time.sleep(5)


# ── the provisioning exchange ─────────────────────────────────────────
# awsiot.iotidentity is callback/future based. We drive it step by step and
# block on futures, which keeps the flow readable for a one-shot script.

def provision(identity, serial):
    # Step 1 — CreateKeysAndCertificate
    create_accepted = {}
    accepted_fut = identity.subscribe_to_create_keys_and_certificate_accepted(
        request=iotidentity.CreateKeysAndCertificateSubscriptionRequest(),
        qos=mqtt.QoS.AT_LEAST_ONCE,
        callback=lambda resp: create_accepted.update(
            token=resp.certificate_ownership_token,
            cert_pem=resp.certificate_pem,
            key=resp.private_key,
        ),
    )
    accepted_fut[0].result()

    rejected = {}
    rej_fut = identity.subscribe_to_create_keys_and_certificate_rejected(
        request=iotidentity.CreateKeysAndCertificateSubscriptionRequest(),
        qos=mqtt.QoS.AT_LEAST_ONCE,
        callback=lambda err: rejected.update(msg=f"{err.error_code}: {err.error_message}"),
    )
    rej_fut[0].result()

    identity.publish_create_keys_and_certificate(
        request=iotidentity.CreateKeysAndCertificateRequest(),
        qos=mqtt.QoS.AT_LEAST_ONCE,
    ).result()

    for _ in range(100):  # up to ~10s
        if create_accepted or rejected:
            break
        time.sleep(0.1)
    if rejected:
        raise RuntimeError(f"CreateKeysAndCertificate rejected: {rejected['msg']}")
    if not create_accepted:
        raise RuntimeError("CreateKeysAndCertificate timed out")

    # Step 2 — RegisterThing (fires the pre-provisioning Lambda -> PI-#####)
    register_accepted = {}
    reg_acc_fut = identity.subscribe_to_register_thing_accepted(
        request=iotidentity.RegisterThingSubscriptionRequest(template_name=cfg.PROVISIONING_TEMPLATE),
        qos=mqtt.QoS.AT_LEAST_ONCE,
        callback=lambda resp: register_accepted.update(thing_name=resp.thing_name),
    )
    reg_acc_fut[0].result()

    reg_rejected = {}
    reg_rej_fut = identity.subscribe_to_register_thing_rejected(
        request=iotidentity.RegisterThingSubscriptionRequest(template_name=cfg.PROVISIONING_TEMPLATE),
        qos=mqtt.QoS.AT_LEAST_ONCE,
        callback=lambda err: reg_rejected.update(msg=f"{err.error_code}: {err.error_message}"),
    )
    reg_rej_fut[0].result()

    identity.publish_register_thing(
        request=iotidentity.RegisterThingRequest(
            template_name=cfg.PROVISIONING_TEMPLATE,
            certificate_ownership_token=create_accepted["token"],
            parameters={"SerialNumber": serial},
        ),
        qos=mqtt.QoS.AT_LEAST_ONCE,
    ).result()

    for _ in range(100):
        if register_accepted or reg_rejected:
            break
        time.sleep(0.1)
    if reg_rejected:
        raise RuntimeError(f"RegisterThing rejected: {reg_rejected['msg']}")
    if not register_accepted:
        raise RuntimeError("RegisterThing timed out")

    return register_accepted["thing_name"], create_accepted["cert_pem"], create_accepted["key"]


def save_identity(device_code, cert_pem, private_key):
    cfg.CERTS_DIR.mkdir(parents=True, exist_ok=True)
    (cfg.CERTS_DIR / f"{device_code}_certificate.crt").write_text(cert_pem)
    key_path = cfg.CERTS_DIR / f"{device_code}_private.key"
    key_path.write_text(private_key)
    key_path.chmod(0o600)
    DEVICE_CONFIG_PATH.write_text(
        "# device_config.py — auto-generated by provision_agent.py on first boot.\n"
        f'DEVICE_CODE = "{device_code}"\n'
    )


# ── main ──────────────────────────────────────────────────────────────

def main():
    if already_provisioned():
        print("Already provisioned — nothing to do.")
        return 0

    serial = read_pi_serial()
    print(f"First boot — provisioning this Pi (serial {serial})...")

    conn = connect()
    identity = iotidentity.IotIdentityClient(conn)
    try:
        device_code, cert_pem, private_key = provision(identity, serial)
    finally:
        try:
            conn.disconnect().result()
        except Exception:
            pass

    save_identity(device_code, cert_pem, private_key)
    print(f"Provisioned as {device_code}. Handing off to the subscriber.")
    return 0


if __name__ == "__main__":
    # On protocol errors, exit non-zero so the failure is visible in the logs.
    # Transient network issues are already retried inside connect().
    try:
        sys.exit(main())
    except Exception as e:
        print(f"Provisioning FAILED: {e}")
        sys.exit(1)
