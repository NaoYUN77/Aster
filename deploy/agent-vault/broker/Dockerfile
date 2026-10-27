# All source selection and patching use repository-owned instructions. Upstream
# Dockerfiles, Makefiles, install scripts and toolchain directives are not run.
FROM node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df AS source
WORKDIR /audit
COPY prepare.mjs /audit/prepare.mjs
RUN node /audit/prepare.mjs

FROM source AS frontend
WORKDIR /reviewed/web
RUN npm ci --ignore-scripts --no-audit --no-fund
RUN npm run build

# Using the existing pinned Node base avoids an additional Docker Hub Go image.
# The official Go archive is verified before extraction; automatic Go upgrades
# are forbidden, so a dependency requiring a later compiler fails the build.
FROM source AS builder
ARG TARGETARCH=amd64
WORKDIR /audit
RUN node --input-type=module -e 'import {createHash} from "node:crypto"; import {writeFile} from "node:fs/promises"; const arch=process.argv[1]; const sums={amd64:"f022b6aad78e362bcba9b0b94d09ad58c5a70c6ba3b7582905fababf5fe0181a",arm64:"738ef87d79c34272424ccdf83302b7b0300b8b096ed443896089306117943dd5"}; if(!sums[arch])throw Error("unsupported Go architecture"); const r=await fetch(`https://go.dev/dl/go1.25.6.linux-${arch}.tar.gz`,{signal:AbortSignal.timeout(180000)}); if(!r.ok)throw Error("Go download failed"); const b=Buffer.from(await r.arrayBuffer()); if(createHash("sha256").update(b).digest("hex")!==sums[arch])throw Error("Go checksum mismatch"); await writeFile("/audit/go.tar.gz",b);' "$TARGETARCH"
RUN tar -C /usr/local -xzf /audit/go.tar.gz && rm /audit/go.tar.gz
ENV PATH="/usr/local/go/bin:$PATH" GOTOOLCHAIN=local CGO_ENABLED=0
# git apply checks exact hunk context and exits nonzero on mismatch (no fuzz).
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
COPY upstream.patch /audit/upstream.patch
RUN git -C /reviewed apply --check /audit/upstream.patch && git -C /reviewed apply /audit/upstream.patch
COPY infisical_security.go.in /reviewed/internal/infisical/infisical_security.go
COPY infisical_security_test.go.in /reviewed/internal/infisical/infisical_security_test.go
COPY api_policy.go.in /reviewed/internal/mitm/api_policy.go
COPY api_policy_test.go.in /reviewed/internal/mitm/api_policy_test.go
WORKDIR /reviewed
RUN go mod download && go mod verify
RUN go test -count=1 -timeout=120s ./internal/infisical
# Run upstream regressions with explicit operation policies alongside the
# reviewed gate tests. Verbose output keeps policy-incompatible skips visible.
RUN go test -v -count=1 -timeout=120s ./internal/mitm && go vet ./internal/mitm
COPY --from=frontend /reviewed/internal/server/webdist /reviewed/internal/server/webdist
RUN go build -mod=readonly -trimpath -ldflags="-s -w -X github.com/Infisical/agent-vault/cmd.version=0.40.0-reviewed -X github.com/Infisical/agent-vault/cmd.commit=872578e4cdf9e03d5e3bcb5512023a70bf90ed65 -X github.com/Infisical/agent-vault/cmd.date=2026-10-01T06:04:43Z" -o /audit/agent-vault .

# The release image supplies only the unchanged runtime, CA roots, account and
# entrypoint. Its embedded frontend cannot be copied independently, therefore
# the new binary embeds the fixed source frontend built above with Node 24.
FROM infisical/agent-vault:0.40.0@sha256:4d490e2586c553ea121fa404b66812ad40c246cc841b0cc746682d0a360bdf1e AS runtime
# Upstream precreates this directory as 0755; MkdirAll at startup does not
# tighten existing permissions. Existing volumes still require an offline check.
RUN chmod 0700 /data/.agent-vault
COPY --from=builder /audit/agent-vault /usr/local/bin/agent-vault
LABEL org.opencontainers.image.version="0.40.0-reviewed" \
      org.opencontainers.image.revision="872578e4cdf9e03d5e3bcb5512023a70bf90ed65" \
      org.opencontainers.image.source="https://github.com/Infisical/agent-vault"
