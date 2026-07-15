#!/usr/bin/env bash

set -euo pipefail

readonly REPOSITORY_DIRECTORY=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
readonly RUN_ID=$$
readonly IMAGE="topskip-backend:container-smoke-${RUN_ID}"
readonly CONTAINER="topskip-container-smoke-${RUN_ID}"
readonly VOLUME="topskip-container-smoke-${RUN_ID}"
readonly ORIGIN='chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
readonly OPENROUTER_KEY='smoke-key-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
readonly IP_HMAC_SECRET='bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

cleanup() {
    docker rm --force "${CONTAINER}" >/dev/null 2>&1 || true
    docker volume rm "${VOLUME}" >/dev/null 2>&1 || true
    docker image rm --force "${IMAGE}" >/dev/null 2>&1 || true
}

wait_for_health() {
    local attempt
    local health

    for ((attempt = 1; attempt <= 30; attempt += 1)); do
        health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "${CONTAINER}" 2>/dev/null || true)
        if [[ ${health} == healthy ]]; then
            return
        fi
        if [[ ${health} == unhealthy || ${health} == missing ]]; then
            docker logs "${CONTAINER}" >&2 || true
            return 1
        fi
        sleep 1
    done

    docker logs "${CONTAINER}" >&2 || true
    return 1
}

run_container() {
    docker run \
        --detach \
        --name "${CONTAINER}" \
        --platform linux/amd64 \
        --init \
        --user 1000:1000 \
        --read-only \
        --tmpfs /tmp:rw,exec,nosuid,nodev,size=256m,uid=1000,gid=1000,mode=0700 \
        --cap-drop ALL \
        --security-opt no-new-privileges:true \
        --pids-limit 128 \
        --memory 1g \
        --cpus 1 \
        --publish 127.0.0.1::8787 \
        --volume "${VOLUME}:/var/lib/topskip" \
        --env "OPENROUTER_API_KEY=${OPENROUTER_KEY}" \
        --env "TOPSKIP_IP_HMAC_SECRET=${IP_HMAC_SECRET}" \
        --env "TOPSKIP_ALLOWED_EXTENSION_ORIGINS=${ORIGIN}" \
        "${IMAGE}" >/dev/null
    wait_for_health
}

database_installation_count() {
    docker exec "${CONTAINER}" node -e \
        "const {DatabaseSync}=require('node:sqlite'); const db=new DatabaseSync('/var/lib/topskip/topskip.sqlite',{readOnly:true}); console.log(db.prepare('select count(*) as count from installations').get().count); db.close();"
}

trap cleanup EXIT

cd "${REPOSITORY_DIRECTORY}"
docker version >/dev/null
docker buildx build \
    --platform linux/amd64 \
    --load \
    --tag "${IMAGE}" \
    .

missing_secret_log=$(mktemp)
trap 'rm -f "${missing_secret_log}"; cleanup' EXIT
if docker run --rm --platform linux/amd64 "${IMAGE}" >"${missing_secret_log}" 2>&1; then
    echo 'Production image started without required secrets.' >&2
    exit 1
fi
grep --quiet 'OPENROUTER_API_KEY is required' "${missing_secret_log}"
rm -f "${missing_secret_log}"

docker volume create "${VOLUME}" >/dev/null
run_container

[[ $(docker inspect --format '{{.Config.User}}' "${CONTAINER}") == '1000:1000' ]]
[[ $(docker inspect --format '{{.HostConfig.ReadonlyRootfs}}' "${CONTAINER}") == true ]]
[[ $(docker inspect --format '{{json .HostConfig.CapDrop}}' "${CONTAINER}") == '["ALL"]' ]]
[[ $(docker inspect --format '{{.HostConfig.PidsLimit}}' "${CONTAINER}") == 128 ]]
[[ $(docker inspect --format '{{.HostConfig.Memory}}' "${CONTAINER}") == 1073741824 ]]
[[ $(docker inspect --format '{{.HostConfig.NanoCpus}}' "${CONTAINER}") == 1000000000 ]]

published_address=$(docker port "${CONTAINER}" 8787/tcp)
[[ ${published_address} == 127.0.0.1:* ]]
published_port=${published_address##*:}
[[ ${published_port} =~ ^[0-9]+$ ]]

health=$(curl --fail --silent --show-error --max-time 5 "http://127.0.0.1:${published_port}/v1/health")
[[ ${health} == '{"ok":true}' ]]

read -r expected_yt_dlp_version expected_yt_dlp_sha < <(
    pnpm exec tsx -e \
        "import {YT_DLP_RELEASE_TAG,selectYtDlpReleaseAsset} from './scripts/lib/yt-dlp-release.ts'; console.log(YT_DLP_RELEASE_TAG, selectYtDlpReleaseAsset('linux','x64').sha256);"
)
[[ $(docker exec "${CONTAINER}" id -u) == 1000 ]]
[[ $(docker exec "${CONTAINER}" node --version) == v24.* ]]
[[ $(docker exec "${CONTAINER}" /opt/topskip/bin/yt-dlp --version) == "${expected_yt_dlp_version}" ]]
actual_yt_dlp_sha=$(docker exec "${CONTAINER}" sha256sum /opt/topskip/bin/yt-dlp | awk '{print $1}')
[[ ${actual_yt_dlp_sha} == "${expected_yt_dlp_sha}" ]]
[[ $(docker exec "${CONTAINER}" stat -c '%a %u:%g' /var/lib/topskip) == '700 1000:1000' ]]
[[ $(docker exec "${CONTAINER}" stat -c '%a %u:%g' /var/lib/topskip/topskip.sqlite) == '600 1000:1000' ]]
if docker exec "${CONTAINER}" touch /app/read-only-probe >/dev/null 2>&1; then
    echo 'The production root filesystem accepted a write.' >&2
    exit 1
fi

registration=$(curl \
    --fail \
    --silent \
    --show-error \
    --request POST \
    --header "Origin: ${ORIGIN}" \
    --header 'CF-Connecting-IP: 203.0.113.5' \
    --header 'X-TopSkip-Capabilities: processing-status,typed-server-errors-v1' \
    "http://127.0.0.1:${published_port}/v1/installations/register")
node -e '
    const response = JSON.parse(process.argv[1]);
    if (response.status !== "registered" || typeof response.token !== "string" || response.token.length < 32) {
        process.exit(1);
    }
' "${registration}"
[[ $(database_installation_count) == 1 ]]

docker rm --force "${CONTAINER}" >/dev/null
run_container
[[ $(database_installation_count) == 1 ]]

echo 'TopSkip production container smoke passed.'
