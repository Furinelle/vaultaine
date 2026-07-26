# 更新日志

本项目的重要变更记录在此文件中。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循语义化版本。v2.0.1 之前的历史见 git 提交记录。

## [Unreleased]

### 安全

- **【破坏性变更】Telegram 首用户自动放行（TOFU）默认关闭。** 此前允许列表为空时，首个输对 4 位 PIN 的用户会被自动永久加入允许列表，部署完成到管理员首次认证之间存在抢注窗口。现在默认拒绝并在日志提示放行方式；需沿用旧行为请显式设置 `TELEGRAM_AUTO_ALLOW_FIRST_USER=true`，或预填 `TELEGRAM_ALLOWED_USER_IDS`。
- 新增跨用户全局 PIN 失败锁定（`TELEGRAM_PIN_GLOBAL_FAIL_MAX`，默认 15 分钟 20 次），封堵换 Telegram 账号重置失败预算的分布式爆破路径。
- `/ytdlp` 下载强制经内置 SSRF 出口过滤代理出网：每一跳连接（含重定向后的新主机）都做公网地址校验并直连已校验 IP，拦截指向内网、回环与云元数据地址的请求；未识别的 yt-dlp 错误不再向用户回显原始 stderr。
- 发布工作流的 `packages:write` 权限从全部 job 收敛到两个镜像构建 job，`quality` job 执行 npm 依赖生命周期脚本时不再持有可推送镜像的 token。
- 前端运行时依赖（framer-motion、i18next、react-i18next、lucide-react）从 devDependencies 移入 dependencies，使 CI 的 `npm audit --omit=dev` 审计闸门真正覆盖交付到浏览器的代码。

### 修复

- 修复两处可导致后端进程整体崩溃的缺陷：Telegram 单流下载的写入流在挂载错误监听前发生磁盘错误会以 uncaughtException 终止进程（改用 `stream/promises` 的 pipeline，同时修复背压）；yt-dlp 队列 worker 的 promise 拒绝会以 unhandledRejection 击穿进程。
- yt-dlp 任务不再因心跳或进度持久化的单次瞬时数据库错误而永久卡在 running 状态：容忍连续 3 次失败，且持久化失败会正确结算为可重试失败而非被误判为用户取消。
- 单文件上传命中存储配额冷却（最长 24 小时）时不再原地占用下载队列槽位饿死其他任务，改为释放槽位并在冷却到期后自动重新入队。
- 存储桶导入改为异步后台任务：立即返回任务 ID，前端轮询进度（容忍瞬时网络抖动），大桶不再在代理层超时；导入不再为等待补偿删除的对象重建索引，避免产生指向已删除对象的悬挂记录。
- 分块上传的断点续传在进程崩溃后不再被残留的分块锁文件永久阻塞（按 mtime 回收陈腐锁）；过期分块会话删除后目录不再永久泄漏（孤儿清理覆盖 CHUNK_DIR）。
- 数据库启动迁移对存量数据更安全：files 唯一索引创建前自动去重，避免历史重复行导致后端拒绝启动；files 外键语义在 Docker（init.sql）与非 Docker 部署间对齐为 ON DELETE CASCADE。
- 修复预览弹窗内联组件导致的整树重挂载——后台上传进度更新时视频/音频不再反复从头播放。
- 修复文件列表的三处过期闭包问题：刷新失败时不再用错误页整体替换已加载列表、上传完成后不再用旧查询参数覆盖当前视图；搜索输入增加 300ms 防抖，消除每次按键的重复请求。
- 修复取消分块上传后点击「重试」永久失败的问题。
- 修正 GHCR 镜像标签文档：语义化版本镜像标签不含 `v` 前缀（git tag `v2.0.1` 对应镜像标签 `2.0.1`），照文档旧值 `docker compose pull` 会失败。

### 变更

- **项目更名为 Vaultaine**（原 TG Vault / furina-vault）。改动覆盖界面文案、Bot 消息、TOTP 发行方名称（仅影响新扫码的验证器条目）、Telegram 会话设备名、README/部署文档、`package.json`、默认镜像名（`vaultaine-frontend` / `vaultaine-backend`）与 GHCR 发布目标（`ghcr.io/furinelle/vaultaine-*`）。为兼容现有部署，以下标识**保持不变**：Compose 项目名 `tg-vault`（决定数据卷命名空间）、数据库名/用户 `tgvault`、登录 Cookie `tg_vault_token`、`TG_VAULT_SECRET_DIR` 环境变量、PG 咨询锁 key、分块上传设备哈希种子，以及 Google Drive 存储目录名 `TG Vault`。服务器若在 `.env` 中显式设置了 `BACKEND_IMAGE` / `FRONTEND_IMAGE`，需自行更新为新镜像名。升级注意：容器名与网络名改动会使 `docker compose up -d` 重建包括 postgres 在内的全部容器（数据卷不受影响，会有短暂停机）；宿主机上按旧容器名（`tg-vault-postgres` 等）写死的 cron/监控脚本需同步改名；走 GHCR 拉取升级的部署，首个 `vaultaine-*` 包发布后需在 GitHub Packages 手动设为 public。
- 前端 API 层约 44 处重复的响应错误处理收敛为共享守卫模块，`UNAUTHORIZED` 哨兵收敛为导出常量；分块上传的 SHA-256 计算增加串行门，峰值内存从约 4 倍分块大小收敛为单分块。
- 存储桶导入失败时向用户展示友好提示并在会话过期时走统一登出路径，不再显示内部错误码。

### 新增

- 云存储凭据加解密路径（credentialCrypto/secretStore）补齐 21 个行为测试，覆盖密文篡改、密钥轮换与持久化恢复语义；`fileScope` 的 SQL 参数重编号修复补充行为回归测试。
- CI 发布流水线将后端与前端镜像发布到 GHCR（`ghcr.io/furinelle/vaultaine-backend` / `vaultaine-frontend`），部署文档新增按不可变标签拉取镜像的流程。

## [2.0.1] - 2026-07-23

- 与上游 hicocos/tg-vault v2.0.1 同步，并保留 fork 特有功能（S3 存储桶导入、4 路并发分块上传、R2 兼容性修复等）。
