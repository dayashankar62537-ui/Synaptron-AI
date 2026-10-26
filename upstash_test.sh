#!/usr/bin/env bash
# Upstash REST connection test for Aviqo feedback storage.
# Secrets are read from environment variables. Do not write the token into this file.
#
# Usage (macOS/Linux terminal):
#   export UPSTASH_REDIS_REST_URL="https://assured-elk-87330.upstash.io"
#   export UPSTASH_REDIS_REST_TOKEN="your-rest-token-here"
#   bash upstash_test.sh

set -euo pipefail

: "${UPSTASH_REDIS_REST_URL:?Set UPSTASH_REDIS_REST_URL first}"
: "${UPSTASH_REDIS_REST_TOKEN:?Set UPSTASH_REDIS_REST_TOKEN first}"

echo "1) SET my-key"
curl -s -H "Authorization: Bearer ${UPSTASH_REDIS_REST_TOKEN}" \
  -X POST "${UPSTASH_REDIS_REST_URL}" \
  -d '["SET","my-key","my-value"]'
echo

echo "2) GET my-key"
curl -s -H "Authorization: Bearer ${UPSTASH_REDIS_REST_TOKEN}" \
  -X POST "${UPSTASH_REDIS_REST_URL}" \
  -d '["GET","my-key"]'
echo

echo "3) LPUSH test entry to aviqo:feedback"
curl -s -H "Authorization: Bearer ${UPSTASH_REDIS_REST_TOKEN}" \
  -X POST "${UPSTASH_REDIS_REST_URL}" \
  -d '["LPUSH","aviqo:feedback","{\"rating\":\"up\",\"reply\":\"test\",\"ts\":0}"]'
echo

echo "Done. Expected results: {\"result\":\"OK\"}, {\"result\":\"my-value\"}, and a number like {\"result\":1}."
