package proxy

import (
	"errors"
	"io"
	"net"
	"net/http"
	"strings"
)

var errHeaderTooLarge = errors.New("upstream response header too large")

// limitReader bounds the response head read by http.ReadResponse. Its limit is
// lifted after the head is parsed so the same bufio.Reader can carry the
// tunnel or a capped error body.
type limitReader struct {
	reader    io.Reader
	remaining int64
}

func (l *limitReader) Read(p []byte) (int, error) {
	if l.remaining <= 0 {
		return 0, errHeaderTooLarge
	}
	if int64(len(p)) > l.remaining {
		p = p[:l.remaining]
	}
	n, err := l.reader.Read(p)
	l.remaining -= int64(n)
	return n, err
}

func classifyDialError(err error) (int, string) {
	var netErr net.Error
	if errors.As(err, &netErr) && netErr.Timeout() {
		return http.StatusGatewayTimeout, "upstream_dial_timeout"
	}
	return http.StatusBadGateway, "upstream_dial_failed"
}

func classifyUpstreamError(err error) (int, string) {
	if errors.Is(err, errHeaderTooLarge) {
		return http.StatusBadGateway, "upstream_header_invalid"
	}
	var netErr net.Error
	if errors.As(err, &netErr) && netErr.Timeout() {
		return http.StatusGatewayTimeout, "upstream_header_timeout"
	}
	return http.StatusBadGateway, "upstream_protocol_error"
}

func writeUpstreamError(w http.ResponseWriter, response *http.Response, maxBody int64) {
	copyHeader(w.Header(), response.Header)
	removeHopByHop(w.Header())
	encoding := w.Header().Get("Content-Encoding")
	// The body is deliberately truncated, so the original length and encoding
	// must not be advertised to the client. A compressed error body cannot be
	// safely truncated; keep the status and authentication headers instead.
	w.Header().Del("Content-Length")
	w.Header().Del("Content-Encoding")
	w.Header().Set("Connection", "close")
	w.WriteHeader(response.StatusCode)
	if maxBody > 0 && (encoding == "" || strings.EqualFold(encoding, "identity")) {
		_, _ = io.CopyN(w, response.Body, maxBody)
	}
}

func copyHeader(destination, source http.Header) {
	for key, values := range source {
		for _, value := range values {
			destination.Add(key, value)
		}
	}
}

func removeHopByHop(header http.Header) {
	for _, connection := range header.Values("Connection") {
		for _, token := range strings.Split(connection, ",") {
			if token = strings.TrimSpace(token); token != "" {
				header.Del(token)
			}
		}
	}
	for _, name := range []string{
		"Connection",
		"Keep-Alive",
		"Proxy-Connection",
		"TE",
		"Trailer",
		"Transfer-Encoding",
		"Upgrade",
	} {
		header.Del(name)
	}
}
