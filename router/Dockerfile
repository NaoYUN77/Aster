FROM golang:1.25.6-bookworm AS build
WORKDIR /src
COPY go.mod ./
COPY cmd ./cmd
COPY internal ./internal
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /agent-egress-router ./cmd/agent-egress-router

FROM debian:bookworm-slim
LABEL org.opencontainers.image.title="Aster egress router"
ENV GOMAXPROCS=2
COPY --from=build /agent-egress-router /usr/local/bin/agent-egress-router
USER 1001:1001
ENTRYPOINT ["agent-egress-router"]
CMD ["serve", "-config", "/etc/aster-router/config.json"]
