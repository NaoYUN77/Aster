#!/bin/sh
set -eu
# The app and optional router share this namespace, with distinct unprivileged UIDs.
# Exact loopback matching excludes Docker's DNS proxy (127.0.0.11) before DNAT.
case "${ROUTER_ENABLED:-0}" in
  0) iptables -t raw -A OUTPUT -m owner --uid-owner 1000 -d 172.30.82.2 -p tcp --dport 14322 -j ACCEPT ;;
  1)
    iptables -t raw -A OUTPUT -m owner --uid-owner 1001 -d 172.30.82.2 -p tcp --dport 14322 -j ACCEPT
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
ip6tables -A INPUT -j DROP
touch /tmp/ready
exec sleep infinity
