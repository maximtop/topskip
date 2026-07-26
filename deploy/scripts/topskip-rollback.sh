#!/usr/bin/env bash

set -euo pipefail

exec sudo -n /usr/local/sbin/topskip-deploy rollback
