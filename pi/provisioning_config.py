# provisioning_config.py
#
# Baked into the golden image — IDENTICAL on every Pi. It holds only the shared,
# non-secret coordinates the first-boot provisioning agent needs. The per-device
# identity (DEVICE_CODE + the unique cert) does NOT live here; it's created at
# first boot and written to device_config.py + ~/certs by provision_agent.py.
#
# Set these two values once when you build the image (see DEVICE_IMAGE.md). The
# setup-fleet-provisioning.sh script prints the endpoint + template name.

from pathlib import Path

# From: aws iot describe-endpoint --endpoint-type iot:Data-ATS
IOT_ENDPOINT = "ad6mtn56o2o34-ats.iot.us-east-1.amazonaws.com"

# The provisioning template created by setup-fleet-provisioning.sh
PROVISIONING_TEMPLATE = "nicu-fleet-template"

# Where certs live on the Pi.
CERTS_DIR = Path.home() / "certs"
CLAIM_DIR = CERTS_DIR / "claim"

# Shared claim cert (same on every Pi) used only for the first-boot handshake.
CLAIM_CERT = CLAIM_DIR / "claim.cert.pem"
CLAIM_KEY = CLAIM_DIR / "claim.private.key"
CA_PATH = CERTS_DIR / "AmazonRootCA1.pem"
