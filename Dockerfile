FROM oven/bun:1.4.1 AS build
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile
ENV NEXT_TELEMETRY_DISABLED=1
RUN BETTER_AUTH_SECRET="$(bun -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))')" \
    BETTER_AUTH_URL=http://localhost:3000 \
    bun run build

FROM oven/bun:1.4.1
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 NIMBUS_DATA_ROOT=/data PORT=3000
COPY --from=build --chown=bun:bun /app /app
RUN mkdir /data && chown bun:bun /data
USER bun
WORKDIR /app/apps/web
EXPOSE 3000
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD bun -e 'fetch("http://127.0.0.1:3000/api/health").then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))'
CMD ["bun", "server/start.ts"]
