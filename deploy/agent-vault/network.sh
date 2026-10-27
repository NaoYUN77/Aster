#!/bin/sh
set -eu
# The app and optional router share this namespace, with distinct unprivileged UIDs.
# Exact loopback matching excludes Docker's DNS proxy (127.0.0.11) before DNAT.
#
# Broker address and port come from the validated environment description and are passed as
# container environment variables. Anything interpolated into iptables is checked first: a shell
# variable cannot introduce extra rules, addresses or ports.
broker=${ASTER_BROKER_ADDRESS:-172.30.82.2}
port=${ASTER_BROKER_PORT:-14322}
case $broker in
  ''|*[!0-9.]*) printf '%s\n' 'ASTER_BROKER_ADDRESS must be a dotted IPv4 address' >&2; exit 1 ;;
esac
[ "$(printf '%s' "$broker" | tr -cd '.' | wc -c)" = 3 ] || {
  printf '%s\n' 'ASTER_BROKER_ADDRESS must be a dotted IPv4 address' >&2; exit 1; }
case $port in
  ''|*[!0-9]*) printf '%s\n' 'ASTER_BROKER_PORT must be a TCP port' >&2; exit 1 ;;
esac
[ ${#port} -le 5 ] && [ "$port" -ge 1 ] && [ "$port" -le 65535 ] || {
  printf '%s\n' 'ASTER_BROKER_PORT must be a TCP port' >&2; exit 1; }

case "${ROUTER_ENABLED:-0}" in
  0) iptables -t raw -A OUTPUT -m owner --uid-owner 1000 -d "$broker" -p tcp --dport "$port" -j ACCEPT ;;
  1)
    iptables -t raw -A OUTPUT -m owner --uid-owner 1001 -d "$broker" -p tcp --dport "$port" -j ACCEPT
    iptables -t raw -A OUTPUT -m owner --uid-owner 1001 -d 127.0.0.1 -p tcp -j ACCEPT
    iptables -t raw -A OUTPUT -m owner --uid-owner 1001 -j DROP
    ip6tables -t raw -A OUTPUT -m owner --uid-owner 1001 -d ::1 -p tcp -j ACCEPT
    ip6tables -t raw -A OUTPUT -m owner --uid-owner 1001 -j DROP
    ;;
  *) printf '%s\n' 'ROUTER_ENABLED must be 0 or 1' >&2; exit 1 ;;
esac
iptables -t raw -A OUTPUT -m owner --uid-owner 1000 -d 127.0.0.1 -p tcp -j ACCEPT
iptables -t raw -A OUTPUT -m owner --uid-owner 1000 -j DROP
ip6tables -t raw -A OUTPUT -m owner --uid-owner 1000 -d ::1 -p tcp -j ACCEPT
ip6tables -t raw -A OUTPUT -m owner --uid-owner 1000 -j DROP
# OAuth authorization happens in the trusted operator environment while Aster is stopped.
iptables -A INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
iptables -A INPUT -i lo -j ACCEPT
iptables -A INPUT -j DROP
ip6tables -A INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
ip6tables -A INPUT -i lo -j ACCEPT
# Neighbor discovery is required even for trusted outbound IPv6 connections.
# Only on-link solicitations/advertisements (code 0, hop limit 255) may enter.
ip6tables -A INPUT -p ipv6-icmp --icmpv6-type 135/0 -m hl --hl-eq 255 -j ACCEPT
ip6tables -A INPUT -p ipv6-icmp --icmpv6-type 136/0 -m hl --hl-eq 255 -j ACCEPT
ip6tables -A INPUT -j DROP
touch /tmp/ready
exec sleep infinity
