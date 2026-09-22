# Go API image. Built from the server/ directory:  docker build -t <user>/medbill-api ./server
#
# Two stages so the toolchain never ships: the compiler and module cache stay in `build`, and the
# final image carries one static binary plus the migration SQL. That keeps the published image
# small and means a CVE in the Go toolchain is not something you are shipping to a registry.

FROM golang:1.27-alpine AS build

WORKDIR /src

# Copied before the rest of the source so `go mod download` is cached and only re-runs when the
# dependency set actually changes, not on every edit to a .go file.
COPY go.mod go.sum ./
RUN go mod download

COPY . .

# CGO off produces a fully static binary, which is what lets the final stage be this small.
# -trimpath keeps local build paths out of the binary; -s -w drop the symbol and DWARF tables.
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/medbill-server .


FROM alpine:3.21

# wget (busybox) is here for the compose healthcheck; ca-certificates for any outbound TLS.
#
# postgresql17-client provides pg_dump, pg_restore and psql, which the Backup & Restore feature
# shells out to (see backup.go). The major version is pinned to match the postgres:17 database
# image: pg_dump refuses to dump a server newer than itself, so a client that drifts behind the
# server turns every backup into a failure with a cryptic version message.
RUN apk add --no-cache ca-certificates postgresql17-client \
    && adduser -D -u 10001 medbill

WORKDIR /app

COPY --from=build /out/medbill-server /app/medbill-server
# Shipped so the image can also run one-off migrations, not just serve.
COPY --from=build /src/migrations /app/migrations

# Where pg_dump writes. Created with the right owner here so the unprivileged user below can
# write to it even on the first start, before any volume is mounted over it.
RUN mkdir -p /var/lib/medbill/backups && chown -R medbill /var/lib/medbill

# Runs unprivileged. Nothing in this service needs root, and a container that never needed it is
# one less thing to get wrong later.
USER medbill

EXPOSE 8080

# APP_ENV=production is deliberate: it makes the server refuse to start without a real
# JWT_SECRET, DATABASE_URL and CORS_ORIGINS rather than fall back to development defaults.
# See jwtSigningSecret() and requireEnv() in main.go.
ENV APP_ENV=production \
    ADDR=:8080

ENTRYPOINT ["/app/medbill-server"]
