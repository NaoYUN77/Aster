package main

import (
	"bufio"
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/signal"
	"strings"
	"syscall"

	"github.com/NaoYUN77/personal-agent-base-durable/router/internal/config"
	"github.com/NaoYUN77/personal-agent-base-durable/router/internal/proxy"
	"github.com/NaoYUN77/personal-agent-base-durable/router/internal/redact"
	"github.com/NaoYUN77/personal-agent-base-durable/router/internal/version"
)

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}
	var err error
	switch os.Args[1] {
	case "serve":
		err = serve(os.Args[2:])
	case "check":
		err = check(os.Args[2:])
	case "redact":
		err = redactStream(os.Args[2:])
	case "version":
		fmt.Println(version.String())
	default:
		usage()
		os.Exit(2)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", redact.String(err.Error()))
		os.Exit(1)
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, `usage: agent-egress-router <command> [flags]

commands:
  serve   -config <path>   run the CONNECT proxy
  check   -config <path>   validate config and credential files
  redact                   redact credential-shaped text from stdin
  version                  print build information`)
}

func serve(args []string) error {
	flags := flag.NewFlagSet("serve", flag.ContinueOnError)
	flags.SetOutput(os.Stderr)
	configPath := flags.String("config", "", "path to egress-router.json")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if *configPath == "" {
		return errors.New("-config is required")
	}

	cfg, err := config.Load(*configPath)
	if err != nil {
		return err
	}
	logger, err := newLogger(cfg.Log)
	if err != nil {
		return err
	}
	server := proxy.New(cfg, logger)
	logger.Info("agent egress router starting",
		"listen", cfg.Listen,
		"upstream", cfg.UpstreamProxy,
		"routes", len(cfg.Routes),
		"version", redact.String(version.String()),
	)

	serveErr := make(chan error, 1)
	go func() {
		serveErr <- server.ListenAndServe()
	}()

	signals := make(chan os.Signal, 1)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM, syscall.Signal(1))
	defer signal.Stop(signals)

	for {
		select {
		case err := <-serveErr:
			if err != nil {
				logger.Error("router stopped", "error_class", "listener_error")
				return err
			}
			return nil
		case sig := <-signals:
			if sig == syscall.Signal(1) {
				if err := server.Reload(*configPath); err != nil {
					logger.Error("configuration reload failed", "error", redact.String(err.Error()))
				}
				continue
			}
			ctx, cancel := context.WithTimeout(context.Background(), cfg.Timeouts.Shutdown.Duration())
			err := server.Shutdown(ctx)
			cancel()
			logger.Info("agent egress router stopped")
			return err
		}
	}
}

func check(args []string) error {
	flags := flag.NewFlagSet("check", flag.ContinueOnError)
	flags.SetOutput(os.Stderr)
	configPath := flags.String("config", "", "path to egress-router.json")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if *configPath == "" {
		return errors.New("-config is required")
	}
	cfg, err := config.Load(*configPath)
	if err != nil {
		return err
	}
	fmt.Printf("configuration OK: %s\n", cfg.Summary())
	return nil
}

func redactStream(args []string) error {
	if len(args) != 0 {
		return errors.New("redact does not accept arguments")
	}
	reader := bufio.NewReader(os.Stdin)
	writer := bufio.NewWriter(os.Stdout)
	defer writer.Flush()
	for {
		line, err := reader.ReadString('\n')
		if line != "" {
			if _, writeErr := writer.WriteString(redact.String(line)); writeErr != nil {
				return writeErr
			}
		}
		if err != nil {
			if errors.Is(err, io.EOF) {
				return nil
			}
			return err
		}
	}
}

func newLogger(cfg config.Log) (*slog.Logger, error) {
	var level slog.Level
	switch cfg.Level {
	case "debug":
		level = slog.LevelDebug
	case "info":
		level = slog.LevelInfo
	case "warn":
		level = slog.LevelWarn
	case "error":
		level = slog.LevelError
	default:
		return nil, fmt.Errorf("unsupported log level %q", cfg.Level)
	}
	options := &slog.HandlerOptions{
		Level: level,
		ReplaceAttr: func(groups []string, attribute slog.Attr) slog.Attr {
			if len(groups) == 0 && attribute.Key == slog.TimeKey {
				attribute.Key = "ts"
			}
			return attribute
		},
	}
	var handler slog.Handler
	switch strings.ToLower(cfg.Format) {
	case "json":
		handler = slog.NewJSONHandler(os.Stderr, options)
	case "text":
		handler = slog.NewTextHandler(os.Stderr, options)
	default:
		return nil, fmt.Errorf("unsupported log format %q", cfg.Format)
	}
	return slog.New(handler), nil
}
