FROM oven/bun:latest AS build
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile
ENV NEXT_TELEMETRY_DISABLED=1
RUN BETTER_AUTH_SECRET="$(bun -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))')" \
    BETTER_AUTH_URL=http://localhost:3000 \
    bun run build

FROM oven/bun:latest
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 NIMBUS_DATA_ROOT=/data NIMBUS_CONFIG_ROOT=/config PORT=3000
# Application files stay owned by root and read-only to the PUID:PGID the server runs as.
COPY --from=build /app /app
COPY --chmod=755 scripts/docker-entrypoint.sh /usr/local/bin/nimbus-entrypoint
RUN mkdir /data /config && chown 1000:1000 /data /config
WORKDIR /app/apps/web
EXPOSE 3000
VOLUME ["/data", "/config"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD bun -e 'fetch("http://127.0.0.1:3000/api/health").then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))'
ENTRYPOINT ["nimbus-entrypoint"]
CMD ["bun", "server/start.ts"]
