#!/usr/bin/env bash
# 到开发机的反向隧道（ssh -N -R），由 launchd 保活
set -euo pipefail
RT="${1:-dev}"
exec /usr/bin/ssh -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
  -R 7801:127.0.0.1:7801 "${FOREMAN_TUNNEL_SSH:-jiangkai@10.26.20.3}"
