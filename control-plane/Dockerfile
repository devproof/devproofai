# syntax=docker/dockerfile:1
# Build from the REPO ROOT (src/main.ts reads ../../catalog/*.yaml):
#   docker build -f control-plane/Dockerfile -t devproof/control-plane:dev .
# Deterministic: base pinned by digest, deps by package-lock via npm ci.
FROM node:22-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3
WORKDIR /app/control-plane
COPY control-plane/package.json control-plane/package-lock.json ./
# npm ci with dev deps: tsx (the runtime) is a devDependency.
RUN npm ci
COPY control-plane/tsconfig.json ./
COPY control-plane/src ./src
COPY control-plane/sql ./sql
COPY catalog /app/catalog
ARG DEVPROOF_VERSION=dev
ENV DEVPROOF_VERSION=${DEVPROOF_VERSION} NODE_ENV=production
EXPOSE 7080
CMD ["npx", "tsx", "src/main.ts"]
