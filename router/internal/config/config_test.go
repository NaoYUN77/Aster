package config

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func writeConfig(t *testing.T, mutate func(map[string]any)) (string, string, string) {
	t.Helper()
	directory := t.TempDir()
	tokenPath := filepath.Join(directory, "agent-token")
	passwordPath := filepath.Join(directory, "client-password")
	if err := os.WriteFile(tokenPath, []byte("agent-token-value\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(passwordPath, []byte("router-password-value\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	raw := map[string]any{
		"listen":         "127.0.0.1:14323",
		"upstream_proxy": "127.0.0.1:14322",
		"client_auth": map[string]any{
			"username":       "app",
			"password_files": []any{passwordPath},
		},
		"routes": []any{
			map[string]any{
				"name":             "deepseek",
				"host":             "api.deepseek.com",
				"port":             443,
				"vault":            "deepseek",
				"agent_token_file": tokenPath,
			},
		},
		"health_listen": "",
	}
	if mutate != nil {
		mutate(raw)
	}
	data, err := json.Marshal(raw)
	if err != nil {
		t.Fatal(err)
	}
	configPath := filepath.Join(directory, "egress-router.json")
	if err := os.WriteFile(configPath, data, 0o600); err != nil {
		t.Fatal(err)
	}
	return configPath, tokenPath, passwordPath
}

func TestLoadValidAndDefaults(t *testing.T) {
	configPath, _, _ := writeConfig(t, nil)
	cfg, err := Load(configPath)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.Listen != "127.0.0.1:14323" || cfg.UpstreamProxy != "127.0.0.1:14322" {
		t.Fatalf("unexpected endpoints: %+v", cfg)
	}
	if len(cfg.Routes) != 1 {
		t.Fatalf("routes = %d", len(cfg.Routes))
	}
	route := cfg.Routes[0]
	if route.Host != "api.deepseek.com" || route.Name != "deepseek" || route.Vault != "deepseek" {
		t.Fatalf("unexpected route: %+v", route)
	}
	if route.AgentToken() != "agent-token-value" {
		t.Fatalf("agent token not loaded")
	}
	if got := cfg.ClientAuth.Passwords(); len(got) != 1 || got[0] != "router-password-value" {
		t.Fatalf("passwords not loaded: %#v", got)
	}
	if cfg.Timeouts.Idle.Duration().Seconds() != 600 {
		t.Fatalf("default idle timeout = %s", cfg.Timeouts.Idle.Duration())
	}
	if cfg.Limits.MaxConnections != 256 || cfg.Limits.MaxConnectionsPerRoute != 64 {
		t.Fatalf("default limits: %+v", cfg.Limits)
	}
	if !cfg.Log.Access || cfg.Log.Level != "info" || cfg.Log.Format != "json" {
		t.Fatalf("default log: %+v", cfg.Log)
	}
	if strings.Contains(cfg.Summary(), "agent-token") || strings.Contains(cfg.Summary(), "router-password") {
		t.Fatalf("summary leaked a secret: %s", cfg.Summary())
	}
}

func TestLoadNormalizesHostAndName(t *testing.T) {
	configPath, _, _ := writeConfig(t, func(raw map[string]any) {
		route := raw["routes"].([]any)[0].(map[string]any)
		route["host"] = "API.DeepSeek.COM."
		delete(route, "name")
	})
	cfg, err := Load(configPath)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.Routes[0].Host != "api.deepseek.com" {
		t.Fatalf("host = %q", cfg.Routes[0].Host)
	}
	if cfg.Routes[0].Name != "api.deepseek.com" {
		t.Fatalf("name = %q", cfg.Routes[0].Name)
	}
}

func TestLoadRejectsInvalidConfig(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(map[string]any)
		want   string
	}{
		{
			name: "public listen",
			mutate: func(raw map[string]any) {
				raw["listen"] = "0.0.0.0:14323"
			},
			want: "loopback",
		},
		{
			name: "remote upstream",
			mutate: func(raw map[string]any) {
				raw["upstream_proxy"] = "api.deepseek.com:14322"
			},
			want: "loopback",
		},
		{
			name: "public health",
			mutate: func(raw map[string]any) {
				raw["health_listen"] = "0.0.0.0:14324"
			},
			want: "loopback",
		},
		{
			name: "health equals listen",
			mutate: func(raw map[string]any) {
				raw["health_listen"] = "127.0.0.1:14323"
			},
			want: "health_listen",
		},
		{
			name: "wildcard host",
			mutate: func(raw map[string]any) {
				raw["routes"].([]any)[0].(map[string]any)["host"] = "*.deepseek.com"
			},
			want: "DNS label",
		},
		{
			name: "ip host",
			mutate: func(raw map[string]any) {
				raw["routes"].([]any)[0].(map[string]any)["host"] = "127.0.0.1"
			},
			want: "IP literals",
		},
		{
			name: "localhost host",
			mutate: func(raw map[string]any) {
				raw["routes"].([]any)[0].(map[string]any)["host"] = "localhost"
			},
			want: "localhost",
		},
		{
			name: "port not allowed",
			mutate: func(raw map[string]any) {
				raw["routes"].([]any)[0].(map[string]any)["port"] = 22
			},
			want: "allowed_ports",
		},
		{
			name: "duplicate route",
			mutate: func(raw map[string]any) {
				routes := raw["routes"].([]any)
				copyRoute := map[string]any{}
				for key, value := range routes[0].(map[string]any) {
					copyRoute[key] = value
				}
				raw["routes"] = append(routes, copyRoute)
			},
			want: "duplicate route",
		},
		{
			name: "duplicate route name",
			mutate: func(raw map[string]any) {
				routes := raw["routes"].([]any)
				copyRoute := map[string]any{}
				for key, value := range routes[0].(map[string]any) {
					copyRoute[key] = value
				}
				copyRoute["host"] = "api.example.com"
				raw["routes"] = append(routes, copyRoute)
			},
			want: "duplicate route name",
		},
		{
			name: "invalid vault",
			mutate: func(raw map[string]any) {
				raw["routes"].([]any)[0].(map[string]any)["vault"] = "bad:vault"
			},
			want: "vault",
		},
		{
			name: "missing token file",
			mutate: func(raw map[string]any) {
				raw["routes"].([]any)[0].(map[string]any)["agent_token_file"] = filepath.Join(t.TempDir(), "missing-token")
			},
			want: "stat",
		},
		{
			name: "missing password file",
			mutate: func(raw map[string]any) {
				raw["client_auth"].(map[string]any)["password_files"] = []any{filepath.Join(t.TempDir(), "missing-password")}
			},
			want: "stat",
		},
		{
			name: "no password files",
			mutate: func(raw map[string]any) {
				raw["client_auth"].(map[string]any)["password_files"] = []any{}
			},
			want: "one or two",
		},
		{
			name: "idle not greater than dial",
			mutate: func(raw map[string]any) {
				raw["timeouts"] = map[string]any{"idle": "1s", "dial": "5s"}
			},
			want: "idle",
		},
		{
			name: "zero connections",
			mutate: func(raw map[string]any) {
				raw["limits"] = map[string]any{"max_connections": 0}
			},
			want: "max_connections",
		},
		{
			name: "bad log level",
			mutate: func(raw map[string]any) {
				raw["log"] = map[string]any{"level": "verbose"}
			},
			want: "log.level",
		},
		{
			name: "unknown field",
			mutate: func(raw map[string]any) {
				raw["unknown"] = true
			},
			want: "unknown field",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			configPath, _, _ := writeConfig(t, test.mutate)
			_, err := Load(configPath)
			if err == nil {
				t.Fatal("expected an error")
			}
			if !strings.Contains(err.Error(), test.want) {
				t.Fatalf("error = %q, want substring %q", err, test.want)
			}
		})
	}
}

func TestLoadRejectsOtherReadableSecretFile(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows does not expose POSIX permission bits")
	}
	configPath, tokenPath, _ := writeConfig(t, nil)
	if err := os.Chmod(tokenPath, 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(configPath); err == nil || !strings.Contains(err.Error(), "permissions") {
		t.Fatalf("expected permission error, got %v", err)
	}
}

func TestConfigJSONOmitsSecrets(t *testing.T) {
	configPath, _, _ := writeConfig(t, nil)
	cfg, err := Load(configPath)
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), "agent-token-value") || strings.Contains(string(encoded), "router-password-value") {
		t.Fatalf("marshaled config leaked a secret: %s", encoded)
	}
}

func TestNormalizeHost(t *testing.T) {
	valid := map[string]string{
		"api.deepseek.com":  "api.deepseek.com",
		"API.DeepSeek.COM.": "api.deepseek.com",
		"a-b.example":       "a-b.example",
	}
	for input, want := range valid {
		got, err := NormalizeHost(input)
		if err != nil || got != want {
			t.Fatalf("NormalizeHost(%q) = %q, %v; want %q", input, got, err, want)
		}
	}
	invalid := []string{"", " ", "127.0.0.1", "::1", "localhost", "a..b", "-a.example", "a-.example", "a_b.example", "exa mple.com"}
	for _, input := range invalid {
		if _, err := NormalizeHost(input); err == nil {
			t.Fatalf("NormalizeHost(%q) unexpectedly succeeded", input)
		}
	}
}
