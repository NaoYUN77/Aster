package proxy

import (
	"errors"
	"io"
	"net"
	"sync"
	"sync/atomic"
	"time"
)

type tunnel struct {
	id       string
	client   net.Conn
	upstream net.Conn
	once     sync.Once
}

func (t *tunnel) close() {
	t.once.Do(func() {
		_ = t.client.Close()
		_ = t.upstream.Close()
	})
}

type copyDirection int

const (
	clientToUpstream copyDirection = iota
	upstreamToClient
)

type copyResult struct {
	direction copyDirection
	bytes     int64
	err       error
}

// runTunnel copies bytes in both directions. A shared activity deadline is
// refreshed on any read or write, so a long-lived streaming response is not
// killed by an idle timer on the other direction. EOF in one direction is
// propagated with CloseWrite; a real error closes both sides.
func runTunnel(
	client net.Conn,
	upstream net.Conn,
	clientReader io.Reader,
	upstreamReader io.Reader,
	idle time.Duration,
) (bytesIn int64, bytesOut int64, class string) {
	touchEvery := 100 * time.Millisecond
	if idle < 4*touchEvery {
		touchEvery = idle / 4
		if touchEvery <= 0 {
			touchEvery = time.Millisecond
		}
	}
	var lastTouch atomic.Int64
	touch := func() {
		now := time.Now().UnixNano()
		previous := lastTouch.Load()
		if previous != 0 && now-previous < int64(touchEvery) {
			return
		}
		if lastTouch.CompareAndSwap(previous, now) {
			deadline := time.Now().Add(idle)
			_ = client.SetDeadline(deadline)
			_ = upstream.SetDeadline(deadline)
		}
	}
	touch()

	results := make(chan copyResult, 2)
	go func() {
		bytes, err := copyDirectionWithActivity(upstream, clientReader, touch)
		results <- copyResult{direction: clientToUpstream, bytes: bytes, err: err}
	}()
	go func() {
		bytes, err := copyDirectionWithActivity(client, upstreamReader, touch)
		results <- copyResult{direction: upstreamToClient, bytes: bytes, err: err}
	}()

	var first copyResult
	var hadError bool
	var timedOut bool
	for index := 0; index < 2; index++ {
		result := <-results
		if index == 0 {
			first = result
			if result.err == nil {
				if result.direction == clientToUpstream {
					closeWrite(upstream)
				} else {
					closeWrite(client)
				}
			} else {
				_ = client.Close()
				_ = upstream.Close()
			}
		}
		if result.direction == clientToUpstream {
			bytesIn = result.bytes
		} else {
			bytesOut = result.bytes
		}
		if result.err != nil {
			hadError = true
			var netErr net.Error
			if errors.As(result.err, &netErr) && netErr.Timeout() {
				timedOut = true
			}
		}
	}

	switch {
	case timedOut:
		class = "idle_timeout"
	case hadError:
		class = "tunnel_error"
	case first.direction == clientToUpstream:
		class = "tunnel_client_closed"
	default:
		class = "tunnel_upstream_closed"
	}
	return bytesIn, bytesOut, class
}

func copyDirectionWithActivity(destination io.Writer, source io.Reader, touch func()) (int64, error) {
	buffer := make([]byte, 32*1024)
	var total int64
	for {
		read, readErr := source.Read(buffer)
		if read > 0 {
			touch()
			written, writeErr := destination.Write(buffer[:read])
			total += int64(written)
			if writeErr != nil {
				return total, writeErr
			}
			if written != read {
				return total, io.ErrShortWrite
			}
			touch()
		}
		if readErr != nil {
			if errors.Is(readErr, io.EOF) {
				return total, nil
			}
			return total, readErr
		}
	}
}

type closeWriter interface {
	CloseWrite() error
}

func closeWrite(conn net.Conn) {
	if writer, ok := conn.(closeWriter); ok {
		_ = writer.CloseWrite()
		return
	}
	_ = conn.Close()
}
