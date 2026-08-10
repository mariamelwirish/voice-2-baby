#!/bin/bash
# setup-fleet-provisioning.sh
#
# ONE-TIME AWS setup for zero-touch Raspberry Pi provisioning (AWS IoT Fleet
# Provisioning by claim). Run this once with AWS credentials that can manage
# IoT, IAM, and Lambda. It creates, idempotently:
#
#   1. nicu-fleet-device-policy       - per-device topic policy (scoped by ThingName)
#   2. nicu-provisioning-claim-policy - minimal policy for the shared claim cert
#   3. nicu-preprovision-lambda-role  - execution role for the hook Lambda
#   4. nicu-preprovision-hook         - Lambda that calls POST /devices/provision
#   5. nicu-fleet-provisioning-role   - role IoT assumes to register Things
#   6. nicu-fleet-template            - the provisioning template (+ hook)
#   7. a CLAIM certificate            - saved to scripts/certs/claim/ for the image
#
# After it finishes it prints exactly what to bake into the golden SD image.
#
# Usage:
#   PROVISION_SECRET=... PROVISION_URL=https://<api-host>/api/v1/devices/provision \
#     ./setup-fleet-provisioning.sh [aws-region]
#
# Defaults: region us-east-1. PROVISION_SECRET must equal the server's
# DEVICE_PROVISION_SECRET. Requires: aws cli v2, jq, zip.

set -euo pipefail

REGION="${1:-us-east-1}"
PROVISION_URL="${PROVISION_URL:?Set PROVISION_URL=https://<api-host>/api/v1/devices/provision}"
PROVISION_SECRET="${PROVISION_SECRET:?Set PROVISION_SECRET (must match server DEVICE_PROVISION_SECRET)}"

DEVICE_POLICY="nicu-fleet-device-policy"
CLAIM_POLICY="nicu-provisioning-claim-policy"
TEMPLATE="nicu-fleet-template"
LAMBDA="nicu-preprovision-hook"
LAMBDA_ROLE="nicu-preprovision-lambda-role"
PROV_ROLE="nicu-fleet-provisioning-role"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
POLICIES_DIR="$SCRIPT_DIR/policies"
TEMPLATES_DIR="$SCRIPT_DIR/templates"
HOOK_DIR="$SCRIPT_DIR/preprovision-hook"
CLAIM_DIR="$SCRIPT_DIR/../certs/claim"

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
echo "==> Account $ACCOUNT_ID, region $REGION"

# Substitutes REGION_PLACEHOLDER / ACCOUNT_PLACEHOLDER but leaves ${iot:...} and
# $aws intact (those are literal IoT policy syntax, not shell/sed variables).
render_policy() {
    sed -e "s/REGION_PLACEHOLDER/$REGION/g" -e "s/ACCOUNT_PLACEHOLDER/$ACCOUNT_ID/g" "$1"
}

# ---- 1 & 2: IoT policies ------------------------------------------------------
create_iot_policy() {
    local name="$1" file="$2"
    if aws iot get-policy --policy-name "$name" --region "$REGION" >/dev/null 2>&1; then
        echo "    Policy $name already exists — leaving as-is."
    else
        aws iot create-policy --policy-name "$name" \
            --policy-document "$(render_policy "$file")" --region "$REGION" >/dev/null
        echo "    Created policy $name."
    fi
}
echo "==> [1/7] Device policy"
create_iot_policy "$DEVICE_POLICY" "$POLICIES_DIR/device-policy.json"
echo "==> [2/7] Claim policy"
create_iot_policy "$CLAIM_POLICY" "$POLICIES_DIR/claim-policy.json"

# ---- 3: Lambda execution role -------------------------------------------------
echo "==> [3/7] Lambda execution role"
if aws iam get-role --role-name "$LAMBDA_ROLE" >/dev/null 2>&1; then
    echo "    Role $LAMBDA_ROLE already exists."
else
    aws iam create-role --role-name "$LAMBDA_ROLE" \
        --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}' >/dev/null
    aws iam attach-role-policy --role-name "$LAMBDA_ROLE" \
        --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
    echo "    Created role $LAMBDA_ROLE. Waiting for IAM propagation..."
    sleep 10
fi
LAMBDA_ROLE_ARN=$(aws iam get-role --role-name "$LAMBDA_ROLE" --query 'Role.Arn' --output text)

# ---- 4: the hook Lambda -------------------------------------------------------
echo "==> [4/7] Pre-provisioning hook Lambda"
ZIP="$(mktemp -d)/hook.zip"
( cd "$HOOK_DIR" && zip -q -r "$ZIP" index.js )

if aws lambda get-function --function-name "$LAMBDA" --region "$REGION" >/dev/null 2>&1; then
    aws lambda update-function-code --function-name "$LAMBDA" \
        --zip-file "fileb://$ZIP" --region "$REGION" >/dev/null
    aws lambda update-function-configuration --function-name "$LAMBDA" \
        --environment "Variables={PROVISION_URL=$PROVISION_URL,PROVISION_SECRET=$PROVISION_SECRET}" \
        --region "$REGION" >/dev/null
    echo "    Updated Lambda $LAMBDA."
else
    aws lambda create-function --function-name "$LAMBDA" \
        --runtime nodejs20.x --handler index.handler --timeout 5 \
        --role "$LAMBDA_ROLE_ARN" --zip-file "fileb://$ZIP" \
        --environment "Variables={PROVISION_URL=$PROVISION_URL,PROVISION_SECRET=$PROVISION_SECRET}" \
        --region "$REGION" >/dev/null
    echo "    Created Lambda $LAMBDA."
fi
LAMBDA_ARN=$(aws lambda get-function --function-name "$LAMBDA" --query 'Configuration.FunctionArn' --output text --region "$REGION")

# Allow AWS IoT to invoke the hook (ignore if the permission already exists).
aws lambda add-permission --function-name "$LAMBDA" --statement-id iot-preprovision \
    --action lambda:InvokeFunction --principal iot.amazonaws.com --region "$REGION" >/dev/null 2>&1 \
    && echo "    Granted IoT permission to invoke the Lambda." \
    || echo "    IoT invoke permission already present."

# ---- 5: fleet provisioning role (IoT assumes this to register Things) ----------
echo "==> [5/7] Fleet provisioning role"
if aws iam get-role --role-name "$PROV_ROLE" >/dev/null 2>&1; then
    echo "    Role $PROV_ROLE already exists."
else
    aws iam create-role --role-name "$PROV_ROLE" \
        --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"iot.amazonaws.com"},"Action":"sts:AssumeRole"}]}' >/dev/null
    aws iam attach-role-policy --role-name "$PROV_ROLE" \
        --policy-arn arn:aws:iam::aws:policy/service-role/AWSIoTThingsRegistration
    echo "    Created role $PROV_ROLE. Waiting for IAM propagation..."
    sleep 10
fi
PROV_ROLE_ARN=$(aws iam get-role --role-name "$PROV_ROLE" --query 'Role.Arn' --output text)

# ---- 6: provisioning template -------------------------------------------------
echo "==> [6/7] Provisioning template"
TEMPLATE_BODY=$(cat "$TEMPLATES_DIR/provisioning-template.json")
if aws iot describe-provisioning-template --template-name "$TEMPLATE" --region "$REGION" >/dev/null 2>&1; then
    aws iot update-provisioning-template --template-name "$TEMPLATE" \
        --enabled --provisioning-role-arn "$PROV_ROLE_ARN" \
        --template-body "$TEMPLATE_BODY" \
        --pre-provisioning-hook "targetArn=$LAMBDA_ARN" --region "$REGION" >/dev/null
    echo "    Updated template $TEMPLATE."
else
    aws iot create-provisioning-template --template-name "$TEMPLATE" \
        --enabled --provisioning-role-arn "$PROV_ROLE_ARN" \
        --template-body "$TEMPLATE_BODY" \
        --pre-provisioning-hook "targetArn=$LAMBDA_ARN" \
        --type FLEET_PROVISIONING --region "$REGION" >/dev/null
    echo "    Created template $TEMPLATE."
fi

# ---- 7: claim certificate -----------------------------------------------------
echo "==> [7/7] Claim certificate"
mkdir -p "$CLAIM_DIR"
if [ -f "$CLAIM_DIR/claim.cert.pem" ]; then
    echo "    Claim cert already present at $CLAIM_DIR — reusing (delete to rotate)."
else
    aws iot create-keys-and-certificate --set-as-active \
        --certificate-pem-outfile "$CLAIM_DIR/claim.cert.pem" \
        --public-key-outfile "$CLAIM_DIR/claim.public.key" \
        --private-key-outfile "$CLAIM_DIR/claim.private.key" \
        --region "$REGION" > "$CLAIM_DIR/claim-cert-info.json"
    CLAIM_CERT_ARN=$(jq -r '.certificateArn' "$CLAIM_DIR/claim-cert-info.json")
    aws iot attach-policy --policy-name "$CLAIM_POLICY" --target "$CLAIM_CERT_ARN" --region "$REGION"
    echo "    Created claim cert and attached $CLAIM_POLICY."
fi
if [ ! -f "$CLAIM_DIR/AmazonRootCA1.pem" ]; then
    curl -s -o "$CLAIM_DIR/AmazonRootCA1.pem" https://www.amazontrust.com/repository/AmazonRootCA1.pem
fi

IOT_ENDPOINT=$(aws iot describe-endpoint --endpoint-type iot:Data-ATS --query endpointAddress --output text --region "$REGION")

cat <<SUMMARY

============================================================
 Fleet provisioning is set up. Bake these into the golden image:
------------------------------------------------------------
  IoT endpoint : $IOT_ENDPOINT
  Template     : $TEMPLATE
  Claim certs  : $CLAIM_DIR/
                   claim.cert.pem
                   claim.private.key
                   AmazonRootCA1.pem
------------------------------------------------------------
 The SAME claim cert goes on EVERY Pi. Each device swaps it for
 its own unique cert on first boot. See DEVICE_IMAGE.md (Phase 3).
============================================================
SUMMARY
