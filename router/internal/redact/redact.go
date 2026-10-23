// Package redact removes credential-shaped values from free-form text. The
// router never logs request headers or bodies, so this is a defense-in-depth
// filter for error messages, debug output and the `redact` subcommand.
package redact

import "regexp"

var patterns = []struct {
	re   *regexp.Regexp
	repl string
}{
	// Header values, including the full line so a malformed value cannot leak.
	{regexp.MustCompile(`(?im)^[ \t]*(proxy-authorization|authorization|x-api-key|api-key|cookie|set-cookie)[ \t]*:[^\r\n]*`), `$1: [REDACTED]`},
	// Agent Vault and model-provider credentials.
	{regexp.MustCompile(`\bav_agt_[A-Za-z0-9_-]{8,}`), `av_agt_[REDACTED]`},
	{regexp.MustCompile(`\bsk-[A-Za-z0-9_-]{8,}`), `sk-[REDACTED]`},
	// Telegram bot tokens have a numeric bot ID, a colon, and a long secret.
	{regexp.MustCompile(`[0-9]{6,}:[A-Za-z0-9_-]{30,}`), `[REDACTED_TELEGRAM_TOKEN]`},
	// JWTs.
	{regexp.MustCompile(`\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b`), `[REDACTED_JWT]`},
	// URL userinfo.
	{regexp.MustCompile(`(?i)\b(https?://)[^/\s:@]+:[^/\s@]+@`), `$1[REDACTED]@`},
	// Common secret-bearing query parameters.
	{regexp.MustCompile(`(?i)([?&](?:token|key|secret|password|signature|sig|access_token)=)[^&\s]+`), `$1[REDACTED]`},
	// Authorization schemes.
	{regexp.MustCompile(`(?i)\b(bearer|basic)[ \t]+[A-Za-z0-9._~+/=-]{8,}`), `$1 [REDACTED]`},
}

// String returns text with credential-shaped substrings replaced. It is not a
// substitute for not logging secrets: only pass fields that are safe by design.
func String(text string) string {
	for _, pattern := range patterns {
		text = pattern.re.ReplaceAllString(text, pattern.repl)
	}
	return text
}
