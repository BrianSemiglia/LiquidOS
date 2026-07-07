# The Linux build environment for the LiquidOS desktop packages.
#
# It extends electron-builder's official image (Node + fpm + dpkg — everything
# the AppImage/.deb steps need) with a Go toolchain, so `npm run dist` builds the
# WHOLE artifact — the Go server included — entirely inside Linux. The Linux
# build has no dependency on the host: it runs the same on a Mac (via Colima),
# a Linux box, or CI. See README "Package it".
#
#   docker build -t liquidos-builder electron-app
#   docker run --rm -v "$PWD":/project -w /project/electron-app liquidos-builder npm run dist
FROM electronuserland/builder:latest

# Keep in step with go-server/go.mod's `go` directive.
ARG GO_VERSION=1.26.4
RUN ARCH="$(dpkg --print-architecture)" \
 && curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-${ARCH}.tar.gz" \
    | tar -C /usr/local -xz
ENV PATH=/usr/local/go/bin:$PATH
