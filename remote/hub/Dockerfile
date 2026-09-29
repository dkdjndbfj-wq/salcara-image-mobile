# Salcara Hub 镜像：distroless/static + 静态二进制。
#
# 先在宿主机编译静态二进制，再构建镜像：
#   CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags "-s -w" -o salcara-hub .
#   docker build -t salcara-hub .
#
# 如果想在 Docker 里编译，把下面第一行换成多阶段构建：
#   FROM golang:1.22 AS build
#   WORKDIR /src
#   COPY . .
#   RUN CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o /out/salcara-hub .
#   然后把 COPY salcara-hub 改成 COPY --from=build /out/salcara-hub /salcara-hub
FROM gcr.io/distroless/static-debian12:nonroot
COPY salcara-hub /salcara-hub
# distroless 里没有 shell，用一个空目录让 /data 归 nonroot(65532) 所有
COPY --chown=65532:65532 deploy/data/ /data/
ENV SALCARA_HUB_ADDR=0.0.0.0:8787 \
    SUB2API_URL=http://sub2api:8080 \
    SALCARA_HUB_DATA=/data
VOLUME ["/data"]
EXPOSE 8787
USER 65532:65532
ENTRYPOINT ["/salcara-hub"]
