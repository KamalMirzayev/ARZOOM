# arzoomavto.az korporativ saytı: statik fayllar, ayrıca konteyner.
# Ön tərəfdəki Caddy (../Caddyfile) HTTPS-i və domeni idarə edir, bu konteyner yalnız daxili şəbəkədə :8080-də cavab verir.
FROM caddy:2-alpine
ENV XDG_DATA_HOME=/tmp/data XDG_CONFIG_HOME=/tmp/config
# Port 8080 needs no bind capability; dropping it lets the binary run with cap_drop: ALL.
RUN setcap -r /usr/bin/caddy
COPY Caddyfile /etc/caddy/Caddyfile
COPY public /srv
USER nobody
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -qO- http://127.0.0.1:8080/ >/dev/null || exit 1
