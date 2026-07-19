# syntax=docker/dockerfile:1
# Build: docker build -t devproof/operator:dev operator
# Deterministic: base pinned by digest, deps by go.sum, -trimpath build.
FROM golang:1.26-bookworm@sha256:1ecb7edf62a0408027bd5729dfd6b1b8766e578e8df93995b225dfd0944eb651 AS build
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

FROM gcr.io/distroless/static-debian12:nonroot@sha256:aef9602f8710ec12bde19d593fed1f76c708531bb7aba205110f1029786ead7b
COPY --from=build /out/devproof-operator /devproof-operator
ARG DEVPROOF_VERSION=dev
ENV DEVPROOF_VERSION=${DEVPROOF_VERSION}
ENTRYPOINT ["/devproof-operator"]
