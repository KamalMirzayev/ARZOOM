#!/usr/bin/env bash
# Serverin əsas təhlükəsizlik ayarları. Təkrar işə salmaq təhlükəsizdir.
#  - firewall (ufw): yalnız SSH, 80 və 443 açıqdır
#  - fail2ban: SSH-a parol təxmini cəhdlərini bloklayır
#  - avtomatik təhlükəsizlik yeniləmələri
# SSH parolla girişi BAĞLAMIR: bunu SSH açarı qurulandan sonra özün et (README).
set -euo pipefail
command -v apt-get >/dev/null 2>&1 || { echo "apt-get yoxdur, harden.sh ötürüldü."; exit 0; }
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ufw fail2ban unattended-upgrades >/dev/null

# Serverin hazırda dinlədiyi SSH portlarını açıq saxla ki, bağlantı kəsilməsin.
SSH_PORTS=$(sshd -T 2>/dev/null | awk '/^port /{print $2}' || true)
[ -n "$SSH_PORTS" ] || SSH_PORTS=22
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
for p in $SSH_PORTS; do ufw allow "$p/tcp" >/dev/null; done
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw allow 443/udp >/dev/null
ufw --force enable >/dev/null

cat > /etc/fail2ban/jail.d/arzoom.local <<JAIL
[sshd]
enabled = true
port = $(echo $SSH_PORTS | tr ' ' ',')
maxretry = 5
findtime = 10m
bantime = 1h
JAIL
systemctl enable --now fail2ban >/dev/null 2>&1 || true
systemctl restart fail2ban >/dev/null 2>&1 || true

echo 'APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";' > /etc/apt/apt.conf.d/20auto-upgrades

echo "Təhlükəsizlik: ufw (SSH $SSH_PORTS, 80, 443), fail2ban, avtomatik yeniləmələr aktivdir."
