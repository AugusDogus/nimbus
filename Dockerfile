# Video thumbnails need one frame decoded; a trimmed static LGPL FFmpeg does
# that in ~10 MB instead of Debian's ~450 MB ffmpeg package. Bump the version
# and checksum for FFmpeg security releases.
FROM debian:trixie-slim AS ffmpeg
ARG FFMPEG_VERSION=9.0.2
ARG FFMPEG_SHA256=8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential ca-certificates curl nasm xz-utils \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
RUN curl -fsSLo ffmpeg.tar.xz "https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.xz" \
    && echo "${FFMPEG_SHA256}  ffmpeg.tar.xz" | sha256sum -c - \
    && tar -xJf ffmpeg.tar.xz --strip-components=1 \
    && ./configure --disable-autodetect --disable-everything --disable-network --disable-doc --disable-debug \
        --disable-ffplay --disable-ffprobe --enable-ffmpeg --enable-swscale --enable-static --disable-shared \
        --enable-protocol=file,pipe \
        --enable-demuxer=mov,matroska,ogg \
        --enable-decoder=h264,hevc,vp8,vp9,mpeg4,mjpeg,prores,theora \
        --enable-parser=h264,hevc,vp8,vp9,mpeg4video \
        --enable-filter=scale,format,transpose,hflip,vflip,pad,setsar \
        --enable-muxer=rawvideo --enable-encoder=rawvideo \
        --extra-ldflags=-static \
    && make -j"$(nproc)" ffmpeg \
    && strip ffmpeg

FROM oven/bun:1.4.4@sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d AS build
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile
RUN BETTER_AUTH_SECRET="$(bun -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))')" \
    BETTER_AUTH_URL=http://localhost:3000 \
    bun run build

FROM oven/bun:1.4.4@sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d
# pdftoppm renders PDF thumbnails; Debian ships its security updates.
RUN apt-get update \
    && apt-get install -y --no-install-recommends poppler-utils \
    && rm -rf /var/lib/apt/lists/*
COPY --from=ffmpeg /src/ffmpeg /usr/local/bin/ffmpeg
WORKDIR /app
ENV NODE_ENV=production NIMBUS_DATA_ROOT=/data NIMBUS_CONFIG_ROOT=/config PORT=3000
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
