"""Placeholder substitution policy for the Aster MITM addon.

Kept free of mitmproxy imports so the policy can be unit-tested without the proxy or OpenBao.
A placeholder is __vault_<NAME>__ and may be replaced only when the request host is listed for
that NAME in the allowlist. Host matching is exact: a suffix match would let a look-alike host
receive a credential.
"""

import re
from collections.abc import Callable, Mapping

PLACEHOLDER = re.compile(r"__vault_([A-Z][A-Z0-9_]*?)__")


class PlaceholderError(Exception):
    """A placeholder may not be sent to this host. Messages never contain a secret value."""


def placeholder_names(text: str) -> list[str]:
    return PLACEHOLDER.findall(text)


def substitute(
    text: str,
    host: str,
    allowlist: Mapping[str, list[str]],
    resolve: Callable[[str], str],
) -> str:
    """Replace every placeholder in text for host, or raise PlaceholderError without replacing any."""
    host = host.lower()

    def replace(match: re.Match[str]) -> str:
        name = match.group(1)
        if host not in allowlist.get(name, ()):
            raise PlaceholderError(f"placeholder {name} is not permitted for host {host}")
        try:
            return resolve(name)
        except Exception:
            # The resolver's exception text may carry transport detail; keep only the name.
            raise PlaceholderError(f"placeholder {name} could not be resolved") from None

    return PLACEHOLDER.sub(replace, text)
