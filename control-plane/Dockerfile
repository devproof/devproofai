# syntax=docker/dockerfile:1
# Build from the REPO ROOT (src/main.ts reads ../../catalog/*.yaml):
#   docker build -f control-plane/Dockerfile -t devproof/control-plane:dev .
# Deterministic: base + npm pinned by digest/version, deps by package-lock.
FROM node:24-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d
# node:24 bundles npm 11.16.0; pin the latest npm explicitly (needs node >=24.15).
RUN npm install -g npm@12.0.1
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
