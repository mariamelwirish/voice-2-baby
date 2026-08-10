# AWS Fleet Provisioning (zero-touch Pi registration)

One-time AWS setup that lets every Raspberry Pi speaker **self-register on first
boot** from a single, identical golden image — no per-device certs, no SSH, no
steps for doctors or IT. This is the "by claim" flavor of AWS IoT Fleet
Provisioning.

## How it works

1. Every Pi ships with the **same shared claim certificate** (baked into the image).
2. On first boot the Pi uses the claim cert to run the provisioning handshake.
   AWS calls the **pre-provisioning Lambda**, which asks the app's
   `POST /devices/provision` for the next `PI-#####` (allocating it + inserting
   the `devices` row), and returns that as the Thing name.
3. AWS mints a **unique per-device certificate**, creates the Thing
   `PI-#####`, and attaches the per-device policy.
4. The Pi saves its new cert + code and connects normally. It appears in the
   Speakers tab as Online/unassigned; the admin just clicks **Assign to baby**.

Idempotent by the Pi's hardware serial: re-flashing the same board reuses its
existing `PI-#####` instead of creating a duplicate.

## Prerequisites

- AWS CLI v2 configured with permissions for **IoT, IAM, and Lambda**.
- `jq` and `zip` installed.
- The server deployed and reachable over HTTPS, with `DEVICE_PROVISION_SECRET`
  set in its env (see `.env.example`). The migration adding `devices.serial_number`
  must be applied (it runs automatically on server start).

## Run it

```bash
cd scripts/aws
PROVISION_SECRET='<same as server DEVICE_PROVISION_SECRET>' \
PROVISION_URL='https://remotereading.duckdns.org/api/v1/devices/provision' \
  ./setup-fleet-provisioning.sh us-east-1
```

Re-running is safe — every step checks for existing resources first. When it
finishes it prints the IoT endpoint, template name, and the claim-cert paths to
bake into the image (Phase 3, `DEVICE_IMAGE.md`).

## What it creates

| Resource | Name | Purpose |
|---|---|---|
| IoT policy | `nicu-fleet-device-policy` | Per-device topic access, scoped to the device's own `devices/<ThingName>/*` via the `${iot:Connection.Thing.ThingName}` policy variable. One document, but no device can touch another's topics. |
| IoT policy | `nicu-provisioning-claim-policy` | Minimal rights for the shared claim cert: it can **only** drive the provisioning handshake — not connect as a real device or read/publish anything. |
| IAM role | `nicu-preprovision-lambda-role` | Lambda execution role (basic logging). |
| Lambda | `nicu-preprovision-hook` | Calls `POST /devices/provision` and returns the allocated `PI-#####`. |
| IAM role | `nicu-fleet-provisioning-role` | Role IoT assumes to register Things (`AWSIoTThingsRegistration`). |
| Provisioning template | `nicu-fleet-template` | Ties it together: creates the Thing, activates the cert, attaches the device policy, runs the hook. |
| Claim certificate | saved to `scripts/certs/claim/` | The shared cert for the image (gitignored). |

## Security notes

- **Claim cert is shared**, so its policy is deliberately tiny and every request
  is still gated by the Lambda (which needs the shared secret to reach the
  backend, and the backend allocates the code). If it ever leaked, the worst
  case is someone registering extra unassigned devices — not reading or playing
  anything. Rotate by deleting `scripts/certs/claim/` and re-running (then
  re-flash images).
- The claim key and all device certs live under `scripts/certs/`, which is
  **gitignored** — never commit them.
- The Lambda holds `DEVICE_PROVISION_SECRET` in its env; keep it in sync with
  the server. Rotate both together.

## Next

Phase 3 (`DEVICE_IMAGE.md`): the Pi-side provisioning agent + systemd units +
how to build the golden SD image.
