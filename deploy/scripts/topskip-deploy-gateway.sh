#!/usr/bin/env bash

set -euo pipefail

readonly DEPLOY_COMMAND=/usr/local/sbin/topskip-deploy
readonly ORIGINAL_COMMAND=${SSH_ORIGINAL_COMMAND:-}
readonly IMAGE_PATTERN='ghcr\.io/maximtop/topskip-backend@sha256:[a-f0-9]{64}'

case "${ORIGINAL_COMMAND}" in
    status)
        exec sudo -n "${DEPLOY_COMMAND}" status
        ;;
    rollback)
        exec sudo -n "${DEPLOY_COMMAND}" rollback
        ;;
esac

if [[ "${ORIGINAL_COMMAND}" =~ ^deploy[[:space:]]+(${IMAGE_PATTERN})$ ]]; then
    exec sudo -n "${DEPLOY_COMMAND}" deploy "${BASH_REMATCH[1]}"
fi

echo 'TopSkip deploy gateway rejected the command.' >&2
exit 64
