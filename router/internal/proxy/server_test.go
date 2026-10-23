package proxy

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/NaoYUN77/personal-agent-base-durable/router/internal/config"
)

const (
	testTarget   = "api.example.test:443"
	testHost     = "api.example.test"
	testVault    = "deepseek"
	testAgent    = "agent-token-value"
	testPassword = "router-password-value"
)

func testClientAuth() string {
	return "Basic " + base64.StdEncoding.EncodeToString([]byte("app:"+testPassword))
}

func testUpstreamAuth() string {
	return "Basic " + base64.StdEncoding.EncodeToString([]byte(testAgent+":"+testVault))
}

func newTestConfig(t *testing.T, upstream string, mutate func(map[string]any)) *config.Config {
	t.Helper()
	directory := t.TempDir()
	tokenPath := filepath.Join(directory, "agent-token")
	passwordPath := filepath.Join(directory, "client-password")
	if err := os.WriteFile(tokenPath, []byte(testAgent+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(passwordPath, []byte(testPassword+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	raw := map[string]any{
		"listen":         "127.0.0.1:14323",
		"upstream_proxy": upstream,
		"client_auth": map[string]any{
			"username":       "app",
			"password_files": []any{passwordPath},
		},
		"routes": []any{
			map[string]any{
				"name":             "deepseek",
				"host":             testHost,
				"port":             443,
				"vault":            testVault,
				"agent_token_file": tokenPath,
			},
		},
		"timeouts": map[string]any{
			"client_header":   "2s",
			"dial":            "1s",
			"upstream_header": "2s",
			"idle":            "10s",
			"shutdown":        "2s",
		},
		"limits": map[string]any{
			"max_connections":           32,
			"max_connections_per_route": 16,
			"max_header_bytes":          16384,
			"max_error_body_bytes":      4096,
		},
		"log": map[string]any{
			"level":  "debug",
			"format": "json",
			"access": true,
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
	cfg, err := config.Load(configPath)
	if err != nil {
		t.Fatalf("load test config: %v", err)
	}
	return cfg
}

type fakeUpstream struct {
	listener net.Listener
	accepted atomic.Int64
	wg       sync.WaitGroup
}

func startFakeUpstream(t *testing.T, handler func(net.Conn, *bufio.Reader)) *fakeUpstream {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	fake := &fakeUpstream{listener: listener}
	fake.wg.Add(1)
	go func() {
		defer fake.wg.Done()
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			fake.accepted.Add(1)
			fake.wg.Add(1)
			go func() {
				defer fake.wg.Done()
				defer conn.Close()
				handler(conn, bufio.NewReader(conn))
			}()
		}
	}()
	t.Cleanup(func() {
		_ = listener.Close()
		fake.wg.Wait()
	})
	return fake
}

func (f *fakeUpstream) addr() string {
	return f.listener.Addr().String()
}

type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *syncBuffer) Write(data []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(data)
}

func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

func startRouter(t *testing.T, cfg *config.Config) (string, *syncBuffer) {
	t.Helper()
	logs := &syncBuffer{}
	logger := slog.New(slog.NewJSONHandler(logs, &slog.HandlerOptions{Level: slog.LevelDebug}))
	server := New(cfg, logger)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	go func() {
		_ = server.Serve(listener)
	}()
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = server.Shutdown(ctx)
		_ = listener.Close()
	})
	return listener.Addr().String(), logs
}

func dialRouter(t *testing.T, address, target, auth string) (net.Conn, *bufio.Reader) {
	t.Helper()
	conn, err := net.Dial("tcp", address)
	if err != nil {
		t.Fatal(err)
	}
	var request strings.Builder
	fmt.Fprintf(&request, "CONNECT %s HTTP/1.1\r\nHost: %s\r\n", target, target)
	if auth != "" {
		fmt.Fprintf(&request, "Proxy-Authorization: %s\r\n", auth)
	}
	request.WriteString("\r\n")
	if _, err := io.WriteString(conn, request.String()); err != nil {
		_ = conn.Close()
		t.Fatal(err)
	}
	return conn, bufio.NewReader(conn)
}

func readResponse(t *testing.T, reader *bufio.Reader) *http.Response {
	t.Helper()
	response, err := http.ReadResponse(reader, &http.Request{Method: http.MethodConnect})
	if err != nil {
		t.Fatal(err)
	}
	return response
}

func readBody(t *testing.T, response *http.Response) string {
	t.Helper()
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, 8192))
	if err != nil {
		t.Fatal(err)
	}
	return string(body)
}

func readFakeConnectRequest(t *testing.T, reader *bufio.Reader) (target, authorization string) {
	t.Helper()
	line, err := reader.ReadString('\n')
	if err != nil {
		t.Errorf("read request line: %v", err)
		return "", ""
	}
	parts := strings.SplitN(strings.TrimSpace(line), " ", 3)
	if len(parts) < 2 || parts[0] != http.MethodConnect {
		t.Errorf("unexpected request line %q", line)
		return "", ""
	}
	target = parts[1]
	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			t.Errorf("read header: %v", err)
			return target, authorization
		}
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			return target, authorization
		}
		key, value, ok := strings.Cut(trimmed, ":")
		if ok && strings.EqualFold(key, "Proxy-Authorization") {
			authorization = strings.TrimSpace(value)
		}
	}
}

func waitForLog(t *testing.T, logs *syncBuffer, substring string) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if strings.Contains(logs.String(), substring) {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("log did not contain %q: %s", substring, logs.String())
}

func TestConnectRoutesAndForwards(t *testing.T) {
	upstream := startFakeUpstream(t, func(conn net.Conn, reader *bufio.Reader) {
		target, authorization := readFakeConnectRequest(t, reader)
		if target != testTarget {
			t.Errorf("upstream target = %q", target)
		}
		if authorization != testUpstreamAuth() {
			t.Errorf("upstream authorization = %q", authorization)
		}
		_, _ = io.WriteString(conn, "HTTP/1.1 200 Connection Established\r\n\r\n")
		_, _ = io.Copy(conn, reader)
	})
	cfg := newTestConfig(t, upstream.addr(), nil)
	address, logs := startRouter(t, cfg)

	conn, reader := dialRouter(t, address, testTarget, testClientAuth())
	defer conn.Close()
	response := readResponse(t, reader)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("CONNECT status = %d (%s)", response.StatusCode, readBody(t, response))
	}
	if _, err := io.WriteString(conn, "ping"); err != nil {
		t.Fatal(err)
	}
	echo := make([]byte, 4)
	if _, err := io.ReadFull(reader, echo); err != nil {
		t.Fatal(err)
	}
	if string(echo) != "ping" {
		t.Fatalf("echo = %q", echo)
	}
	_ = conn.Close()

	waitForLog(t, logs, `"route":"deepseek"`)
	waitForLog(t, logs, `"vault":"deepseek"`)
	if strings.Contains(logs.String(), testAgent) || strings.Contains(logs.String(), testPassword) {
		t.Fatalf("access log leaked a secret: %s", logs.String())
	}
}

func TestConnectWithBodyRejected(t *testing.T) {
	var accepted atomic.Int64
	upstream := startFakeUpstream(t, func(conn net.Conn, reader *bufio.Reader) {
		accepted.Add(1)
	})
	cfg := newTestConfig(t, upstream.addr(), nil)
	address, _ := startRouter(t, cfg)

	conn, err := net.Dial("tcp", address)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	request := fmt.Sprintf("CONNECT %s HTTP/1.1\r\nHost: %s\r\nProxy-Authorization: %s\r\nContent-Length: 4\r\n\r\nbody",
		testTarget, testTarget, testClientAuth())
	if _, err := io.WriteString(conn, request); err != nil {
		t.Fatal(err)
	}
	response := readResponse(t, bufio.NewReader(conn))
	if response.StatusCode != http.StatusBadRequest {
		t.Fatalf("status = %d", response.StatusCode)
	}
	_ = readBody(t, response)
	if accepted.Load() != 0 {
		t.Fatal("upstream was contacted for a CONNECT with a body")
	}
}

func TestHostHeaderDoesNotOverrideTarget(t *testing.T) {
	upstream := startFakeUpstream(t, func(conn net.Conn, reader *bufio.Reader) {
		target, _ := readFakeConnectRequest(t, reader)
		if target != testTarget {
			t.Errorf("upstream target = %q", target)
		}
		_, _ = io.WriteString(conn, "HTTP/1.1 200 Connection Established\r\n\r\n")
	})
	cfg := newTestConfig(t, upstream.addr(), nil)
	address, _ := startRouter(t, cfg)

	conn, err := net.Dial("tcp", address)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	request := fmt.Sprintf("CONNECT %s HTTP/1.1\r\nHost: evil.example.test:443\r\nProxy-Authorization: %s\r\n\r\n",
		testTarget, testClientAuth())
	if _, err := io.WriteString(conn, request); err != nil {
		t.Fatal(err)
	}
	response := readResponse(t, bufio.NewReader(conn))
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200 for the request-target", response.StatusCode)
	}
}

func TestAccessLogRedactsStringFields(t *testing.T) {
	const secretShapedName = "sk-abcdefghijklmnop"
	upstream := startFakeUpstream(t, func(conn net.Conn, reader *bufio.Reader) {
		readFakeConnectRequest(t, reader)
		_, _ = io.WriteString(conn, "HTTP/1.1 200 Connection Established\r\n\r\n")
		_, _ = io.Copy(io.Discard, reader)
	})
	cfg := newTestConfig(t, upstream.addr(), func(raw map[string]any) {
		raw["routes"].([]any)[0].(map[string]any)["name"] = secretShapedName
	})
	address, logs := startRouter(t, cfg)

	conn, reader := dialRouter(t, address, testTarget, testClientAuth())
	defer conn.Close()
	if response := readResponse(t, reader); response.StatusCode != http.StatusOK {
		t.Fatalf("status = %d", response.StatusCode)
	}
	_ = conn.Close()

	waitForLog(t, logs, `"route":"sk-[REDACTED]"`)
	if strings.Contains(logs.String(), secretShapedName) {
		t.Fatalf("access log leaked a secret-shaped route name: %s", logs.String())
	}
}

func TestClientAuthenticationRequired(t *testing.T) {
	var accepted atomic.Int64
	upstream := startFakeUpstream(t, func(conn net.Conn, reader *bufio.Reader) {
		accepted.Add(1)
		_, _ = io.WriteString(conn, "HTTP/1.1 200 Connection Established\r\n\r\n")
	})
	cfg := newTestConfig(t, upstream.addr(), nil)
	address, _ := startRouter(t, cfg)

	conn, reader := dialRouter(t, address, testTarget, "")
	defer conn.Close()
	response := readResponse(t, reader)
	if response.StatusCode != http.StatusProxyAuthRequired {
		t.Fatalf("status = %d", response.StatusCode)
	}
	if !strings.Contains(response.Header.Get("Proxy-Authenticate"), "agent-egress-router") {
		t.Fatalf("realm = %q", response.Header.Get("Proxy-Authenticate"))
	}
	_ = readBody(t, response)
	if accepted.Load() != 0 {
		t.Fatalf("upstream was contacted on auth failure")
	}
}

func TestUnknownRouteDenied(t *testing.T) {
	var accepted atomic.Int64
	upstream := startFakeUpstream(t, func(conn net.Conn, reader *bufio.Reader) {
		accepted.Add(1)
	})
	cfg := newTestConfig(t, upstream.addr(), nil)
	address, logs := startRouter(t, cfg)

	conn, reader := dialRouter(t, address, "unknown.example.test:443", testClientAuth())
	defer conn.Close()
	response := readResponse(t, reader)
	if response.StatusCode != http.StatusForbidden {
		t.Fatalf("status = %d", response.StatusCode)
	}
	_ = readBody(t, response)
	if accepted.Load() != 0 {
		t.Fatalf("upstream was contacted for an unknown route")
	}
	waitForLog(t, logs, `"error_class":"route_not_found"`)
}

func TestUpstreamErrorPassthrough(t *testing.T) {
	for _, status := range []int{http.StatusForbidden, http.StatusProxyAuthRequired} {
		t.Run(fmt.Sprintf("status_%d", status), func(t *testing.T) {
			upstream := startFakeUpstream(t, func(conn net.Conn, reader *bufio.Reader) {
				readFakeConnectRequest(t, reader)
				body := "vault denied"
				fmt.Fprintf(conn, "HTTP/1.1 %d %s\r\nProxy-Authenticate: Basic realm=\"agent-vault\"\r\nContent-Length: %d\r\n\r\n%s",
					status, http.StatusText(status), len(body), body)
			})
			cfg := newTestConfig(t, upstream.addr(), nil)
			address, _ := startRouter(t, cfg)

			conn, reader := dialRouter(t, address, testTarget, testClientAuth())
			defer conn.Close()
			response := readResponse(t, reader)
			if response.StatusCode != status {
				t.Fatalf("status = %d, want %d", response.StatusCode, status)
			}
			if !strings.Contains(response.Header.Get("Proxy-Authenticate"), "agent-vault") {
				t.Fatalf("Proxy-Authenticate = %q", response.Header.Get("Proxy-Authenticate"))
			}
			if body := readBody(t, response); body != "vault denied" {
				t.Fatalf("body = %q", body)
			}
		})
	}
}

func TestEarlyDataAfterConnectIsForwarded(t *testing.T) {
	upstream := startFakeUpstream(t, func(conn net.Conn, reader *bufio.Reader) {
		readFakeConnectRequest(t, reader)
		_, _ = io.WriteString(conn, "HTTP/1.1 200 Connection Established\r\n\r\n")
		_, _ = io.Copy(conn, reader)
	})
	cfg := newTestConfig(t, upstream.addr(), nil)
	address, _ := startRouter(t, cfg)

	conn, err := net.Dial("tcp", address)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	request := fmt.Sprintf("CONNECT %s HTTP/1.1\r\nHost: %s\r\nProxy-Authorization: %s\r\n\r\nearly",
		testTarget, testTarget, testClientAuth())
	if _, err := io.WriteString(conn, request); err != nil {
		t.Fatal(err)
	}
	reader := bufio.NewReader(conn)
	response := readResponse(t, reader)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status = %d", response.StatusCode)
	}
	echo := make([]byte, 5)
	if _, err := io.ReadFull(reader, echo); err != nil {
		t.Fatal(err)
	}
	if string(echo) != "early" {
		t.Fatalf("early bytes = %q", echo)
	}
}

func TestHalfClosePropagates(t *testing.T) {
	upstream := startFakeUpstream(t, func(conn net.Conn, reader *bufio.Reader) {
		readFakeConnectRequest(t, reader)
		_, _ = io.WriteString(conn, "HTTP/1.1 200 Connection Established\r\n\r\n")
		_, _ = io.Copy(io.Discard, reader)
		_, _ = io.WriteString(conn, "done")
		if tcp, ok := conn.(*net.TCPConn); ok {
			_ = tcp.CloseWrite()
		}
	})
	cfg := newTestConfig(t, upstream.addr(), nil)
	address, _ := startRouter(t, cfg)

	conn, reader := dialRouter(t, address, testTarget, testClientAuth())
	defer conn.Close()
	response := readResponse(t, reader)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status = %d", response.StatusCode)
	}
	tcp, ok := conn.(*net.TCPConn)
	if !ok {
		t.Fatal("client is not TCP")
	}
	if _, err := io.WriteString(conn, "request"); err != nil {
		t.Fatal(err)
	}
	if err := tcp.CloseWrite(); err != nil {
		t.Fatal(err)
	}
	_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	data, err := io.ReadAll(reader)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "done" {
		t.Fatalf("response = %q", data)
	}
}

func TestIdleTimeoutClosesTunnel(t *testing.T) {
	upstream := startFakeUpstream(t, func(conn net.Conn, reader *bufio.Reader) {
		readFakeConnectRequest(t, reader)
		_, _ = io.WriteString(conn, "HTTP/1.1 200 Connection Established\r\n\r\n")
		_, _ = io.Copy(io.Discard, reader)
	})
	cfg := newTestConfig(t, upstream.addr(), func(raw map[string]any) {
		raw["timeouts"] = map[string]any{
			"dial":            "50ms",
			"upstream_header": "1s",
			"idle":            "200ms",
			"shutdown":        "1s",
		}
	})
	address, logs := startRouter(t, cfg)

	conn, reader := dialRouter(t, address, testTarget, testClientAuth())
	defer conn.Close()
	response := readResponse(t, reader)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status = %d", response.StatusCode)
	}
	_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	buffer := make([]byte, 1)
	if _, err := reader.Read(buffer); err == nil {
		t.Fatal("expected the idle tunnel to close")
	}
	waitForLog(t, logs, `"error_class":"idle_timeout"`)
}

func TestConnectionLimit(t *testing.T) {
	release := make(chan struct{})
	defer close(release)
	upstream := startFakeUpstream(t, func(conn net.Conn, reader *bufio.Reader) {
		readFakeConnectRequest(t, reader)
		_, _ = io.WriteString(conn, "HTTP/1.1 200 Connection Established\r\n\r\n")
		<-release
	})
	cfg := newTestConfig(t, upstream.addr(), func(raw map[string]any) {
		raw["limits"] = map[string]any{
			"max_connections":           1,
			"max_connections_per_route": 1,
			"max_header_bytes":          16384,
			"max_error_body_bytes":      4096,
		}
	})
	address, _ := startRouter(t, cfg)

	first, firstReader := dialRouter(t, address, testTarget, testClientAuth())
	defer first.Close()
	if response := readResponse(t, firstReader); response.StatusCode != http.StatusOK {
		t.Fatalf("first status = %d", response.StatusCode)
	}

	second, secondReader := dialRouter(t, address, testTarget, testClientAuth())
	defer second.Close()
	response := readResponse(t, secondReader)
	if response.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("second status = %d", response.StatusCode)
	}
	_ = readBody(t, response)
}
