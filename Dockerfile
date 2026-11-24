# Video thumbnails need one frame decoded; a trimmed static LGPL FFmpeg does
# that in ~13 MB instead of Debian's ~450 MB ffmpeg package. AV1 decodes through
# a static dav1d (BSD-2-Clause), which adds ~2 MB. Bump the versions and
# checksums for FFmpeg and dav1d security releases.
FROM debian:trixie-slim@sha256:a72b4433de1cf7d6bae0c4cee74d0547f58601a643b3375f070c51600d63b6b2 AS ffmpeg
ARG FFMPEG_VERSION=9.0.2
ARG FFMPEG_SHA256=8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e
ARG DAV1D_VERSION=1.5.4
ARG DAV1D_SHA256=686616b7c69eb88d44459391ab25cac13b6647a3b288835c5784e71c1514a5c5
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential ca-certificates curl meson nasm ninja-build pkg-config xz-utils \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
RUN curl -fsSLo dav1d.tar.xz "https://downloads.videolan.org/pub/videolan/dav1d/${DAV1D_VERSION}/dav1d-${DAV1D_VERSION}.tar.xz" \
    && echo "${DAV1D_SHA256}  dav1d.tar.xz" | sha256sum -c - \
    && mkdir dav1d && tar -xJf dav1d.tar.xz -C dav1d --strip-components=1 \
    && meson setup dav1d/build dav1d --buildtype=release --default-library=static --prefix=/opt/dav1d --libdir=lib \
        -Denable_tools=false -Denable_tests=false -Denable_examples=false -Dbitdepths=8,16 \
    && ninja -C dav1d/build install
RUN curl -fsSLo ffmpeg.tar.xz "https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.xz" \
    && echo "${FFMPEG_SHA256}  ffmpeg.tar.xz" | sha256sum -c - \
    && tar -xJf ffmpeg.tar.xz --strip-components=1 \
    && PKG_CONFIG_PATH=/opt/dav1d/lib/pkgconfig ./configure --pkg-config-flags=--static \
        --disable-autodetect --disable-everything --disable-network --disable-doc --disable-debug \
        --disable-ffplay --disable-ffprobe --enable-ffmpeg --enable-swscale --enable-static --disable-shared \
        --enable-protocol=file,pipe \
        --enable-demuxer=mov,matroska,ogg \
        --enable-libdav1d \
        --enable-decoder=h264,hevc,vp8,vp9,mpeg4,mjpeg,prores,theora,libdav1d \
        --enable-parser=h264,hevc,vp8,vp9,mpeg4video,av1 \
        --enable-filter=scale,format,transpose,hflip,vflip,pad,setsar \
        --enable-muxer=rawvideo --enable-encoder=rawvideo \
        --extra-ldflags=-static \
    && make -j"$(nproc)" ffmpeg \
    && strip ffmpeg

FROM oven/bun:1.4.4@sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d AS build
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile
RUN bun run build
# The server runs from source with Bun; it needs only production dependencies and the built client.
RUN rm -rf node_modules apps/*/node_modules packages/*/node_modules .turbo apps/*/.turbo packages/*/.turbo \
    && bun install --frozen-lockfile --production
# Which build this is, so it can take part in in-app updates (docs/updates.md). CI passes these;
# an image built without them has no build metadata and looks for no update.
ARG NIMBUS_REPOSITORY=""
ARG NIMBUS_COMMIT=""
ARG NIMBUS_SEQUENCE=""
ARG NIMBUS_CHANNEL=""
ARG NIMBUS_IMAGE=""
RUN if [ -n "$NIMBUS_SEQUENCE" ]; then \
      printf '{"repository":"%s","commit":"%s","sequence":%s,"channel":"%s","image":"%s"}\n' \
        "$NIMBUS_REPOSITORY" "$NIMBUS_COMMIT" "$NIMBUS_SEQUENCE" "$NIMBUS_CHANNEL" "$NIMBUS_IMAGE" \
        > apps/web/build-info.json; \
    fi

FROM oven/bun:1.4.4@sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d
# pdftoppm renders PDF thumbnails; Debian ships its security updates.
RUN apt-get update \
    && apt-get install -y --no-install-recommends poppler-utils \
    && rm -rf /var/lib/apt/lists/*
COPY --from=ffmpeg /src/ffmpeg /usr/local/bin/ffmpeg
COPY --from=ffmpeg /src/LICENSE.md /src/COPYING.LGPLv2.1 /usr/local/share/licenses/ffmpeg/
COPY --from=ffmpeg /src/dav1d/COPYING /usr/local/share/licenses/dav1d/
WORKDIR /app
ENV NODE_ENV=production NIMBUS_DATA_ROOT=/data NIMBUS_CONFIG_ROOT=/config PORT=3000
# Application files stay owned by root and read-only to the PUID:PGID the server runs as.
COPY --from=build /app /app
COPY --chmod=755 scripts/docker-entrypoint.sh /usr/local/bin/nimbus-entrypoint
RUN mkdir /data /config && chown 1000:1000 /data /config
# In-app updates (docs/updates.md): a user of their own for the installer, with no login and no
# process but an install's, and the store installed releases live in. The store and its releases
# are root's; only staging, where the installer unpacks, is the update user's, and closed to the
# servers' user. Mount a volume at /var/lib/nimbus to keep installed releases across recreation.
RUN groupadd --system --gid 1100 nimbus-update \
    && useradd --system --uid 1100 --gid 1100 --no-create-home --home-dir /nonexistent \
       --shell /usr/sbin/nologin nimbus-update \
    && install -d -o root -g root -m 755 /var/lib/nimbus /var/lib/nimbus/releases \
    && install -d -o 1100 -g root -m 750 /var/lib/nimbus/staging
WORKDIR /app/apps/web
EXPOSE 3000
VOLUME ["/data", "/config"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD bun -e 'fetch(`http://127.0.0.1:${process.env.PORT || 3000}/api/health`).then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))'
ENTRYPOINT ["nimbus-entrypoint"]
# The supervisor runs the server and can replace it with a fresh one without closing the port:
# `docker exec <container> bun server/supervisor/control.ts restart`. See the README's
# "Restarts without downtime".
CMD ["bun", "server/supervisor/main.ts"]
