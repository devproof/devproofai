# syntax=docker/dockerfile:1
# Build: docker build -t devproof/operator:dev operator
# Deterministic: base pinned by digest, deps by go.sum, -trimpath build.
FROM golang:1.27-trixie@sha256:f18c3d73a184fb0582828510722e723b63a93f7188d11dd223d9be6f6880e65d AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY api ./api
COPY cmd ./cmd
COPY internal ./internal
ARG DEVPROOF_VERSION=dev
RUN CGO_ENABLED=0 go build -trimpath \
      -ldflags "-s -w -X main.version=${DEVPROOF_VERSION}" \
      -o /out/devproof-operator ./cmd

FROM gcr.io/distroless/static-debian13:nonroot@sha256:aafe993665bf6200db38a02c11a9351e782a84b6a45e7f33b6695638c88e3931
COPY --from=build /out/devproof-operator /devproof-operator
ARG DEVPROOF_VERSION=dev
ENV DEVPROOF_VERSION=${DEVPROOF_VERSION}
ENTRYPOINT ["/devproof-operator"]
