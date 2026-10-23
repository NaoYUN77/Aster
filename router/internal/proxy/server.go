package proxy

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	stdlog "log"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/NaoYUN77/personal-agent-base-durable/router/internal/config"
	"github.com/NaoYUN77/personal-agent-base-durable/router/internal/redact"
	"github.com/NaoYUN77/personal-agent-base-durable/router/internal/version"
)

type routeKey struct {
	host string
	port int
}

type routeRuntime struct {
	route config.Route
	sem   chan struct{}
}

type runtimeConfig struct {
	cfg       *config.Config
	routes    map[routeKey]*routeRuntime
	globalSem chan struct{}
}

func buildRuntime(cfg *config.Config) *runtimeConfig {
	runtime := &runtimeConfig{
		cfg:       cfg,
		routes:    make(map[routeKey]*routeRuntime, len(cfg.Routes)),
		globalSem: make(chan struct{}, cfg.Limits.MaxConnections),
	}
	for _, route := range cfg.Routes {
		runtime.routes[routeKey{host: route.Host, port: route.Port}] = &routeRuntime{
			route: route,
			sem:   make(chan struct{}, cfg.Limits.MaxConnectionsPerRoute),
		}
	}
	return runtime
}

type Server struct {
	logger *slog.Logger

	runtime atomic.Pointer[runtimeConfig]

	httpServer   *http.Server
	healthServer *http.Server
	healthLn     net.Listener

	shuttingDown atomic.Bool

	tunnelMu  sync.Mutex
	tunnelsWG sync.WaitGroup
	tunnels   sync.Map // conn id -> *tunnel
}

func New(cfg *config.Config, logger *slog.Logger) *Server {
	if logger == nil {
		logger = slog.Default()
	}
	server := &Server{logger: logger}
	server.runtime.Store(buildRuntime(cfg))
	server.httpServer = &http.Server{
		Handler:           server,
		ReadHeaderTimeout: cfg.Timeouts.ClientHeader.Duration(),
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    cfg.Limits.MaxHeaderBytes,
		ErrorLog:          stdlog.New(redactingLogWriter{logger: logger}, "", 0),
		ConnContext: func(ctx context.Context, _ net.Conn) context.Context {
			return context.WithValue(ctx, connIDKey{}, newConnID())
		},
	}
	return server
}

// Serve serves the proxy on an already-bound listener. Tests use this to bind
// an ephemeral loopback port without changing the production config schema.
func (s *Server) Serve(listener net.Listener) error {
	return s.httpServer.Serve(listener)
}

func (s *Server) ListenAndServe() error {
	cfg := s.runtime.Load().cfg
	listener, err := net.Listen("tcp", cfg.Listen)
	if err != nil {
		return fmt.Errorf("listen %s: %w", cfg.Listen, err)
	}
	if cfg.HealthListen != "" {
		if err := s.startHealth(cfg.HealthListen); err != nil {
			_ = listener.Close()
			return err
		}
	}
	err = s.httpServer.Serve(listener)
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}

func (s *Server) startHealth(addr string) error {
	listener, err := net.Listen("tcp", addr)
	if err != nil {
		return fmt.Errorf("listen health %s: %w", addr, err)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", s.handleHealth)
	mux.HandleFunc("/readyz", s.handleHealth)
	s.healthLn = listener
	s.healthServer = &http.Server{
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
	}
	go func() {
		if err := s.healthServer.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
			s.logger.Error("health server stopped", "error_class", "health_server_error")
		}
	}()
	return nil
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	runtime := s.runtime.Load()
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"status":  "ok",
		"routes":  len(runtime.routes),
		"version": version.Version,
	})
}

// Shutdown stops accepting connections, waits up to ctx for active tunnels,
// then closes whatever remains. Hijacked CONNECT tunnels are tracked here
// because http.Server.Shutdown does not manage them.
func (s *Server) Shutdown(ctx context.Context) error {
	s.shuttingDown.Store(true)

	// Wait for any in-flight addTunnel call to finish. After this barrier no new
	// tunnel can call WaitGroup.Add while we are waiting.
	s.tunnelMu.Lock()
	s.tunnelMu.Unlock()

	var errs []error
	if s.healthServer != nil {
		if err := s.healthServer.Shutdown(ctx); err != nil {
			errs = append(errs, err)
		}
	}
	if err := s.httpServer.Shutdown(ctx); err != nil {
		errs = append(errs, err)
	}

	done := make(chan struct{})
	go func() {
		s.tunnelsWG.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-ctx.Done():
		s.closeTunnels()
		<-done
	}
	return errors.Join(errs...)
}

func (s *Server) addTunnel(t *tunnel) bool {
	s.tunnelMu.Lock()
	defer s.tunnelMu.Unlock()
	if s.shuttingDown.Load() {
		return false
	}
	s.tunnelsWG.Add(1)
	s.tunnels.Store(t.id, t)
	return true
}

func (s *Server) removeTunnel(t *tunnel) {
	s.tunnels.Delete(t.id)
	s.tunnelsWG.Done()
}

func (s *Server) closeTunnels() {
	s.tunnels.Range(func(_, value any) bool {
		if t, ok := value.(*tunnel); ok {
			t.close()
		}
		return true
	})
}

// Reload atomically replaces routes and credentials. Listener, upstream,
// timeout, limit and log changes require a restart because the http.Server and
// logger are constructed once.
func (s *Server) Reload(path string) error {
	if s.shuttingDown.Load() {
		return errors.New("server is shutting down")
	}
	cfg, err := config.Load(path)
	if err != nil {
		return err
	}
	old := s.runtime.Load().cfg
	if cfg.Listen != old.Listen ||
		cfg.UpstreamProxy != old.UpstreamProxy ||
		cfg.HealthListen != old.HealthListen ||
		cfg.Timeouts != old.Timeouts ||
		cfg.Limits != old.Limits ||
		cfg.Log != old.Log {
		return errors.New("reload changes listener, upstream, health, timeouts, limits or logging; restart required")
	}
	s.runtime.Store(buildRuntime(cfg))
	s.logger.Info("configuration reloaded", "routes", len(cfg.Routes))
	return nil
}

type accessLog struct {
	ConnID     string
	Kind       string
	Route      string
	Vault      string
	Host       string
	Port       int
	Status     int
	Duration   time.Duration
	BytesIn    int64
	BytesOut   int64
	ErrorClass string
	ClientAddr string
}

func (s *Server) logAccess(entry accessLog) {
	runtime := s.runtime.Load()
	if runtime == nil || !runtime.cfg.Log.Access {
		return
	}
	level := slog.LevelInfo
	if entry.Status >= 400 {
		level = slog.LevelWarn
	}
	attrs := []slog.Attr{
		slog.String("event", "proxy"),
		slog.String("conn_id", redact.String(entry.ConnID)),
		slog.String("kind", redact.String(entry.Kind)),
		slog.String("route", redact.String(entry.Route)),
		slog.String("vault", redact.String(entry.Vault)),
		slog.String("target_host", redact.String(entry.Host)),
		slog.Int("target_port", entry.Port),
		slog.Int("status", entry.Status),
		slog.Int64("duration_ms", entry.Duration.Milliseconds()),
		slog.Int64("bytes_in", entry.BytesIn),
		slog.Int64("bytes_out", entry.BytesOut),
		slog.String("client_addr", redact.String(entry.ClientAddr)),
	}
	if entry.ErrorClass != "" {
		attrs = append(attrs, slog.String("error_class", redact.String(entry.ErrorClass)))
	}
	s.logger.LogAttrs(context.Background(), level, "proxy", attrs...)
}

type redactingLogWriter struct {
	logger *slog.Logger
}

func (w redactingLogWriter) Write(data []byte) (int, error) {
	message := strings.TrimSpace(redact.String(string(data)))
	if message != "" {
		w.logger.Warn("http_server", "message", message)
	}
	return len(data), nil
}

type connIDKey struct{}

var connCounter atomic.Uint64

func newConnID() string {
	var value [8]byte
	if _, err := rand.Read(value[:]); err == nil {
		return hex.EncodeToString(value[:])
	}
	return fmt.Sprintf("%016x", connCounter.Add(1))
}

func connIDFromContext(ctx context.Context) string {
	if id, ok := ctx.Value(connIDKey{}).(string); ok && id != "" {
		return id
	}
	return newConnID()
}

func tryAcquire(sem chan struct{}) bool {
	select {
	case sem <- struct{}{}:
		return true
	default:
		return false
	}
}

func release(sem chan struct{}) {
	<-sem
}
