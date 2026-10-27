package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"
	"unicode"
)

// Duration is a JSON string such as "10s", not an integer nanosecond count.
type Duration time.Duration

func (d *Duration) UnmarshalJSON(data []byte) error {
	var raw string
	if err := json.Unmarshal(data, &raw); err != nil {
		return fmt.Errorf("duration must be a string such as \"10s\": %w", err)
	}
	parsed, err := time.ParseDuration(raw)
	if err != nil {
		return err
	}
	*d = Duration(parsed)
	return nil
}

func (d Duration) Duration() time.Duration { return time.Duration(d) }

type Config struct {
	Listen        string     `json:"listen"`
	UpstreamProxy string     `json:"upstream_proxy"`
	ClientAuth    ClientAuth `json:"client_auth"`
	Routes        []Route    `json:"routes"`
	AllowedPorts  []int      `json:"allowed_ports"`
	Timeouts      Timeouts   `json:"timeouts"`
	Limits        Limits     `json:"limits"`
	Log           Log        `json:"log"`
	HealthListen  string     `json:"health_listen"`
}

type ClientAuth struct {
	Username      string   `json:"username"`
	PasswordFiles []string `json:"password_files"`

	passwords []string
}

// Passwords returns the values loaded from PasswordFiles. The slice is owned by
// the immutable Config and must not be modified.
func (c ClientAuth) Passwords() []string { return c.passwords }

type Route struct {
	Name           string `json:"name"`
	Host           string `json:"host"`
	Port           int    `json:"port"`
	Vault          string `json:"vault"`
	AgentTokenFile string `json:"agent_token_file"`

	agentToken string
}

// AgentToken returns the value loaded from AgentTokenFile.
func (r Route) AgentToken() string { return r.agentToken }

type Timeouts struct {
	ClientHeader   Duration `json:"client_header"`
	Dial           Duration `json:"dial"`
	UpstreamHeader Duration `json:"upstream_header"`
	Idle           Duration `json:"idle"`
	Shutdown       Duration `json:"shutdown"`
}

type Limits struct {
	MaxConnections         int `json:"max_connections"`
	MaxConnectionsPerRoute int `json:"max_connections_per_route"`
	MaxHeaderBytes         int `json:"max_header_bytes"`
	MaxErrorBodyBytes      int `json:"max_error_body_bytes"`
}

type Log struct {
	Level  string `json:"level"`
	Format string `json:"format"`
	Access bool   `json:"access"`
}

func defaults() Config {
	return Config{
		Listen:        "127.0.0.1:14323",
		UpstreamProxy: "127.0.0.1:14322",
		AllowedPorts:  []int{443},
		Timeouts: Timeouts{
			ClientHeader:   Duration(10 * time.Second),
			Dial:           Duration(5 * time.Second),
			UpstreamHeader: Duration(15 * time.Second),
			Idle:           Duration(10 * time.Minute),
			Shutdown:       Duration(15 * time.Second),
		},
		Limits: Limits{
			MaxConnections:         256,
			MaxConnectionsPerRoute: 64,
			MaxHeaderBytes:         16 * 1024,
			MaxErrorBodyBytes:      4 * 1024,
		},
		Log: Log{Level: "info", Format: "json", Access: true},
	}
}

func Load(path string) (*Config, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("open config: %w", err)
	}
	defer file.Close()

	cfg := defaults()
	decoder := json.NewDecoder(file)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&cfg); err != nil {
		return nil, fmt.Errorf("parse config: %w", err)
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return nil, errors.New("config must contain exactly one JSON object")
	}
	if err := cfg.finalize(); err != nil {
		return nil, err
	}
	return &cfg, nil
}

func (c *Config) finalize() error {
	var err error
	if c.Listen, err = validateLoopbackEndpoint("listen", c.Listen); err != nil {
		return err
	}
	if c.UpstreamProxy, err = validateUpstreamEndpoint(c.UpstreamProxy); err != nil {
		return err
	}
	if c.HealthListen != "" {
		if c.HealthListen, err = validateLoopbackEndpoint("health_listen", c.HealthListen); err != nil {
			return err
		}
	}
	if c.Listen == c.UpstreamProxy {
		return errors.New("listen and upstream_proxy must be different")
	}
	if c.HealthListen != "" && (c.HealthListen == c.Listen || c.HealthListen == c.UpstreamProxy) {
		return errors.New("health_listen must differ from listen and upstream_proxy")
	}

	if len(c.AllowedPorts) == 0 {
		c.AllowedPorts = []int{443}
	}
	allowed := make(map[int]bool, len(c.AllowedPorts))
	for _, port := range c.AllowedPorts {
		if port < 1 || port > 65535 {
			return fmt.Errorf("allowed_ports contains invalid port %d", port)
		}
		allowed[port] = true
	}

	if len(c.Routes) == 0 {
		return errors.New("routes must not be empty")
	}
	seen := make(map[string]bool, len(c.Routes))
	names := make(map[string]bool, len(c.Routes))
	for i := range c.Routes {
		route := &c.Routes[i]
		route.Name = strings.TrimSpace(route.Name)
		route.Vault = strings.TrimSpace(route.Vault)
		route.AgentTokenFile = strings.TrimSpace(route.AgentTokenFile)

		host, err := NormalizeHost(route.Host)
		if err != nil {
			return fmt.Errorf("routes[%d].host: %w", i, err)
		}
		route.Host = host
		if route.Name == "" {
			route.Name = host
		}
		if strings.ContainsAny(route.Name, "\r\n") {
			return fmt.Errorf("routes[%d].name contains a line break", i)
		}
		if names[route.Name] {
			return fmt.Errorf("duplicate route name %q", route.Name)
		}
		names[route.Name] = true
		if route.Port < 1 || route.Port > 65535 {
			return fmt.Errorf("routes[%d].port is invalid", i)
		}
		if !allowed[route.Port] {
			return fmt.Errorf("routes[%d].port %d is not in allowed_ports", i, route.Port)
		}
		key := fmt.Sprintf("%s:%d", route.Host, route.Port)
		if seen[key] {
			return fmt.Errorf("duplicate route for %s", key)
		}
		seen[key] = true
		if err := validateVault(route.Vault); err != nil {
			return fmt.Errorf("routes[%d].vault: %w", i, err)
		}
		token, err := readSecretFile(route.AgentTokenFile, 8192, false)
		if err != nil {
			return fmt.Errorf("routes[%d].agent_token_file: %w", i, err)
		}
		if strings.Contains(token, ":") {
			return fmt.Errorf("routes[%d].agent_token_file must not contain ':'", i)
		}
		route.agentToken = token
	}

	c.ClientAuth.Username = strings.TrimSpace(c.ClientAuth.Username)
	if c.ClientAuth.Username == "" {
		return errors.New("client_auth.username is required")
	}
	if strings.Contains(c.ClientAuth.Username, ":") {
		return errors.New("client_auth.username must not contain ':'")
	}
	for _, r := range c.ClientAuth.Username {
		if unicode.IsControl(r) {
			return errors.New("client_auth.username contains a control character")
		}
	}
	if len(c.ClientAuth.PasswordFiles) < 1 || len(c.ClientAuth.PasswordFiles) > 2 {
		return errors.New("client_auth.password_files must contain one or two files")
	}
	c.ClientAuth.passwords = make([]string, 0, len(c.ClientAuth.PasswordFiles))
	for i := range c.ClientAuth.PasswordFiles {
		path := strings.TrimSpace(c.ClientAuth.PasswordFiles[i])
		c.ClientAuth.PasswordFiles[i] = path
		password, err := readSecretFile(path, 1024, true)
		if err != nil {
			return fmt.Errorf("client_auth.password_files[%d]: %w", i, err)
		}
		c.ClientAuth.passwords = append(c.ClientAuth.passwords, password)
	}

	if c.Timeouts.ClientHeader.Duration() <= 0 ||
		c.Timeouts.Dial.Duration() <= 0 ||
		c.Timeouts.UpstreamHeader.Duration() <= 0 ||
		c.Timeouts.Idle.Duration() <= 0 ||
		c.Timeouts.Shutdown.Duration() <= 0 {
		return errors.New("all timeouts must be positive")
	}
	if c.Timeouts.Idle.Duration() <= c.Timeouts.Dial.Duration() {
		return errors.New("timeouts.idle must be greater than timeouts.dial")
	}

	if c.Limits.MaxConnections < 1 {
		return errors.New("limits.max_connections must be positive")
	}
	if c.Limits.MaxConnectionsPerRoute < 1 {
		return errors.New("limits.max_connections_per_route must be positive")
	}
	if c.Limits.MaxHeaderBytes < 1024 || c.Limits.MaxHeaderBytes > 1<<20 {
		return errors.New("limits.max_header_bytes must be between 1024 and 1048576")
	}
	if c.Limits.MaxErrorBodyBytes < 0 || c.Limits.MaxErrorBodyBytes > 1<<20 {
		return errors.New("limits.max_error_body_bytes must be between 0 and 1048576")
	}

	c.Log.Level = strings.ToLower(strings.TrimSpace(c.Log.Level))
	switch c.Log.Level {
	case "debug", "info", "warn", "error":
	default:
		return errors.New("log.level must be one of debug, info, warn, error")
	}
	c.Log.Format = strings.ToLower(strings.TrimSpace(c.Log.Format))
	switch c.Log.Format {
	case "json", "text":
	default:
		return errors.New("log.format must be json or text")
	}
	return nil
}

func (c *Config) Summary() string {
	return fmt.Sprintf("%d routes, listen %s, upstream %s", len(c.Routes), c.Listen, c.UpstreamProxy)
}

// NormalizeHost accepts a DNS name only. IP literals, localhost, wildcards and
// non-ASCII names are rejected so an accidental config cannot turn the router
// into a general-purpose proxy.
func NormalizeHost(raw string) (string, error) {
	host := strings.TrimSpace(raw)
	host = strings.TrimSuffix(host, ".")
	host = strings.ToLower(host)
	if host == "" {
		return "", errors.New("host is required")
	}
	if len(host) > 253 {
		return "", errors.New("host is too long")
	}
	if net.ParseIP(host) != nil {
		return "", errors.New("IP literals are not allowed")
	}
	if host == "localhost" || strings.HasSuffix(host, ".localhost") {
		return "", errors.New("localhost is not allowed")
	}
	for _, label := range strings.Split(host, ".") {
		if !validDNSLabel(label) {
			return "", fmt.Errorf("invalid DNS label %q", label)
		}
	}
	return host, nil
}

func validDNSLabel(label string) bool {
	if len(label) == 0 || len(label) > 63 {
		return false
	}
	for i, r := range label {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '-' {
			if r == '-' && (i == 0 || i == len(label)-1) {
				return false
			}
			continue
		}
		return false
	}
	return true
}

func validateVault(vault string) error {
	if vault == "" {
		return errors.New("vault is required")
	}
	if len(vault) > 128 {
		return errors.New("vault is too long")
	}
	for _, r := range vault {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '-' || r == '_' || r == '.' {
			continue
		}
		return fmt.Errorf("invalid character %q", r)
	}
	return nil
}

// The broker may live on a private Docker bridge; listeners remain loopback-only.
// Require a literal address so DNS cannot change the broker destination after validation.
func validateUpstreamEndpoint(addr string) (string, error) {
	addr = strings.TrimSpace(addr)
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return "", fmt.Errorf("upstream_proxy must be host:port: %w", err)
	}
	ip := net.ParseIP(host)
	if !isLoopbackHost(host) && (ip == nil || !ip.IsPrivate()) {
		return "", errors.New("upstream_proxy must connect to loopback or a private IP address")
	}
	number, err := strconv.Atoi(port)
	if err != nil || number < 1 || number > 65535 {
		return "", errors.New("upstream_proxy has an invalid port")
	}
	return net.JoinHostPort(host, port), nil
}

func validateLoopbackEndpoint(name, addr string) (string, error) {
	addr = strings.TrimSpace(addr)
	if addr == "" {
		return "", fmt.Errorf("%s is required", name)
	}
	if strings.Contains(addr, "://") {
		return "", fmt.Errorf("%s must be host:port without a URL scheme", name)
	}
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return "", fmt.Errorf("%s must be host:port: %w", name, err)
	}
	if !isLoopbackHost(host) {
		return "", fmt.Errorf("%s must bind or connect to loopback", name)
	}
	number, err := strconv.Atoi(port)
	if err != nil || number < 1 || number > 65535 {
		return "", fmt.Errorf("%s has an invalid port", name)
	}
	return net.JoinHostPort(host, port), nil
}

func isLoopbackHost(host string) bool {
	host = strings.Trim(host, "[]")
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func readSecretFile(path string, maxBytes int, allowSpace bool) (string, error) {
	if path == "" {
		return "", errors.New("path is required")
	}
	if !filepath.IsAbs(path) {
		return "", errors.New("path must be absolute")
	}
	info, err := os.Stat(path)
	if err != nil {
		return "", fmt.Errorf("stat: %w", err)
	}
	if !info.Mode().IsRegular() {
		return "", errors.New("not a regular file")
	}
	if runtime.GOOS != "windows" {
		perm := info.Mode().Perm()
		if perm&0o007 != 0 || perm&0o020 != 0 {
			return "", fmt.Errorf("permissions %04o allow other access or group write; use 0600 or 0640", perm)
		}
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("read: %w", err)
	}
	if len(data) > maxBytes {
		return "", fmt.Errorf("file exceeds %d bytes", maxBytes)
	}
	value := strings.TrimSpace(string(data))
	if value == "" {
		return "", errors.New("file is empty")
	}
	for _, r := range value {
		if r == 0 || unicode.IsControl(r) {
			return "", errors.New("file contains a control character")
		}
		if !allowSpace && unicode.IsSpace(r) {
			return "", errors.New("file contains whitespace")
		}
	}
	return value, nil
}
