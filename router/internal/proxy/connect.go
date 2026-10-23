package proxy

import (
	"bufio"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"math"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/NaoYUN77/personal-agent-base-durable/router/internal/config"
)

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	start := time.Now()
	id := connIDFromContext(r.Context())
	runtime := s.runtime.Load()

	if s.shuttingDown.Load() {
		writeProxyError(w, http.StatusServiceUnavailable, "router is shutting down")
		s.logAccess(accessLog{
			ConnID: id, Kind: "connect", Status: http.StatusServiceUnavailable,
			Duration: time.Since(start), ErrorClass: "shutdown", ClientAddr: r.RemoteAddr,
		})
		return
	}
	if r.Method != http.MethodConnect {
		writeProxyError(w, http.StatusBadRequest, "only CONNECT is supported")
		s.logAccess(accessLog{
			ConnID: id, Kind: "request", Status: http.StatusBadRequest,
			Duration: time.Since(start), ErrorClass: "target_invalid", ClientAddr: r.RemoteAddr,
		})
		return
	}

	if r.ContentLength > 0 || len(r.TransferEncoding) > 0 {
		writeProxyError(w, http.StatusBadRequest, "CONNECT must not carry a body")
		s.logAccess(accessLog{
			ConnID: id, Kind: "connect", Status: http.StatusBadRequest,
			Duration: time.Since(start), ErrorClass: "target_invalid", ClientAddr: r.RemoteAddr,
		})
		return
	}

	ok, authClass := authenticate(r, runtime.cfg.ClientAuth)
	if !ok {
		writeProxyError(w, http.StatusProxyAuthRequired, "proxy authentication required")
		s.logAccess(accessLog{
			ConnID: id, Kind: "connect", Status: http.StatusProxyAuthRequired,
			Duration: time.Since(start), ErrorClass: authClass, ClientAddr: r.RemoteAddr,
		})
		return
	}
	r.Header.Del("Proxy-Authorization")

	if r.ContentLength > 0 || len(r.TransferEncoding) > 0 {
		writeProxyError(w, http.StatusBadRequest, "CONNECT must not carry a body")
		s.logAccess(accessLog{
			ConnID: id, Kind: "connect", Status: http.StatusBadRequest,
			Duration: time.Since(start), ErrorClass: "target_invalid", ClientAddr: r.RemoteAddr,
		})
		return
	}

	host, port, err := parseAuthority(connectAuthority(r))
	if r.URL != nil && r.URL.User != nil {
		err = errors.New("CONNECT target must not contain userinfo")
	}
	if err != nil {
		writeProxyError(w, http.StatusBadRequest, "invalid CONNECT target")
		s.logAccess(accessLog{
			ConnID: id, Kind: "connect", Status: http.StatusBadRequest,
			Duration: time.Since(start), ErrorClass: "target_invalid", ClientAddr: r.RemoteAddr,
		})
		return
	}

	route := runtime.routes[routeKey{host: host, port: port}]
	if route == nil {
		writeProxyError(w, http.StatusForbidden, "route not allowed")
		s.logAccess(accessLog{
			ConnID: id, Kind: "connect", Host: host, Port: port, Status: http.StatusForbidden,
			Duration: time.Since(start), ErrorClass: "route_not_found", ClientAddr: r.RemoteAddr,
		})
		return
	}

	if !tryAcquire(runtime.globalSem) {
		writeProxyError(w, http.StatusServiceUnavailable, "router is overloaded")
		s.logAccess(accessLog{
			ConnID: id, Kind: "connect", Route: route.route.Name, Vault: route.route.Vault,
			Host: host, Port: port, Status: http.StatusServiceUnavailable,
			Duration: time.Since(start), ErrorClass: "overloaded", ClientAddr: r.RemoteAddr,
		})
		return
	}
	defer release(runtime.globalSem)

	if !tryAcquire(route.sem) {
		writeProxyError(w, http.StatusServiceUnavailable, "route is overloaded")
		s.logAccess(accessLog{
			ConnID: id, Kind: "connect", Route: route.route.Name, Vault: route.route.Vault,
			Host: host, Port: port, Status: http.StatusServiceUnavailable,
			Duration: time.Since(start), ErrorClass: "overloaded", ClientAddr: r.RemoteAddr,
		})
		return
	}
	defer release(route.sem)

	s.handleConnect(w, r, runtime, route, id, host, port, start)
}

func (s *Server) handleConnect(
	w http.ResponseWriter,
	r *http.Request,
	runtime *runtimeConfig,
	route *routeRuntime,
	id string,
	host string,
	port int,
	start time.Time,
) {
	authority := net.JoinHostPort(host, strconv.Itoa(port))
	upstream, err := net.DialTimeout("tcp", runtime.cfg.UpstreamProxy, runtime.cfg.Timeouts.Dial.Duration())
	if err != nil {
		status, class := classifyDialError(err)
		writeProxyError(w, status, "upstream unavailable")
		s.logAccess(accessLog{
			ConnID: id, Kind: "connect", Route: route.route.Name, Vault: route.route.Vault,
			Host: host, Port: port, Status: status, Duration: time.Since(start),
			ErrorClass: class, ClientAddr: r.RemoteAddr,
		})
		return
	}

	// The upstream proxy is local and authenticated, but keep the deadline and
	// header cap so a broken broker cannot hold a connection forever.
	_ = upstream.SetDeadline(time.Now().Add(runtime.cfg.Timeouts.UpstreamHeader.Duration()))
	connectRequest := fmt.Sprintf(
		"CONNECT %s HTTP/1.1\r\nHost: %s\r\nProxy-Authorization: %s\r\n\r\n",
		authority, authority, proxyAuthorization(route.route.AgentToken(), route.route.Vault),
	)
	if _, err := io.WriteString(upstream, connectRequest); err != nil {
		_ = upstream.Close()
		status, class := classifyUpstreamError(err)
		writeProxyError(w, status, "upstream unavailable")
		s.logAccess(accessLog{
			ConnID: id, Kind: "connect", Route: route.route.Name, Vault: route.route.Vault,
			Host: host, Port: port, Status: status, Duration: time.Since(start),
			ErrorClass: class, ClientAddr: r.RemoteAddr,
		})
		return
	}

	headerLimit := int64(runtime.cfg.Limits.MaxHeaderBytes + runtime.cfg.Limits.MaxErrorBodyBytes + 32*1024)
	limited := &limitReader{reader: upstream, remaining: headerLimit}
	reader := bufio.NewReaderSize(limited, 32*1024)
	request := &http.Request{
		Method: http.MethodConnect,
		URL:    &url.URL{Host: authority},
		Host:   authority,
	}
	response, err := http.ReadResponse(reader, request)
	if err != nil {
		_ = upstream.Close()
		status, class := classifyUpstreamError(err)
		writeProxyError(w, status, "invalid upstream response")
		s.logAccess(accessLog{
			ConnID: id, Kind: "connect", Route: route.route.Name, Vault: route.route.Vault,
			Host: host, Port: port, Status: status, Duration: time.Since(start),
			ErrorClass: class, ClientAddr: r.RemoteAddr,
		})
		return
	}

	// After the response head, the same reader carries either an error body or
	// the tunnel. Remove the header phase limit before any body or tunnel read.
	limited.remaining = math.MaxInt64

	if response.StatusCode != http.StatusOK {
		writeUpstreamError(w, response, int64(runtime.cfg.Limits.MaxErrorBodyBytes))
		_ = response.Body.Close()
		_ = upstream.Close()
		s.logAccess(accessLog{
			ConnID: id, Kind: "connect", Route: route.route.Name, Vault: route.route.Vault,
			Host: host, Port: port, Status: response.StatusCode, Duration: time.Since(start),
			ErrorClass: "upstream_status", ClientAddr: r.RemoteAddr,
		})
		return
	}

	_ = upstream.SetDeadline(time.Time{})
	hijacker, ok := w.(http.Hijacker)
	if !ok {
		_ = upstream.Close()
		writeProxyError(w, http.StatusInternalServerError, "connection cannot be upgraded")
		s.logAccess(accessLog{
			ConnID: id, Kind: "connect", Route: route.route.Name, Vault: route.route.Vault,
			Host: host, Port: port, Status: http.StatusInternalServerError,
			Duration: time.Since(start), ErrorClass: "tunnel_error", ClientAddr: r.RemoteAddr,
		})
		return
	}

	client, buffered, err := hijacker.Hijack()
	if err != nil {
		_ = upstream.Close()
		s.logAccess(accessLog{
			ConnID: id, Kind: "connect", Route: route.route.Name, Vault: route.route.Vault,
			Host: host, Port: port, Status: http.StatusInternalServerError,
			Duration: time.Since(start), ErrorClass: "tunnel_error", ClientAddr: r.RemoteAddr,
		})
		return
	}
	defer client.Close()
	_ = client.SetDeadline(time.Time{})

	if _, err := buffered.WriteString("HTTP/1.1 200 Connection Established\r\n\r\n"); err != nil {
		_ = upstream.Close()
		s.logAccess(accessLog{
			ConnID: id, Kind: "connect", Route: route.route.Name, Vault: route.route.Vault,
			Host: host, Port: port, Status: http.StatusBadGateway,
			Duration: time.Since(start), ErrorClass: "tunnel_error", ClientAddr: r.RemoteAddr,
		})
		return
	}
	if err := buffered.Flush(); err != nil {
		_ = upstream.Close()
		s.logAccess(accessLog{
			ConnID: id, Kind: "connect", Route: route.route.Name, Vault: route.route.Vault,
			Host: host, Port: port, Status: http.StatusBadGateway,
			Duration: time.Since(start), ErrorClass: "tunnel_error", ClientAddr: r.RemoteAddr,
		})
		return
	}

	tunnel := &tunnel{id: id, client: client, upstream: upstream}
	if !s.addTunnel(tunnel) {
		tunnel.close()
		s.logAccess(accessLog{
			ConnID: id, Kind: "connect", Route: route.route.Name, Vault: route.route.Vault,
			Host: host, Port: port, Status: http.StatusServiceUnavailable,
			Duration: time.Since(start), ErrorClass: "shutdown", ClientAddr: r.RemoteAddr,
		})
		return
	}
	defer s.removeTunnel(tunnel)

	bytesIn, bytesOut, class := runTunnel(
		client, upstream,
		buffered.Reader, reader,
		runtime.cfg.Timeouts.Idle.Duration(),
	)
	tunnel.close()

	s.logAccess(accessLog{
		ConnID: id, Kind: "connect", Route: route.route.Name, Vault: route.route.Vault,
		Host: host, Port: port, Status: http.StatusOK, Duration: time.Since(start),
		BytesIn: bytesIn, BytesOut: bytesOut, ErrorClass: class, ClientAddr: r.RemoteAddr,
	})
}

func connectAuthority(r *http.Request) string {
	// For CONNECT, the request-target is authority-form and belongs in URL.Host.
	// Prefer it over the Host header so the target cannot be changed by a
	// mismatched header.
	if r.URL != nil && r.URL.Host != "" {
		return r.URL.Host
	}
	if r.Host != "" {
		return r.Host
	}
	return r.RequestURI
}

func parseAuthority(authority string) (string, int, error) {
	if authority == "" {
		return "", 0, errors.New("missing authority")
	}
	host, portText, err := net.SplitHostPort(authority)
	if err != nil {
		return "", 0, err
	}
	port, err := strconv.Atoi(portText)
	if err != nil || port < 1 || port > 65535 {
		return "", 0, errors.New("invalid port")
	}
	normalized, err := config.NormalizeHost(host)
	if err != nil {
		return "", 0, err
	}
	return normalized, port, nil
}

func authenticate(r *http.Request, auth config.ClientAuth) (bool, string) {
	header := strings.TrimSpace(r.Header.Get("Proxy-Authorization"))
	if header == "" {
		return false, "client_auth_missing"
	}
	username, password, ok := parseProxyBasic(header)
	if !ok {
		return false, "client_auth_invalid"
	}
	if subtle.ConstantTimeCompare([]byte(username), []byte(auth.Username)) != 1 {
		return false, "client_auth_invalid"
	}
	for _, candidate := range auth.Passwords() {
		if subtle.ConstantTimeCompare([]byte(password), []byte(candidate)) == 1 {
			return true, ""
		}
	}
	return false, "client_auth_invalid"
}

func parseProxyBasic(header string) (string, string, bool) {
	const prefix = "basic "
	if len(header) < len(prefix) || !strings.EqualFold(header[:len(prefix)], prefix) {
		return "", "", false
	}
	encoded := strings.TrimSpace(header[len(prefix):])
	decoded, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		decoded, err = base64.RawStdEncoding.DecodeString(encoded)
	}
	if err != nil {
		return "", "", false
	}
	username, password, ok := strings.Cut(string(decoded), ":")
	if !ok || username == "" {
		return "", "", false
	}
	return username, password, true
}

func proxyAuthorization(agentToken, vault string) string {
	return "Basic " + base64.StdEncoding.EncodeToString([]byte(agentToken+":"+vault))
}

func writeProxyError(w http.ResponseWriter, status int, message string) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("Connection", "close")
	if status == http.StatusProxyAuthRequired {
		w.Header().Set("Proxy-Authenticate", `Basic realm="agent-egress-router"`)
	}
	if status == http.StatusServiceUnavailable {
		w.Header().Set("Retry-After", "1")
	}
	w.WriteHeader(status)
	if message != "" {
		_, _ = io.WriteString(w, message+"\n")
	}
}
