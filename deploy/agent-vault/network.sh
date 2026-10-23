#!/bin/sh
set -eu
# This container owns the application's network namespace. The app never receives NET_ADMIN.
# Match the original destination before Docker's embedded DNS DNAT; permitting all loopback
# would otherwise allow DNS exfiltration through 127.0.0.11.
iptables -t raw -A OUTPUT -m owner --uid-owner 1000 -d 172.30.82.2 -p tcp --dport 14322 -j ACCEPT
iptables -t raw -A OUTPUT -m owner --uid-owner 1000 -d 127.0.0.1 -p tcp -j ACCEPT
iptables -t raw -A OUTPUT -m owner --uid-owner 1000 -j DROP
ip6tables -t raw -A OUTPUT -m owner --uid-owner 1000 -d ::1 -p tcp -j ACCEPT
ip6tables -t raw -A OUTPUT -m owner --uid-owner 1000 -j DROP
# No external ingress is needed for Telegram long polling. Complete OAuth in the trusted
# operator environment while the bot is stopped, then transfer its state with restrictive permissions.
iptables -A INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
iptables -A INPUT -i lo -j ACCEPT
iptables -A INPUT -j DROP
ip6tables -A INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
ip6tables -A INPUT -i lo -j ACCEPT
ip6tables -A INPUT -j DROP
touch /tmp/ready
exec sleep infinity
