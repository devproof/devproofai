# syntax=docker/dockerfile:1
# Build: docker build -t devproof/console:dev console
# NOTE: next/font/google downloads IBM Plex at build time — needs network
# egress to Google Fonts (documented gap in BUILD.md).
FROM node:24-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS build
# node:24 bundles npm 11.16.0; pin the latest npm explicitly (needs node >=24.15).
RUN npm install -g npm@12.0.1
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# /api rewrite target — baked into the route manifest at build time.
ARG DEVPROOF_API=http://127.0.0.1:7080
ENV DEVPROOF_API=${DEVPROOF_API}
RUN npx next build

FROM node:24-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
ARG DEVPROOF_VERSION=dev
ENV DEVPROOF_VERSION=${DEVPROOF_VERSION} PORT=7090 HOSTNAME=0.0.0.0
EXPOSE 7090
CMD ["node", "server.js"]
