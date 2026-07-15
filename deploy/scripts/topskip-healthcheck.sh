#!/usr/bin/env bash

set -euo pipefail

readonly URL=${1:-https://topskip.maximtop.dev/v1/health}
readonly TIMEOUT_SECONDS=${2:-90}
readonly INTERVAL_SECONDS=3

if ! [[ ${TIMEOUT_SECONDS} =~ ^[1-9][0-9]*$ ]]; then
    echo 'Health-check timeout must be a positive integer.' >&2
    exit 64
fi

deadline=$((SECONDS + TIMEOUT_SECONDS))
while ((SECONDS < deadline)); do
    response=$(curl \
        --fail \
        --silent \
        --show-error \
        --connect-timeout 5 \
        --max-time 10 \
        "${URL}" 2>/dev/null || true)
    normalized=$(printf '%s' "${response}" | tr -d '[:space:]')
    if [[ ${normalized} == '{"ok":true}' ]]; then
        echo "TopSkip health check passed: ${URL}"
        exit 0
    fi
    sleep "${INTERVAL_SECONDS}"
done

echo "TopSkip health check timed out: ${URL}" >&2
exit 1
