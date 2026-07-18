# Stage 1: Build frontend
FROM node:18-alpine AS frontend

WORKDIR /build/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
ENV NEXT_PUBLIC_API_HOST="/"
RUN npm run build

# Stage 2: Copy built frontend to static directory
FROM alpine:3.19 AS assets

WORKDIR /build
COPY . /build
COPY --from=frontend /build/web/out/ /build/static/web/

# Stage 3: Build Go binary
FROM golang:1.21-alpine AS build

RUN apk update && apk add --no-cache git gcc build-base linux-headers

WORKDIR /build
COPY --from=assets /build /build

ARG VERSION=dev
ENV VERSION=${VERSION}
ARG GIT_COMMIT
ENV GIT_COMMIT=${GIT_COMMIT}
ARG NAME=docker
ENV NAME=${NAME}

RUN CGO_ENABLED=1 GOOS=linux go build -a -installsuffix cgo -ldflags "-extldflags \"-static\" -s -w -X github.com/owncast/owncast/config.GitCommit=$GIT_COMMIT -X github.com/owncast/owncast/config.VersionNumber=$VERSION -X github.com/owncast/owncast/config.BuildPlatform=$NAME" -o owncast .

# Stage 4: Final runtime image
FROM alpine:3.19.1
RUN apk update && apk add --no-cache ffmpeg ffmpeg-libs ca-certificates su-exec && update-ca-certificates

RUN addgroup -g 101 -S owncast && adduser -u 101 -S owncast -G owncast

WORKDIR /app
COPY --from=build /build/owncast /app/owncast
COPY docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh && mkdir -p /app/data

VOLUME /app/data

ENTRYPOINT ["/app/docker-entrypoint.sh"]
EXPOSE 8080 1935
