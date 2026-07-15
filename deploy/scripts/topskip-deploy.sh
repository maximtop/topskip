#!/usr/bin/env bash

set -euo pipefail
umask 077

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
    readonly DEPLOY_DIRECTORY=/opt/topskip
else
    readonly DEPLOY_DIRECTORY=${TOPSKIP_DEPLOY_DIRECTORY:-/opt/topskip}
fi
readonly COMPOSE_FILE=${DEPLOY_DIRECTORY}/compose.yml
readonly ENVIRONMENT_FILE=${DEPLOY_DIRECTORY}/production.env
readonly STATE_DIRECTORY=${DEPLOY_DIRECTORY}/state
readonly STATE_FILE=${STATE_DIRECTORY}/images
# `/run` is root-owned, unlike the commonly world-writable `/run/lock` directory.
readonly LOCK_FILE=/run/topskip-deploy.lock
readonly PROJECT_NAME=topskip
readonly SERVICE_NAME=backend
readonly CONTAINER_NAME=topskip-backend
readonly HEALTH_ATTEMPTS=18
readonly HEALTH_INTERVAL_SECONDS=5
readonly IMAGE_PATTERN='^ghcr\.io/maximtop/topskip-backend@sha256:[a-f0-9]{64}$'
readonly EXTENSION_ORIGINS_PATTERN='^chrome-extension://[a-p]{32}(,chrome-extension://[a-p]{32})*$'
readonly OPENROUTER_KEY_MINIMUM_LENGTH=20
readonly IP_HMAC_SECRET_MINIMUM_LENGTH=32

require_root() {
    if [[ ${EUID} -ne 0 ]]; then
        echo 'topskip-deploy must run as root.' >&2
        exit 77
    fi
}

require_assets() {
    local compose_mode
    local environment_mode

    if [[ -L ${COMPOSE_FILE} || -L ${ENVIRONMENT_FILE} ||
        ! -f ${COMPOSE_FILE} || ! -f ${ENVIRONMENT_FILE} ]]; then
        echo 'TopSkip compose.yml or production.env is missing.' >&2
        exit 78
    fi
    if [[ $(stat --format='%U:%G' "${COMPOSE_FILE}") != root:root ||
        $(stat --format='%U:%G' "${ENVIRONMENT_FILE}") != root:root ]]; then
        echo 'TopSkip deployment configuration must be owned by root:root.' >&2
        exit 77
    fi
    compose_mode=$(stat --format='%a' "${COMPOSE_FILE}")
    environment_mode=$(stat --format='%a' "${ENVIRONMENT_FILE}")
    if (((8#${compose_mode} & 8#022) != 0)); then
        echo 'TopSkip compose.yml must not be writable by group or other.' >&2
        exit 77
    fi
    if (((8#${environment_mode} & 8#077) != 0)); then
        echo 'TopSkip production.env must not be accessible by group or other.' >&2
        exit 77
    fi
    validate_environment_secrets "${ENVIRONMENT_FILE}"
    if [[ -L ${STATE_DIRECTORY} || (-e ${STATE_DIRECTORY} && ! -d ${STATE_DIRECTORY}) ||
        -L ${STATE_FILE} ]]; then
        echo 'TopSkip deployment state path is unsafe.' >&2
        exit 77
    fi
    install -d -o root -g root -m 0700 "${STATE_DIRECTORY}"
}

read_environment_value() {
    local environment_file=$1
    local wanted_key=$2
    local first_character
    local key
    local last_character
    local line
    local value=''

    while IFS= read -r line || [[ -n ${line} ]]; do
        line=${line%$'\r'}
        [[ ${line} == \#* || ${line} != *=* ]] && continue
        key=${line%%=*}
        if [[ ${key} == "${wanted_key}" ]]; then
            value=${line#*=}
            first_character=${value:0:1}
            last_character=${value: -1}
            if ((${#value} >= 2)) && [[ (${first_character} == '"' && ${last_character} == '"') ||
                (${first_character} == "'" && ${last_character} == "'") ]]; then
                value=${value:1:${#value}-2}
            fi
        fi
    done < "${environment_file}"
    printf '%s' "${value}"
}

validate_environment_secrets() {
    local extension_origins
    local environment_file=$1
    local ip_hmac_secret
    local openrouter_key

    openrouter_key=$(read_environment_value "${environment_file}" OPENROUTER_API_KEY)
    ip_hmac_secret=$(read_environment_value "${environment_file}" TOPSKIP_IP_HMAC_SECRET)
    extension_origins=$(read_environment_value "${environment_file}" TOPSKIP_ALLOWED_EXTENSION_ORIGINS)
    if ((${#openrouter_key} < OPENROUTER_KEY_MINIMUM_LENGTH)); then
        echo 'TopSkip production.env is missing a usable OpenRouter key.' >&2
        exit 78
    fi
    if ((${#ip_hmac_secret} < IP_HMAC_SECRET_MINIMUM_LENGTH)); then
        echo 'TopSkip production.env is missing a sufficiently long IP-HMAC secret.' >&2
        exit 78
    fi
    if [[ ! ${extension_origins} =~ ${EXTENSION_ORIGINS_PATTERN} ]]; then
        echo 'TopSkip production.env must contain exact allow-listed Chrome extension origins.' >&2
        exit 78
    fi
}

validate_image() {
    local image=${1:-}
    if [[ ! ${image} =~ ${IMAGE_PATTERN} ]]; then
        echo 'Expected an immutable TopSkip backend image digest.' >&2
        exit 64
    fi
}

compose() {
    local image=$1
    shift
    TOPSKIP_ENV_FILE=${ENVIRONMENT_FILE} TOPSKIP_IMAGE=${image} docker compose \
        --project-name "${PROJECT_NAME}" \
        --project-directory "${DEPLOY_DIRECTORY}" \
        --file "${COMPOSE_FILE}" \
        "$@"
}

read_state_field() {
    local wanted=$1
    local key
    local value

    if [[ ! -f ${STATE_FILE} ]]; then
        return 0
    fi
    while IFS='=' read -r key value; do
        if [[ ${key} == "${wanted}" && ${value} =~ ${IMAGE_PATTERN} ]]; then
            printf '%s\n' "${value}"
            return
        fi
    done < "${STATE_FILE}"
    return 0
}

inspect_current_image() {
    local image

    image=$(docker inspect --format '{{.Config.Image}}' "${CONTAINER_NAME}" 2>/dev/null || true)
    if [[ ${image} =~ ${IMAGE_PATTERN} ]]; then
        printf '%s\n' "${image}"
    fi
}

write_state() {
    local current=$1
    local previous=$2
    local temporary_file

    if [[ -n ${previous} ]]; then
        validate_image "${previous}"
    fi
    validate_image "${current}"
    temporary_file=$(mktemp "${STATE_DIRECTORY}/image-state.XXXXXX")
    printf 'current=%s\nprevious=%s\n' "${current}" "${previous}" > "${temporary_file}"
    mv -f "${temporary_file}" "${STATE_FILE}"
}

wait_for_health() {
    local attempt
    local health

    for ((attempt = 1; attempt <= HEALTH_ATTEMPTS; attempt += 1)); do
        health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "${CONTAINER_NAME}" 2>/dev/null || true)
        if [[ ${health} == healthy ]]; then
            return 0
        fi
        if [[ ${health} == unhealthy ]]; then
            return 1
        fi
        sleep "${HEALTH_INTERVAL_SECONDS}"
    done

    return 1
}

prepare_image() {
    local image=$1

    validate_image "${image}"
    compose "${image}" config --quiet || return 1
    if docker image inspect "${image}" >/dev/null 2>&1; then
        return 0
    fi
    compose "${image}" pull "${SERVICE_NAME}" || return 1
}

activate_image() {
    local image=$1

    validate_image "${image}"
    compose "${image}" config --quiet || return 1
    compose "${image}" up --detach --no-deps --pull never "${SERVICE_NAME}" || return 1
    wait_for_health
}

remove_failed_first_deployment() {
    local image=$1

    compose "${image}" rm --force --stop "${SERVICE_NAME}" >/dev/null 2>&1 || true
}

deploy_image() {
    local image=$1
    local actual
    local current
    local previous
    local restore_image
    local restore_previous
    local state_current
    local state_previous

    validate_image "${image}"
    actual=$(inspect_current_image)
    state_current=$(read_state_field current)
    state_previous=$(read_state_field previous)
    current=${actual:-${state_current}}
    previous=${current}
    restore_image=${current}
    restore_previous=${state_previous}
    if [[ -n ${actual} && -n ${state_current} && ${actual} != "${state_current}" ]]; then
        restore_previous=${state_current}
    fi
    if [[ ${current} == "${image}" ]]; then
        if wait_for_health; then
            previous=${state_previous}
            if [[ -n ${state_current} && ${state_current} != "${image}" ]]; then
                previous=${state_current}
            fi
            write_state "${image}" "${previous}"
            echo "TopSkip is already healthy on ${image}."
            return
        fi
        echo 'The current TopSkip container is not healthy; recreating it.' >&2
        previous=${state_previous}
        if [[ -n ${state_current} && ${state_current} != "${image}" ]]; then
            previous=${state_current}
        fi
        restore_image=${previous}
        restore_previous=${state_previous}
    fi

    echo "Preparing ${image}."
    if ! prepare_image "${image}"; then
        echo 'TopSkip image could not be pulled or validated; the current container was not changed.' >&2
        exit 69
    fi
    echo "Deploying ${image}."
    if activate_image "${image}"; then
        write_state "${image}" "${previous}"
        echo "TopSkip deployment is healthy on ${image}."
        return
    fi

    echo 'TopSkip deployment failed its loopback health check.' >&2
    if [[ -n ${restore_image} ]]; then
        echo "Restoring ${restore_image}." >&2
        activate_image "${restore_image}" || {
            echo 'Automatic restore also failed.' >&2
            exit 70
        }
        write_state "${restore_image}" "${restore_previous}"
    else
        remove_failed_first_deployment "${image}"
    fi
    exit 69
}

rollback_image() {
    local actual
    local current
    local previous
    local state_current
    local state_previous

    actual=$(inspect_current_image)
    state_current=$(read_state_field current)
    state_previous=$(read_state_field previous)
    current=${actual:-${state_current}}
    previous=${state_previous}
    if [[ -n ${actual} && -n ${state_current} && ${actual} != "${state_current}" ]]; then
        previous=${state_current}
    fi
    validate_image "${current}"
    validate_image "${previous}"
    if [[ ${current} == "${previous}" ]]; then
        echo 'Current and previous TopSkip images are identical.' >&2
        exit 69
    fi

    echo "Rolling back from ${current} to ${previous}."
    if ! prepare_image "${previous}"; then
        echo 'Rollback image is unavailable; the current container was not changed.' >&2
        exit 69
    fi
    if activate_image "${previous}"; then
        write_state "${previous}" "${current}"
        echo "TopSkip rollback is healthy on ${previous}."
        return
    fi

    echo "Rollback failed; restoring ${current}." >&2
    activate_image "${current}" || {
        echo 'Failed to restore the image that preceded rollback.' >&2
        exit 70
    }
    write_state "${current}" "${previous}"
    exit 69
}

show_status() {
    local actual
    local current
    local previous
    local state_current
    local state_previous

    actual=$(inspect_current_image)
    state_current=$(read_state_field current)
    state_previous=$(read_state_field previous)
    current=${actual:-${state_current}}
    previous=${state_previous}
    if [[ -n ${actual} && -n ${state_current} && ${actual} != "${state_current}" ]]; then
        previous=${state_current}
    fi
    printf 'current=%s\n' "${current:-none}"
    printf 'previous=%s\n' "${previous:-none}"
    if [[ -n ${current} ]]; then
        compose "${current}" ps "${SERVICE_NAME}"
    fi
}

main() {
    require_root
    require_assets
    exec 9>"${LOCK_FILE}"
    if ! flock --nonblock 9; then
        echo 'Another TopSkip deployment is already running.' >&2
        exit 75
    fi

    case ${1:-} in
        deploy)
            if [[ $# -ne 2 ]]; then
                echo 'Usage: topskip-deploy deploy <ghcr-image@sha256:digest>' >&2
                exit 64
            fi
            deploy_image "$2"
            ;;
        rollback)
            if [[ $# -ne 1 ]]; then
                echo 'Usage: topskip-deploy rollback' >&2
                exit 64
            fi
            rollback_image
            ;;
        status)
            if [[ $# -ne 1 ]]; then
                echo 'Usage: topskip-deploy status' >&2
                exit 64
            fi
            show_status
            ;;
        *)
            echo 'Usage: topskip-deploy <deploy|rollback|status>' >&2
            exit 64
            ;;
    esac
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
    main "$@"
fi
