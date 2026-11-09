# Official Node multi-architecture index, verified against Docker Hub on 2026-10-20.
FROM node:22.23.2-bookworm-slim@sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9 AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

FROM node:22.23.2-bookworm-slim@sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9
LABEL org.opencontainers.image.source="https://github.com/mdub1na/stf" \
      org.opencontainers.image.description="STF per-device ADB tunnel gateway"
WORKDIR /app
COPY --from=dependencies --chown=1000:1000 /app/node_modules ./node_modules
COPY --chown=1000:1000 server.mts gateway.mts access.mts adb-guard.mts types.mts config.example.json ./
USER 1000:1000
EXPOSE 8080
ENTRYPOINT ["node", "/app/server.mts"]
CMD ["--config", "/etc/stf-adb/gateway.json", "--listen", "0.0.0.0:8080"]
