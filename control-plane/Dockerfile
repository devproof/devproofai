# syntax=docker/dockerfile:1
# Build from the REPO ROOT (src/main.ts reads ../../catalog/*.yaml):
#   docker build -f control-plane/Dockerfile -t devproof/control-plane:dev .
# Deterministic: base + npm pinned by digest/version, deps by package-lock.
FROM node:26-slim@sha256:e6bedef217677b276c591795e169840edd9096dbf13f29df8ef8d1856b8820bc
# node:26 bundles npm 11.20.0; pin the latest npm explicitly.
RUN npm install -g npm@12.2.2
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
