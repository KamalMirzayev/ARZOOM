#!/usr/bin/env bash
# AKB HUB is reached over the server's VPN (IPsec), which carries only the host's own traffic, not Docker containers'.
# Two small TCP relays on the host pass the app's AKB connections through: the app connects to the host on the Docker
# bridge address, the relay opens the connection to AKB from the host itself. TLS stays end to end between the app and
# AKB (client certificate, hostname check); the relay only copies bytes. The relays listen only on the Docker bridge,
# not on the public interface. Safe to run again.
set -euo pipefail
command -v systemctl >/dev/null 2>&1 || { echo "systemd yoxdur, AKB relay ötürüldü."; exit 0; }
command -v socat >/dev/null 2>&1 || { apt-get update -qq && apt-get install -y -qq socat >/dev/null; }
GW=$(ip -4 addr show docker0 2>/dev/null | grep -oP 'inet \K[\d.]+' | head -1)
[ -n "$GW" ] || { echo "docker0 tapılmadı, AKB relay ötürüldü."; exit 0; }
for pair in "staging:18443:staging-hub.acb.az" "prod:18444:hub.acb.az"; do
  IFS=: read -r name port host <<<"$pair"
  cat > /etc/systemd/system/arzoom-akb-$name.service <<UNIT
[Unit]
Description=ARZOOM AKB relay ($host)
After=network-online.target docker.service
Wants=network-online.target

[Service]
ExecStart=/usr/bin/socat TCP-LISTEN:$port,bind=$GW,reuseaddr,fork TCP:$host:443,connect-timeout=20
Restart=always
RestartSec=3
DynamicUser=yes

[Install]
WantedBy=multi-user.target
UNIT
done
systemctl daemon-reload
systemctl enable -q arzoom-akb-staging arzoom-akb-prod
systemctl restart arzoom-akb-staging arzoom-akb-prod
# Containers come in from Docker networks (172.16.0.0/12); nothing else may reach the relay ports.
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  ufw allow from 172.16.0.0/12 to "$GW" port 18443:18444 proto tcp >/dev/null
fi
echo "AKB relay: $GW:18443 → staging-hub.acb.az, $GW:18444 → hub.acb.az"
