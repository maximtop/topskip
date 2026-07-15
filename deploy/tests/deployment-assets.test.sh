#!/usr/bin/env bash

set -euo pipefail

readonly DEPLOY_DIRECTORY=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
readonly REPOSITORY_DIRECTORY=$(cd "${DEPLOY_DIRECTORY}/.." && pwd)
readonly VALID_IMAGE=ghcr.io/maximtop/topskip-backend@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
readonly PREVIOUS_IMAGE=ghcr.io/maximtop/topskip-backend@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
readonly CANDIDATE_IMAGE=ghcr.io/maximtop/topskip-backend@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc
readonly UNRECORDED_IMAGE=ghcr.io/maximtop/topskip-backend@sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd

for script in "${DEPLOY_DIRECTORY}"/scripts/*.sh; do
    [[ -x ${script} ]]
    bash -n "${script}"
done

if grep -Fq 'LOCK_FILE=/run/lock/' "${DEPLOY_DIRECTORY}/scripts/topskip-deploy.sh"; then
    echo 'The root deploy lock must not live in a world-writable directory.' >&2
    exit 1
fi

temporary_directory=$(mktemp -d)
trap 'rm -rf "${temporary_directory}"' EXIT

cat > "${temporary_directory}/sudo" <<'SCRIPT'
#!/usr/bin/env bash
printf '%s\n' "$*"
SCRIPT
chmod 0755 "${temporary_directory}/sudo"

gateway_output=$(PATH="${temporary_directory}:${PATH}" SSH_ORIGINAL_COMMAND="deploy ${VALID_IMAGE}" "${DEPLOY_DIRECTORY}/scripts/topskip-deploy-gateway.sh")
expected_output="-n /usr/local/sbin/topskip-deploy deploy ${VALID_IMAGE}"
[[ ${gateway_output} == "${expected_output}" ]]

gateway_output=$(PATH="${temporary_directory}:${PATH}" SSH_ORIGINAL_COMMAND=status "${DEPLOY_DIRECTORY}/scripts/topskip-deploy-gateway.sh")
[[ ${gateway_output} == '-n /usr/local/sbin/topskip-deploy status' ]]
gateway_output=$(PATH="${temporary_directory}:${PATH}" SSH_ORIGINAL_COMMAND=rollback "${DEPLOY_DIRECTORY}/scripts/topskip-deploy-gateway.sh")
[[ ${gateway_output} == '-n /usr/local/sbin/topskip-deploy rollback' ]]

PATH="${temporary_directory}:${PATH}" SSH_ORIGINAL_COMMAND='deploy ghcr.io/maximtop/topskip-backend:latest' "${DEPLOY_DIRECTORY}/scripts/topskip-deploy-gateway.sh" >/dev/null 2>&1 && exit 1
PATH="${temporary_directory}:${PATH}" SSH_ORIGINAL_COMMAND='deploy ghcr.io/unrelated/attacker-image@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' "${DEPLOY_DIRECTORY}/scripts/topskip-deploy-gateway.sh" >/dev/null 2>&1 && exit 1
PATH="${temporary_directory}:${PATH}" SSH_ORIGINAL_COMMAND='status extra' "${DEPLOY_DIRECTORY}/scripts/topskip-deploy-gateway.sh" >/dev/null 2>&1 && exit 1

if TOPSKIP_DEPLOY_DIRECTORY=${temporary_directory} bash -c '
    source "$1"
    validate_image "ghcr.io/unrelated/attacker-image@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
' bash "${DEPLOY_DIRECTORY}/scripts/topskip-deploy.sh" >/dev/null 2>&1; then
    echo 'The root deployment command accepted an image from another repository.' >&2
    exit 1
fi

if TOPSKIP_DEPLOY_DIRECTORY=${temporary_directory} bash -c '
    source "$1"
    validate_environment_secrets "$2"
' bash "${DEPLOY_DIRECTORY}/scripts/topskip-deploy.sh" "${DEPLOY_DIRECTORY}/production.env.example" >/dev/null 2>&1; then
    echo 'The empty production environment example passed secret validation.' >&2
    exit 1
fi
valid_environment=${temporary_directory}/valid-production.env
printf 'OPENROUTER_API_KEY=sk-or-v1-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nTOPSKIP_IP_HMAC_SECRET=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\nTOPSKIP_ALLOWED_EXTENSION_ORIGINS=chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n' > "${valid_environment}"
TOPSKIP_DEPLOY_DIRECTORY=${temporary_directory} bash -c '
    source "$1"
    validate_environment_secrets "$2"
' bash "${DEPLOY_DIRECTORY}/scripts/topskip-deploy.sh" "${valid_environment}"
missing_origin_environment=${temporary_directory}/missing-origin-production.env
printf 'OPENROUTER_API_KEY=sk-or-v1-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nTOPSKIP_IP_HMAC_SECRET=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\nTOPSKIP_ALLOWED_EXTENSION_ORIGINS=\n' > "${missing_origin_environment}"
if TOPSKIP_DEPLOY_DIRECTORY=${temporary_directory} bash -c '
    source "$1"
    validate_environment_secrets "$2"
' bash "${DEPLOY_DIRECTORY}/scripts/topskip-deploy.sh" "${missing_origin_environment}" >/dev/null 2>&1; then
    echo 'A production environment without an extension origin passed validation.' >&2
    exit 1
fi
printf 'OPENROUTER_API_KEY=sk-or-v1-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nTOPSKIP_IP_HMAC_SECRET=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\nTOPSKIP_ALLOWED_EXTENSION_ORIGINS=chrome-extension://*\n' > "${missing_origin_environment}"
if TOPSKIP_DEPLOY_DIRECTORY=${temporary_directory} bash -c '
    source "$1"
    validate_environment_secrets "$2"
' bash "${DEPLOY_DIRECTORY}/scripts/topskip-deploy.sh" "${missing_origin_environment}" >/dev/null 2>&1; then
    echo 'A wildcard extension origin passed production validation.' >&2
    exit 1
fi

safe_authorized_keys=${temporary_directory}/safe-authorized-keys
printf '%sssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMockTopSkipDeployKey topskip-actions\n' \
    'command="/usr/local/libexec/topskip-deploy-gateway",no-agent-forwarding,no-port-forwarding,no-X11-forwarding,no-pty,no-user-rc ' \
    > "${safe_authorized_keys}"
bash -c '
    source "$1"
    validate_authorized_keys "$2"
' bash "${DEPLOY_DIRECTORY}/scripts/install-vps-assets.sh" "${safe_authorized_keys}"
printf 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMockUnrestrictedKey topskip-actions\n' > "${safe_authorized_keys}"
if bash -c '
    source "$1"
    validate_authorized_keys "$2"
' bash "${DEPLOY_DIRECTORY}/scripts/install-vps-assets.sh" "${safe_authorized_keys}" >/dev/null 2>&1; then
    echo 'Provisioning accepted an unrestricted SSH key.' >&2
    exit 1
fi

unsafe_path=${temporary_directory}/unsafe-directory
ln -s /tmp "${unsafe_path}"
if bash -c '
    source "$1"
    require_safe_directory "$2"
' bash "${DEPLOY_DIRECTORY}/scripts/install-vps-assets.sh" "${unsafe_path}" >/dev/null 2>&1; then
    echo 'Provisioning accepted a symlinked deployment directory.' >&2
    exit 1
fi

directory_install_log=${temporary_directory}/directory-install.log
MOCK_INSTALL_LOG=${directory_install_log} bash -c '
    source "$1"
    install() { printf "%s\\n" "$*" >> "${MOCK_INSTALL_LOG}"; }
    install_root_owned_directories
' bash "${DEPLOY_DIRECTORY}/scripts/install-vps-assets.sh"
grep -Fxq -- '-d -o root -g root -m 0755 -- /home/topskip-deploy' "${directory_install_log}"
grep -Fxq -- '-d -o root -g root -m 0755 -- /home/topskip-deploy/.ssh' "${directory_install_log}"
home_line=$(grep -Fn -- '/home/topskip-deploy' "${directory_install_log}" | sed -n '1s/:.*//p')
ssh_line=$(grep -Fn -- '/home/topskip-deploy/.ssh' "${directory_install_log}" | sed -n '1s/:.*//p')
[[ ${home_line} -lt ${ssh_line} ]]

if bash -c '
    source "$1"
    getent() { printf "topskip-deploy:x:1001:1001::/home/topskip-deploy:/bin/bash\\n"; }
    id() { printf "topskip-deploy docker\\n"; }
    validate_deploy_account
' bash "${DEPLOY_DIRECTORY}/scripts/install-vps-assets.sh" >/dev/null 2>&1; then
    echo 'Provisioning accepted Docker group membership.' >&2
    exit 1
fi

state_directory=${temporary_directory}/state-test
mkdir -p "${state_directory}/state"
TOPSKIP_DEPLOY_DIRECTORY=${state_directory} bash -c '
    set -euo pipefail
    source "$1"
    first="ghcr.io/maximtop/topskip-backend@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    second="ghcr.io/maximtop/topskip-backend@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    write_state "${first}" "${second}"
    [[ $(read_state_field current) == "${first}" ]]
    [[ $(read_state_field previous) == "${second}" ]]
    [[ $(find "${TOPSKIP_DEPLOY_DIRECTORY}/state" -maxdepth 1 -type f | wc -l | tr -d " ") == 1 ]]
' bash "${DEPLOY_DIRECTORY}/scripts/topskip-deploy.sh"

rollback_state_directory=${temporary_directory}/rollback-state-test
mkdir -p "${rollback_state_directory}/state"
set +e
TOPSKIP_DEPLOY_DIRECTORY=${rollback_state_directory} bash -c '
    source "$1"
    MOCK_CURRENT=$2
    MOCK_PREVIOUS=$3
    MOCK_CANDIDATE=$4
    write_state "${MOCK_CURRENT}" "${MOCK_PREVIOUS}"
    inspect_current_image() { printf "%s\\n" "${MOCK_CURRENT}"; }
    prepare_image() { return 0; }
    activate_image() {
        printf "%s\\n" "$1" >> "${TOPSKIP_DEPLOY_DIRECTORY}/activations"
        [[ $1 == "${MOCK_CURRENT}" ]]
    }
    deploy_image "${MOCK_CANDIDATE}"
' bash "${DEPLOY_DIRECTORY}/scripts/topskip-deploy.sh" "${VALID_IMAGE}" "${PREVIOUS_IMAGE}" "${CANDIDATE_IMAGE}" >/dev/null 2>&1
deployment_status=$?
set -e
[[ ${deployment_status} -eq 69 ]]
TOPSKIP_DEPLOY_DIRECTORY=${rollback_state_directory} bash -c '
    source "$1"
    [[ $(read_state_field current) == "$2" ]]
    [[ $(read_state_field previous) == "$3" ]]
' bash "${DEPLOY_DIRECTORY}/scripts/topskip-deploy.sh" "${VALID_IMAGE}" "${PREVIOUS_IMAGE}"
[[ $(sed -n '1p' "${rollback_state_directory}/activations") == "${CANDIDATE_IMAGE}" ]]
[[ $(sed -n '2p' "${rollback_state_directory}/activations") == "${VALID_IMAGE}" ]]

crash_state_directory=${temporary_directory}/crash-state-test
mkdir -p "${crash_state_directory}/state"
set +e
TOPSKIP_DEPLOY_DIRECTORY=${crash_state_directory} bash -c '
    source "$1"
    MOCK_RECORDED=$2
    MOCK_RECORDED_PREVIOUS=$3
    MOCK_ACTUAL=$4
    MOCK_CANDIDATE=$5
    write_state "${MOCK_RECORDED}" "${MOCK_RECORDED_PREVIOUS}"
    inspect_current_image() { printf "%s\\n" "${MOCK_ACTUAL}"; }
    prepare_image() { return 0; }
    activate_image() { [[ $1 == "${MOCK_ACTUAL}" ]]; }
    deploy_image "${MOCK_CANDIDATE}"
' bash "${DEPLOY_DIRECTORY}/scripts/topskip-deploy.sh" "${VALID_IMAGE}" "${PREVIOUS_IMAGE}" "${UNRECORDED_IMAGE}" "${CANDIDATE_IMAGE}" >/dev/null 2>&1
deployment_status=$?
set -e
[[ ${deployment_status} -eq 69 ]]
TOPSKIP_DEPLOY_DIRECTORY=${crash_state_directory} bash -c '
    source "$1"
    [[ $(read_state_field current) == "$2" ]]
    [[ $(read_state_field previous) == "$3" ]]
' bash "${DEPLOY_DIRECTORY}/scripts/topskip-deploy.sh" "${UNRECORDED_IMAGE}" "${VALID_IMAGE}"

TOPSKIP_ENV_FILE=${DEPLOY_DIRECTORY}/production.env.example \
TOPSKIP_IMAGE=${VALID_IMAGE} docker compose \
    --project-directory "${DEPLOY_DIRECTORY}" \
    --file "${DEPLOY_DIRECTORY}/compose.production.yml" \
    config --quiet
TOPSKIP_ENV_FILE=${DEPLOY_DIRECTORY}/production.env.example \
TOPSKIP_IMAGE=${VALID_IMAGE} docker compose \
    --project-directory "${DEPLOY_DIRECTORY}" \
    --file "${DEPLOY_DIRECTORY}/compose.production.yml" \
    config --format json | node -e '
        let source = "";
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", (chunk) => { source += chunk; });
        process.stdin.on("end", () => {
            const backend = JSON.parse(source).services.backend;
            const port = backend.ports[0];
            const volume = backend.volumes[0];
            if (backend.user !== "1000:1000" || backend.read_only !== true ||
                backend.pids_limit !== 128 || backend.mem_limit !== "1073741824" ||
                backend.cpus !== 1 || backend.cap_drop[0] !== "ALL" ||
                !backend.security_opt.includes("no-new-privileges:true") ||
                backend.ports.length !== 1 || port.host_ip !== "127.0.0.1" ||
                port.published !== "18787" || port.target !== 8787 ||
                backend.volumes.length !== 1 || volume.type !== "volume" ||
                volume.target !== "/var/lib/topskip" || backend.privileged === true ||
                !backend.tmpfs[0].includes("nosuid,nodev") ||
                !backend.tmpfs[0].includes("size=256m")) {
                throw new Error("Production Compose hardening changed unexpectedly.");
            }
        });
    '

pnpm exec rspack build --config "${DEPLOY_DIRECTORY}/rspack.config.ts"
test -s "${REPOSITORY_DIRECTORY}/deployment-dist/server.mjs"

echo 'TopSkip deployment assets are valid.'
