package redact

import (
	"strings"
	"testing"
)

func TestStringRedactsCredentials(t *testing.T) {
	tests := []struct {
		name   string
		input  string
		absent []string
	}{
		{
			name:   "proxy authorization",
			input:  "Proxy-Authorization: Basic YWdlbnQ6ZGVlcHNlZWs=",
			absent: []string{"YWdlbnQ6ZGVlcHNlZWs="},
		},
		{
			name:   "bearer header",
			input:  "Authorization: Bearer abcdefghijklmnop",
			absent: []string{"abcdefghijklmnop"},
		},
		{
			name:   "agent token",
			input:  "token av_agt_abcdefghijklmnopqrstuvwxyz",
			absent: []string{"abcdefghijklmnopqrstuvwxyz"},
		},
		{
			name:   "api key",
			input:  "key sk-abcdefghijklmnopqrstuvwxyz",
			absent: []string{"abcdefghijklmnopqrstuvwxyz"},
		},
		{
			name:   "telegram token",
			input:  "url /bot123456789:AAabcdefghijklmnopqrstuvwxyz012345/getMe",
			absent: []string{"AAabcdefghijklmnopqrstuvwxyz012345"},
		},
		{
			name:   "jwt",
			input:  "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signaturevalue",
			absent: []string{"eyJhbGciOiJIUzI1NiJ9"},
		},
		{
			name:   "url userinfo",
			input:  "https://app:router-password@127.0.0.1:14323",
			absent: []string{"router-password"},
		},
		{
			name:   "query token",
			input:  "https://example.test/path?token=secretvalue&other=1",
			absent: []string{"secretvalue"},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			output := String(test.input)
			for _, value := range test.absent {
				if strings.Contains(output, value) {
					t.Fatalf("output still contains %q: %s", value, output)
				}
			}
			if !strings.Contains(output, "REDACTED") {
				t.Fatalf("output was not marked redacted: %s", output)
			}
		})
	}
}

func TestStringKeepsOrdinaryText(t *testing.T) {
	input := "GET https://api.example.com/v1/models status=200 duration_ms=42"
	if got := String(input); got != input {
		t.Fatalf("ordinary text changed: %q", got)
	}
}
