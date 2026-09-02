# Host Preflight（目标主机预检）

## 目的

部署前确认目标主机满足条件：Docker Engine / Compose v2、`runsc`（gVisor）实测可用、端口
8443/8080/5432/8081 空闲、`${NEXTTIME_DATA}` 所在盘剩余空间与内存、已占用的 Docker 网段（避免
`.env` 里的 `NEXTTIME_SUBNET_*` 冲突）、CPU 核数。对应任务清单 E1（验证 gVisor），顺带覆盖
E2–E4 依赖的其余主机条件。脚本只读，唯一例外是运行并删除一个 `alpine:3.20` 容器来实测 `runsc`
—— 这正是 E1 的验收动作本身。不在主机上写任何文件。

## 远程执行

```bash
ssh <TARGET_HOST> 'NEXTTIME_DATA=${NEXTTIME_DATA} sh -s' < scripts/host-preflight.sh
```

`NEXTTIME_DATA` 是计划中的数据根目录，即使还不存在也可以传入——脚本只用它定位父目录做磁盘
检查，并报告该目录本身是否已存在（信息性，不影响判定）。

## 如何读表

输出是一张 `STAT | CHECK | DETAIL` 表：

- `PASS`：满足要求。
- `WARN`：不阻塞，但部署前应评估（端口被占、磁盘 < 50G、内存 < 4G、`runsc` 未在
  `docker info` 中注册等）。
- `FAIL`：阻塞部署，必须先解决（Docker / Compose v2 缺失、`runsc` 实测失败等）。

脚本退出码：无 `FAIL` 时为 `0`，否则为 `1`。表格之外会单独打印一行
`WORKER_RUNTIME=runsc` 或 `WORKER_RUNTIME=runc`，可直接抄进目标主机的 `.env`。

## runsc 失败时怎么办

1. 先看 `runsc-configured` 是否也是 `WARN`：多数是 daemon.json 里没注册 `runsc` runtime，
   按 gVisor 官方文档安装后在 `/etc/docker/daemon.json` 加 `runtimes.runsc`，
   `systemctl restart docker`。
2. 已注册但实测仍失败：看 `runsc-run-test (E1)` 行的错误详情（常见原因：内核过旧、
   `platform=systrap`/`kvm` 依赖缺失、AppArmor/SELinux 拦截）。
3. 短期内无法修复：按脚本建议采用 `WORKER_RUNTIME=runc` 先跑通功能，把 gVisor 加固记入
   技术债，待条件满足后只需改 `.env` 并重启 `worker-supervisor` 即可切换。
