// Pre-provisioning hook for AWS IoT Fleet Provisioning.
//
// AWS invokes this Lambda during a device's first-boot provisioning, BEFORE it
// hands out the real certificate. Its job here is to decide whether to allow
// provisioning and to inject the device_code the template will use as the Thing
// name. We keep it thin: it forwards the Pi's hardware serial to the app's
// POST /devices/provision endpoint (which allocates the next PI-##### and
// inserts the devices row), then returns that code as a parameter override.
//
// Contract:
//   - event.parameters.SerialNumber : sent by the device (RegisterThing params)
//   - return { allowProvisioning, parameterOverrides: { DeviceCode } }
//
// Notes:
//   - The hook has a hard ~5s timeout and MAY be called more than once for the
//     same device, so the backend endpoint is idempotent by serial (same serial
//     -> same device_code, no duplicate row).
//   - Node 18+ runtime: global fetch is available, no dependencies to bundle.
//
// Env vars (set by setup-fleet-provisioning.sh):
//   PROVISION_URL    - e.g. https://remotereading.duckdns.org/api/v1/devices/provision
//   PROVISION_SECRET - must match the server's DEVICE_PROVISION_SECRET

exports.handler = async (event) => {
  const serial = event?.parameters?.SerialNumber;

  if (!serial) {
    console.error('No SerialNumber in provisioning parameters — denying.');
    return { allowProvisioning: false };
  }

  try {
    const resp = await fetch(process.env.PROVISION_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-provision-secret': process.env.PROVISION_SECRET,
      },
      body: JSON.stringify({ serial_number: serial }),
      // Keep well under the hook's 5s ceiling.
      signal: AbortSignal.timeout(4000),
    });

    if (!resp.ok) {
      console.error(`Backend provision failed: ${resp.status} ${await resp.text()}`);
      return { allowProvisioning: false };
    }

    const data = await resp.json();
    if (!data.device_code) {
      console.error('Backend did not return a device_code — denying.');
      return { allowProvisioning: false };
    }

    console.log(`Provisioning ${serial} -> ${data.device_code} (reused=${!!data.reused})`);
    return {
      allowProvisioning: true,
      parameterOverrides: { DeviceCode: data.device_code },
    };
  } catch (err) {
    console.error('Pre-provisioning hook error:', err);
    return { allowProvisioning: false };
  }
};
