# syntax=docker/dockerfile:1
# Build: docker build -t devproof/console:dev console
# NOTE: next/font/google downloads IBM Plex at build time — needs network
# egress to Google Fonts (documented gap in BUILD.md).
FROM node:22-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# /api rewrite target — baked into the route manifest at build time.
ARG DEVPROOF_API=http://127.0.0.1:7080
ENV DEVPROOF_API=${DEVPROOF_API}
RUN npx next build

FROM node:22-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
ARG DEVPROOF_VERSION=dev
ENV DEVPROOF_VERSION=${DEVPROOF_VERSION} PORT=7090 HOSTNAME=0.0.0.0
EXPOSE 7090
CMD ["node", "server.js"]
