#!/usr/bin/env bash

set -euo pipefail

readonly DEPLOY_USER=topskip-deploy
readonly DEPLOY_HOME=/home/topskip-deploy
readonly DEPLOY_DIRECTORY=/opt/topskip
readonly STATE_DIRECTORY=${DEPLOY_DIRECTORY}/state
readonly AUTHORIZED_KEYS_FILE=${DEPLOY_HOME}/.ssh/authorized_keys
readonly AUTHORIZED_KEY_PREFIX='command="/usr/local/libexec/topskip-deploy-gateway",no-agent-forwarding,no-port-forwarding,no-X11-forwarding,no-pty,no-user-rc '
readonly FORBIDDEN_GROUPS=(root docker sudo wheel lxd incus podman libvirt)

fail_unsafe_path() {
    local path=$1

    echo "Refusing an unsafe TopSkip deployment path: ${path}" >&2
    exit 73
}

require_safe_directory() {
    local mode
    local path=$1

    if [[ -L ${path} || (-e ${path} && ! -d ${path}) ]]; then
        fail_unsafe_path "${path}"
    fi
    [[ -d ${path} ]] || return 0
    mode=$(stat --format='%a' "${path}")
    if [[ $(stat --format='%U:%G' "${path}") != root:root ]] ||
        (((8#${mode} & 8#022) != 0)); then
        fail_unsafe_path "${path}"
    fi
}

require_safe_file_target() {
    local mode
    local path=$1

    if [[ -L ${path} || (-e ${path} && ! -f ${path}) ]]; then
        fail_unsafe_path "${path}"
    fi
    [[ -f ${path} ]] || return 0
    mode=$(stat --format='%a' "${path}")
    if [[ $(stat --format='%U:%G' "${path}") != root:root ]] ||
        (((8#${mode} & 8#022) != 0)); then
        fail_unsafe_path "${path}"
    fi
}

require_safe_source_file() {
    local path=$1

    if [[ -L ${path} || ! -f ${path} ]]; then
        echo "Required deployment source is missing or unsafe: ${path}" >&2
        exit 66
    fi
}

validate_deploy_account() {
    local account
    local group
    local groups
    local home
    local shell
    local uid

    account=$(getent passwd "${DEPLOY_USER}")
    IFS=: read -r _ _ uid _ _ home shell <<< "${account}"
    if [[ -z ${uid} || ${uid} == 0 || ${home} != "${DEPLOY_HOME}" || ${shell} != /bin/bash ]]; then
        echo 'The TopSkip deployment account has an unexpected UID, home, or shell.' >&2
        exit 77
    fi
    groups=$(id -nG "${DEPLOY_USER}" | tr ' ' '\n')
    for group in "${FORBIDDEN_GROUPS[@]}"; do
        if grep -Fxq "${group}" <<< "${groups}"; then
            echo "Refusing privileged group membership for ${DEPLOY_USER}: ${group}" >&2
            exit 77
        fi
    done
}

validate_authorized_keys() {
    local authorized_keys_file=$1
    local key
    local key_and_comment
    local line

    [[ -f ${authorized_keys_file} ]] || return 0
    while IFS= read -r line || [[ -n ${line} ]]; do
        line=${line%$'\r'}
        [[ -z ${line} || ${line} == \#* ]] && continue
        if [[ ${line} != "${AUTHORIZED_KEY_PREFIX}"ssh-ed25519\ * ]]; then
            echo 'The TopSkip deployment account has an unrestricted or unsupported SSH key.' >&2
            exit 77
        fi
        key_and_comment=${line#"${AUTHORIZED_KEY_PREFIX}"ssh-ed25519 }
        key=${key_and_comment%% *}
        if [[ ! ${key} =~ ^[A-Za-z0-9+/]+={0,2}$ ]]; then
            echo 'The TopSkip deployment account has a malformed SSH public key.' >&2
            exit 77
        fi
    done < "${authorized_keys_file}"
}

require_safe_paths() {
    require_safe_directory /opt
    require_safe_directory "${DEPLOY_DIRECTORY}"
    require_safe_directory "${STATE_DIRECTORY}"
    require_safe_directory /usr/local
    require_safe_directory /usr/local/libexec
    require_safe_directory /usr/local/sbin
    require_safe_directory /etc/sudoers.d
    require_safe_directory "${DEPLOY_HOME}"
    require_safe_directory "${DEPLOY_HOME}/.ssh"

    require_safe_file_target "${DEPLOY_DIRECTORY}/compose.yml"
    require_safe_file_target "${DEPLOY_DIRECTORY}/production.env"
    require_safe_file_target "${STATE_DIRECTORY}/images"
    require_safe_file_target /usr/local/sbin/topskip-deploy
    require_safe_file_target /usr/local/libexec/topskip-deploy-gateway
    require_safe_file_target /usr/local/sbin/topskip-rollback
    require_safe_file_target /etc/sudoers.d/topskip-deploy
    require_safe_file_target "${AUTHORIZED_KEYS_FILE}"
}

require_source_assets() {
    local source_directory=$1

    require_safe_source_file "${source_directory}/compose.production.yml"
    require_safe_source_file "${source_directory}/scripts/topskip-deploy.sh"
    require_safe_source_file "${source_directory}/scripts/topskip-deploy-gateway.sh"
    require_safe_source_file "${source_directory}/scripts/topskip-rollback.sh"
    require_safe_source_file "${source_directory}/sudoers/topskip-deploy"
}

install_root_owned_directories() {
    install -d -o root -g root -m 0755 -- "${DEPLOY_DIRECTORY}"
    install -d -o root -g root -m 0700 -- "${STATE_DIRECTORY}"
    install -d -o root -g root -m 0755 -- /usr/local/libexec
    install -d -o root -g root -m 0755 -- "${DEPLOY_HOME}"
    install -d -o root -g root -m 0755 -- "${DEPLOY_HOME}/.ssh"
}

main() {
    local source_directory=${1:-}

    if [[ ${EUID} -ne 0 || -z ${source_directory} ]]; then
        echo 'Usage: sudo install-vps-assets.sh <repository-deploy-directory>' >&2
        exit 64
    fi
    for command in chmod chown docker flock getent grep id install passwd stat tr useradd visudo; do
        if ! command -v "${command}" >/dev/null 2>&1; then
            echo "Required command is unavailable: ${command}" >&2
            exit 69
        fi
    done

    require_source_assets "${source_directory}"
    require_safe_paths
    if ! id "${DEPLOY_USER}" >/dev/null 2>&1; then
        useradd --no-create-home --user-group --home-dir "${DEPLOY_HOME}" --shell /bin/bash "${DEPLOY_USER}"
    fi
    validate_deploy_account
    passwd --lock "${DEPLOY_USER}" >/dev/null
    require_safe_paths
    docker compose version >/dev/null

    install_root_owned_directories
    validate_authorized_keys "${AUTHORIZED_KEYS_FILE}"
    if [[ -f ${AUTHORIZED_KEYS_FILE} ]]; then
        chown root:root "${AUTHORIZED_KEYS_FILE}"
        chmod 0644 "${AUTHORIZED_KEYS_FILE}"
    fi

    visudo --check --file="${source_directory}/sudoers/topskip-deploy"
    install -o root -g root -m 0644 -- "${source_directory}/compose.production.yml" "${DEPLOY_DIRECTORY}/compose.yml"
    install -o root -g root -m 0755 -- "${source_directory}/scripts/topskip-deploy.sh" /usr/local/sbin/topskip-deploy
    install -o root -g root -m 0755 -- "${source_directory}/scripts/topskip-deploy-gateway.sh" /usr/local/libexec/topskip-deploy-gateway
    install -o root -g root -m 0755 -- "${source_directory}/scripts/topskip-rollback.sh" /usr/local/sbin/topskip-rollback
    install -o root -g root -m 0440 -- "${source_directory}/sudoers/topskip-deploy" /etc/sudoers.d/topskip-deploy
    visudo --check --file=/etc/sudoers.d/topskip-deploy

    echo 'Installed TopSkip deployment assets. Add production.env and the restricted authorized key next.'
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
    main "$@"
fi
