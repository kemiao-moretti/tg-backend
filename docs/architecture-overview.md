# koharu-suite 架构与功能总览

> 本文档基于对当前代码库（`main` 分支）的梳理，用于快速理解项目的整体架构、模块职责与核心数据流。
> 使用说明与操作手册见 [`README.md`](../README.md)；各运维细节见 [`docs/`](./README.md) 下的部署、对账、媒体缓存、搜索/RSS 手册。

---

## 1. 项目定位

`koharu-suite` 是开源静态博客框架 [astro-koharu](https://github.com/cosZone/astro-koharu) 的**可选伴生后台**，提供：

- **Telegram 多频道归档**：把若干公开频道的 `channel_post` / `edited_channel_post` 增量采集、落库、可审计恢复；
- **动态内容与统一管理**：一个 Owner Desk 管理界面统一管理归档消息、媒体、对账与运维；
- **静态发布能力**：通过 `@coszone/koharu-astro` 让 astro-koharu 静态站读取归档数据。

**核心原则**：默认保持 astro-koharu 的纯静态构建与部署体验；需要时才连接独立的 suite 后端；内容与媒体**可导出、可恢复**，移除后端不影响既有静态站点；以 PostgreSQL 18、Astro 6/7 Live Content Collections 与开放 JSON API 为基础。

**技术栈**：Node.js 22.20+、pnpm 10.28 workspace、TypeScript 7、Hono 4、PostgreSQL 18（Drizzle + `pg_trgm`）、React 19 + Vite、Better Auth、Biome、Vitest。

---

## 2. 工作区结构

`pnpm-workspace.yaml` 把 `apps/*` 与 `packages/*` 纳入单一 workspace：

```
tg-backend/
├── apps/
│   ├── server/       # @koharu-suite/server：Hono API、DB 迁移、kodama CLI（私有）
│   └── admin/        # React 19 + Vite 的 Owner Desk 管理界面（私有）
├── packages/
│   ├── archive-format/  # @koharu-suite/archive-format：版本化可移植归档格式与校验器
│   ├── koharu-astro/    # @coszone/koharu-astro：Astro Live 加载器 + 类型化 client（对外发布）
│   └── ui/              # @koharu-suite/ui：内部 React 原语（G3.1 后已退役，待定去留）
├── docs/             # 部署 / 对账 / 媒体缓存 / 搜索RSS / npm发布 / goals 手册
├── scripts/          # astro-fixture、telegram-fixture、compose-smoke、打包脚本
├── tests/fixtures/   # 测试与 CI 用的安全 fixture
└── Dockerfile / compose.yaml / compose.smoke.yaml
```

### 2.1 进程模型（三个独立运行时）

由 `apps/server/src/runtime.ts` 装配、`process-lifecycle.ts` 守护（`SIGINT/SIGTERM` 优雅关闭，默认 25s 超时强退，日志统一脱敏）：

| 运行时 | 职责 | 启动方式 |
|---|---|---|
| **HTTP Server** | Hono API + Admin 静态服务，不读 Bot token、不采集 | `pnpm dev` / `pnpm exec kodama serve` |
| **Worker** | 唯一的 Telegram poller/采集 worker + 媒体缓存 worker + 对账 runner | `pnpm dev:worker` / `pnpm exec kodama worker` |
| **MediaCache Worker Runtime** | 媒体缓存稳态循环（容量守门、命令处理、缩略图、恢复 plan） | 内嵌于 worker |

关键点：**只允许一个 poller** 消费同一 Bot 的 `getUpdates` 流（常驻 pinned session + `pg_try_advisory_lock` + `pg_backend_pid()` 身份校验），避免多副本同时拉取。

---

## 3. 核心数据模型（apps/server/src/db/schema.ts）

### 3.1 消息：不可变修订 + 当前指针

这是系统最核心的设计——**消息(Message)与修订(Revision)分离**：

- **`messages`**：不可变消息身份。关键字段 `currentRevisionNumber`（指向当前修订号的指针）、`tombstonedAt`（软删除即"不可见"）、`channelId`、`telegramMessageId`（per-channel 唯一）、`publishedAt`。公开可见性 = `tombstonedAt IS NULL`。
- **`messageRevisions`**：`messageId` + `revisionNumber`（per-message 唯一递增）+ `telegramUpdateId`，内容含 `contentKind`(caption/text/none)、`text`、`entities`(jsonb)、`html`（安全渲染产物）、`rendererVersion`、`mediaGroupId`、`editedAt`。每次编辑生成不可变新修订，指针前移。
- **`messageMedia`**：挂在 `revisionId` + `position` 上（媒体属于某个具体修订），kind = animation/audio/document/photo/video/voice。

**读取惯用法**：所有公开读都 `innerJoin messageRevisions ON revisionNumber = messages.currentRevisionNumber`。公开索引 `messages_public_published_idx` 只为未 tombstone 记录。

### 3.2 多源证据（对账的基底）

Telegram bot update 与 Desktop JSON 导入两条来源统一抽象为"观测"：

- **`messageSourceObservations`**：一次"观测"一条，含 `sourceKey`、`contentFingerprint`、`resolution`（`created|matched|stale|conflict`）。
- **`messageSourceMediaObservations`**：每个媒体位置一条证据，带 `availability`（available / exceeds_maximum_size / not_included / unavailable）。
- **`importRuns` / `importRunObservations` / `importRunCoverages`**：导入运行的清单与血缘。
- **`importRunCoverages`**：声明"某区间完整导出"（`explicitlyComplete`），驱动对账弱信号。

### 3.3 采集 / 频道

- **`telegramChannels`**（UUID 主键 + 唯一 tg chatId）、**`telegramChannelAllowlist`**（采集白名单，enabled 与 disabledAt 互斥约束）。
- **`telegramPollingState`**（单例 + botId + nextUpdateId，绑定唯一 Bot）、**`telegramUpdates`**（原始 update 存档）、**`telegramIngestTasks`**（持久化采集任务队列，含 attemptCount / availableAt / skipped / blocked）、**`telegramPollReceipts`**（每次 poll 的区间快照，校验 offset 连续性）。

### 3.4 对账

- **`reconciliationRuns` / `reconciliationSchedule`**（租约 lease 授权手工 runner）、**`reconciliationFindings`**（15 种 kind，state = open/resolved/ignored）、**`reconciliationActions`**（before/after 审计）。

### 3.5 媒体缓存（大量状态机表）

- **`mediaCacheRuntime`**（全局字节账本）、**`mediaCachePostPlans`**、**`mediaCacheBlobs`**（SHA-256 内容寻址，路径校验 `blobs/xx/yy/<sha>`）、**`mediaStorageBackends`**（local/s3 多后端）、**`mediaBlobLocations`**（readPriority / readable，决定读优先级与回拉）、**`mediaCacheObjects`**（original/thumbnail）、**`mediaCacheObjectProtections`**、**`mediaCacheCommands`**（evict/migrate/prune/reconcile/restore 操作队列）、**`mediaCacheObjectSources`**、**`mediaCacheActions`**。

### 3.6 认证 / 系统

- `authUsers` / `authSessions` / `authAccounts` / `authVerifications` / `authTwoFactors` / `authApiKeys`、`owners`（**单例 owner**，`singleton=1` 约束）。
- `appMetadata`、`workerRuntime`（采集 worker 心跳）、`operationAuditEvents`（操作审计）。

> 大量表通过内联 `check` 约束直接表达状态机（poll 区间、媒体缓存 lease 全空或全有、tombstone 与 disabledAt 互斥），**DB 层即"不变量守卫"**。

---

## 4. HTTP 层（apps/server/src/app.ts，约 1700 行）

所有 Hono 路由集中在 `createApp(dependencies)`，通过依赖注入可降级为不可用桩。错误统一 `{ error: { code, message } }`。

### 4.1 中间件（`app.use('/api/v1/*')`）

- **公开路径白名单** `isPublicApiPath()`（health / channels / rss / messages / search / media）。
- **CORS**：仅允许配置的 origin（精确匹配），不支持 `*` 或 credentialed CORS；预检仅 `GET, HEAD`。
- **固定窗口限流**：键为客户端地址（`TRUST_PROXY=true` 时取 `X-Forwarded-For` 首项），默认每 60s 120 次，超限 `429 rate_limited`，带 `RateLimit-Limit/Remaining/Reset` 头。单进程内、重启清空、多副本不共享。
- **认证中间件** `authorizeAdmin(context, scope)`：owner 会话 / service token 授权，失败 `401 unauthorized` 或 `403 insufficient_scope`。人工破坏性操作额外要求 `actorType === 'owner_session'`（拒绝 service token）。

### 4.2 公开 API（无需认证，仅 GET/HEAD）

| 路由 | 契约 |
|---|---|
| `GET/HEAD /healthz` `/readyz` `/api/v1/health` | 健康检查，readyz 依赖 DB probe 否则 `503` |
| `GET /api/v1/channels` | 列出公开频道 `{ items:[{id,title,username}] }` |
| `GET /api/v1/search/messages` | 搜索：`q`(1-200)、`channel*`(≤32)、`from/to`(UTC)、`sort`(relevance/newest)、`limit`、`cursor`；1-2 字符短查询强制单频道+31 天窗口+newest+limit≤20 |
| `GET/HEAD /api/v1/rss.xml` `/api/v1/channels/:id/rss.xml` | RSS 2.0，带 ETag/Last-Modified/304 |
| `GET /api/v1/messages?channel=&limit=&cursor=` | 按频道分页（limit 1-100） |
| `GET /api/v1/messages/latest?channel*&limit=&cursor=` | 跨频道合并最新（带快照时间戳） |
| `GET /api/v1/messages/:id` `/api/v1/messages/:id/context` | 单条 + 上下文（newer/older） |
| `GET/HEAD /api/v1/media/:id` | 媒体读取（仅 media 启用时挂载），支持 Range/If-Range/206/304/416 |

### 4.3 管理 API（需认证 + scope）

- `admin:read`：`/admin/status`、`/admin/messages`、`/admin/messages/:id`、`/admin/messages/:id/raw`（`owner_session` 才能看原始 update）、`/admin/tasks/blocked`、`/admin/channels`。
- `content:write`：`/admin/messages/:id/hide|unhide`（乐观并发 `expectedUpdatedAt`）、`/admin/rerender`。
- `ingestion:write`：`/admin/tasks/:id/retry|skip`、`/admin/channels/:telegramId/enable|disable`。
- 对账（较重写操作要求 `owner_session`）：`/admin/reconciliation/findings`、`/runs`、`/scan`、`/findings/:id/repair|ignore|hide|unhide`。
- 媒体缓存：`/admin/media-cache/status`、`/objects`、`/objects/:id/retry|evict|protect|unprotect|policy|restore`、`/migrate`、`/prune(/:preview)`、`/reconcile`（写操作普遍返回 `202`）。

---

## 5. 认证模型（apps/server/src/auth/）

- **`auth.ts`**：工厂 `createAuth()` = **Better Auth** + `drizzle` 适配器。启用 `emailAndPassword`（自动登录关、注册禁用）、`apiKey` 插件（前缀 `khs_`，默认 600 次/60s 限流）+ `twoFactor`。`basePath: /api/auth`。session 7 天，信任设备 30 天。
- **`owner-service.ts`**：**单例 owner**（`owners.singleton=1`）。`OwnerService.create()` 用 `pg_advisory_xact_lock` 保证"只可创建一个 owner"；`resetPassword()` 借 better-auth 重置 token。密码 12-128 位、email 小写化。
- **`service-token.ts`**：三种 scope —— `admin:read`、`content:write`、`ingestion:write`；`parseServiceTokenExpiry("30d")` 解析 1-3650 天。明文 key 仅 create 时输出一次，DB 只存 hash。
- **`runtime-auth.ts`**：`authorize(headers, scope)` 按序尝试 `Authorization: Bearer` → `verifyApiKey`，再判 scope；否则读 session + 校验 owner。改密/开关 2FA 成功后**撤销该用户全部 session**。

---

## 6. 数据采集与写入路径

### 6.1 主数据流（`messages/repository.ts` → `ingestSnapshotInTransaction`）

单事务落四张表：

1. **`telegramChannels`**（按 `telegramChatId` upsert，更新标题/username）；
2. **`messages`**（不可变身份 + 指针 + tombstone）；
3. **`messageRevisions`**（每个编辑版一条，含渲染 `html` 与 `rendererVersion`）；
4. **`messageSourceObservations`**（来源 bot/desktop 的观测与指纹），再展开 `messageSourceMediaObservations`。

**Desktop 导入的源优先级**：仅当候选 `editedAt` **严格晚于**当前 revision 才提升 `currentRevisionNumber`；相等/更早判 `conflict`/`stale`。

### 6.2 Telegram 采集（`telegram/`）

- **`polling.ts`**：`TelegramPoller` 长轮询，**游标推进是 DB 事务的一部分**：`checkpointBatch` 在单事务校验 offset 回放顺序、写 `telegramIngestTasks`、推进 `nextUpdateId`。只订阅 `channel_post` 与 `edited_channel_post`，429/5xx 指数退避。
- **`worker.ts`**：`TelegramWorkerPool` 用单条 SQL `for update skip locked` 领取未处理且未被更早 update 阻塞的任务；失败 `2^(attempt-1)` 退避，`MAX_ATTEMPTS=10` 后置 `blockedAt`。**采集与落库解耦成"持久任务队列"，poller 崩溃任务仍在表里可重放 → crash-safe**。
- **`normalize.ts`**：`normalizeChannelUpdate` 归一为 `NormalizedChannelPost`；媒体取照片最大面积者。
- **`inbox-repository.ts`**：`bindBot` 用事务级 advisory lock 把 DB 锁定到唯一 bot；非 allowlist 频道更新静默丢弃；`ReservedTelegramInboxRepository` 用常驻 session 保证整进程独占 poller。

### 6.3 Telegram Desktop 导入（`imports/`）

纯流式、内存友好回填，**确定性去重 + 可证明的干净范围**：

- **`telegram-desktop-parser.ts`**：`ExactIntegerTokenizer` 把每个整数 token 保留为原始十进制字符串，避免 JS Number 精度丢失。
- **`telegram-desktop-service.ts`**：`--apply` 前置 `sha256RegularFile` 双次校验输入文件未变（防导入中改写）；用专属 advisory lock 防并发；按 250 条分批，每条在 savepoint 内写入，失败分类可恢复/致命。
- **`coverage.ts`**：`--complete-range` 声明"区间完整导出"，仅 apply 允许。
- 退出码：`0` clean/replay，`2` 有 conflict/单条错误，`1` fatal/中断；中断后可用同一文件安全重跑。

---

## 7. 媒体缓存（apps/server/src/media-cache/）

可选本地缓存 + 可选 S3 持久化，**内容寻址（SHA-256）+ 两级明细账 + 租约** 的 crash-safe 设计。

- **`blob-store.ts`** `LocalMediaBlobStore`：`blobs/ab/cd/<sha256>` 分片。写入 **stage → publish → settle** 三段：
  - `stage`：写临时 `.part` → fsync → 硬链接成 `.staged`（幂等、崩溃安全）；
  - `publish`：硬链到内容寻址最终路径，EEXIST 视为 already_present，校验 SHA-256/长度；
  - `settle(db_committed|db_rolled_back)`：DB 提交保留 final、回滚删除 final 再删 staging，两次都做目录 fsync。
  - 前缀校验防路径逃逸、`O_NOFOLLOW` 防符号链接；孤儿由 `listStaleLeases`/`recoverLease`/`discardPartialLease` 回收。
- **`content-type.ts`**：用 `file-type` 嗅探前 4100 字节 magic number，与预览类型白名单双向校验，是缓存文件合法性关口。
- **多后端抽象**：`local-persistent-blob-backend.ts` / `s3-blob-backend.ts` 统一为 `PersistentBlobBackend`；`BackendAwareCommittedBlobReader` 按 `media_blob_locations` 选择后端，**打开失败自动 fallback**，读时回传命中后端供 `enqueueRecacheOnAccess`。
- **`command-queue.ts`**：`evict|migrate|prune|restore|reconcile` 命令队列，带租约（`leaseExpiresAt` + `leaseToken`），`claim→renew(60s)→succeed/fail` 故障可恢复；自动 `pruneConfiguredExcess` 守容量上限。
- **`worker.ts`** `MediaCacheWorker`：三个主循环（恢复过期 plan → 跑可运行 plan → 生成缩略图）；下载按来源 pair fallback，聚合 ≤50MiB；缩略图二次（≤1MiB、webp）。
- **`policy.ts`**：单媒体限额 PHOTO=10MiB、ANIMATION/VIDEO=20MiB、聚合 POST=50MiB。
- **`object-policy-service.ts`**：`protect/unprotect`（阻止驱逐）、`setEvictedPolicy(recache_on_access|stay_evicted)`（被驱逐对象读后是否自动 S3 回拉）。
- **`maintenance-service.ts`**：`reconcile`（逐 blob 校验 SHA-256/missing，缺失按 LRU 驱逐修复）、`prune`（LRU 到目标字节数）；在 advisory lock 下校正 `media_cache_runtime` 的 ready/reserved 字节账本。

---

## 8. 对账、恢复与 tombstone（apps/server/src/reconciliation/）

### 8.1 对账（evidence-driven scanner）

`PostgresReconciliationRepository` 在 advisory lock + **只读、可重复读**事务内逐批扫描 13 类证据：

- ingest 卡住：`durable_pending` / `durable_blocked` / `operator_skipped`；
- 频道：`disabled_window`（依赖 operationAuditEvents 时间线）、`retention_risk`（>24h 无成功 checkpoint）；
- 跳变弱信号：`transport_id_discontinuity` / `message_id_candidate`；
- 观测：`observation_stale` / `observation_conflict`；
- 导入：`desktop_absence_candidate`（完整区间内某消息无 run 血缘 → 弱信号）；
- 派生物：`media_evidence_missing`、`derived_html_drift`（渲染产物与确定性输出不一致）、`current_pointer_invalid`（指针指向不存在 revision）。

每种证据带 `ReconciliationEvidenceConfidence`（certain / … / weak_signal），向 operator 呈现可信度。

### 8.2 显式修复（deterministic repair）

`--apply` 时在 advisory lock + `lockSourceEvidenceDiscovery` 下执行确定性可证明修复，每条一个 savepoint，写 `reconciliationRuns`/`reconciliationActions`（before/after 审计）：

- `current_pointer.repair`：把指针指回唯一可证明的最高 revision；
- `derived_html.rerender`：重算 html/rendererVersion；
- `import_lineage.restore`：从终态 Desktop run 重建血缘；
- `source_media.restore`：从 immutable raw 重建缺失的媒体观测（需指纹复算 + 位置唯一可证）。

`RepairInput` 强制 `initiatorKind` + `reason` + `expectedEvidenceVersion` 作为并发冲突守卫。

### 8.3 Tombstone（逻辑删除）

`MessageTombstoneService.hide/unhide`：**仅 owner session 可改**；由对账 finding（如 `desktop_absence_candidate`）驱动、要求 `evidenceVersion` 匹配；写 `tombstonedAt` 并落审计。所有只读查询过滤 tombstone —— **删除仅逻辑隐藏，row 保留、可审计回滚**。

### 8.4 搜索与 RSS（apps/server/src/messages/）

- **搜索双模式**：trigram（`messageRevisions.text` 上 GIN `gin_trgm_ops` 索引，`word_similarity` 打分、`ILIKE` 过滤）与 short_substring（<3 字符）；游标带 `queryHash`（sha256 固化查询键）+ `snapshotAt`，base64url 编码。
- **分页游标**（`http/cursor.ts`）：base64url 编码 JSON，解码时严格校验 UUID/ISO 时间/正则/字段数/规范化（防篡改）。
- **渲染**（`renderer.ts`）：`renderTelegramMessage` 把 entities（bold/italic/spoiler/blockquote/pre/text_link/url/email/phone_number，含嵌套优先级）渲染为安全 HTML（escapeHtml、safeLink 仅 http/https/mailto/tg、`rel="nofollow noopener noreferrer"`）。`CURRENT_RENDERER_VERSION=1`。
- **RSS**：全局与每频道各固定 ≤50 条不分页，支持 GET/HEAD/ETag/304。

---

## 9. kodama CLI（apps/server/src/cli.ts + ops/）

统一运维命令，`--apply` 一律要求 `--reason`（变更留痕），`--json` 输出带 `schemaVersion` 的版本化报告，抛错统一 `sanitizeDiagnosticText` 过滤敏感值：

| 命令 | 子命令 / 作用 |
|---|---|
| `serve` | 启动 HTTP API（Hono） |
| `worker` | 启动 Telegram 采集 + 媒体缓存 worker 运行时 |
| `migrate` | 应用 DB 迁移 |
| `owner` | `create` / `reset-password` 单例 owner |
| `token` | `create`（scope 复用 `--scope`）/ `list` / `revoke` |
| `channel` | `add` / `enable` / `disable` / `list` |
| `import` | `telegram-desktop`（`--input --channel --complete-range [--apply] [--json]`） |
| `reconcile` | `telegram`（`--channel... [--apply --reason]`，无 apply 为 dry-run） |
| `media` | `status` / `scan` / `cache` / `copy` / `restore` / `protect` / `unprotect` / `policy` / `prune` / `reconcile` |
| `doctor` | 只读部署诊断（config/database/search/owner/telegram 各域） |
| `health` | `worker` heartbeat 检查 |

---

## 10. Owner Desk 前端（apps/admin/）

**技术栈**：React 19 + Vite，`better-auth/react`（`createAuthClient({ plugins: [twoFactorClient()] })`），react-router-dom v7 **HashRouter**（因 server 只静态服务 `/admin/*`、无 SPA 回退）。

### 10.1 路由（8 页）

`/` 概览、`/messages` 消息、`/search` 搜索、`/channels` 频道、`/cache` 媒体缓存、`/reconciliation` 对账、`/system` 系统、`/settings` 设置（未匹配重定向 `/`）。

### 10.2 状态与轮询

`DeskShell` 作为布局路由承载全部状态、轮询与操作处理器，经 `<Outlet context={desk}/>` 下发，子页用 `useDesk()` 读取。`status-poller.ts` 10 秒轮询 `/api/v1/admin/status`（AbortController 管理）。

### 10.3 功能面板

- **概览**：StatsStrip（10 项统计）+ TriageLane（聚合"需要处理"队列：阻塞任务 retry/skip、finding、缓存 retry、rerender）。
- **消息**：MessageBrowser，channel 分页 + 主从详情；`onRevealRaw` 点击才请求 raw（no-store）；可见性过滤 all/hidden/visible，hide/unhide 乐观更新 + 409 冲突恢复。
- **搜索**：SearchAndFeedsPanel（搜索表单 + RSS 订阅链接），`shortQueryGuard` 约束短查询。
- **频道**：ChannelsCard，启停。
- **媒体缓存**：MediaCacheReadouts + CacheObjectsCard + StorageToolsCard —— 对象级 evict/retry/protect/unprotect/policy/copy/restore，存储级 copy（migrate）/prune（preview/apply）/reconcile，写操作回执入队异步执行。
- **对账**：FindingItem 列表 + ScanCard（安全扫描）+ ReconciliationBaseline，finding 操作 hide/ignore/repair/unhide。
- **系统**：CollectorStatus 只读监控；**设置**：SecurityCard（2FA 管理）。

### 10.4 UI

G3.1 后使用 **Tailwind v4 + shadcn/ui 风格**（`components/ui/`，已内联进 admin，不再依赖 `packages/ui`）。设计 token：唯一强调色 `--primary:#8FB8FF`、深色冷中性、圆角≤4px、标题衬线。错误 inline + sonner toast 二元反馈。

---

## 11. 可复用包

### 11.1 @coszone/koharu-astro（对外发布，Astro 静态站侧）

- **类型化 client** `createKoharuClient({ baseUrl, timeoutMs, fetch })`：`channels.list()`、`messages.get/list/latest/context`、`search.messages()`、`urls.globalRss/channelRss`、`resolveUrl`（相对媒体路径解析到 suite origin）。默认 5s 超时、`cache:'no-store'`、AbortSignal 支持、保留 `RateLimit-*`/`Retry-After`。
- **Astro 6 Live Loader**：`koharuChannelsLoader` / `koharuMessagesLoader`，实现 `loadCollection()/loadEntry()`，消费端用 `defineLiveCollection({ loader, schema })` 注册。
- **Zod 合同**（`schemas.ts`）：publicChannel/publicMessage/messagePage/messageContext/searchMessagePage/apiError 等 schema，类型全部从 schema 推导。
- **错误模型** `KoharuError`：kind ∈ aborted|timeout|network|http|invalid_response。import 无副作用、不读 env，保证 "static-off / dynamic-on" 两态。

### 11.2 @koharu-suite/archive-format（纯格式/校验库，G2.8.1 冻结 format-v1）

- `koharu-suite-portable-archive`，format/schema 均 version 1。逻辑布局 `manifest.json` + `checksums.sha256` + `data/<family>/<NNNNNN>.jsonl` 分片 + 可选 `blobs/sha256/..`。六大 record family：`channels|messages|revisions|revision-media|provenance-observations|provenance-media`。
- **可移植身份**：不用 DB UUID，用 `telegramChatId`（负 int64）+ `telegramMessageId`（正 int64）；媒体用 SHA-256 + byteLength + MIME。int64 以 decimal string 表示。
- **有界解析** + 完整校验器（`validateTarZstdArchive`），校验 checksum 清单、shard 顺序与计数、record schema、引用一致性、blob 存在性、manifest 内部一致性。失败 `ArchiveValidationError`，恶意归档 fail-closed。

---

## 12. Roadmap 里程碑（docs/goals/）

| 阶段 | 目标 |
|---|---|
| **G1.x** | 可运行骨架 + 首条频道消息 + Owner GUI + 多频道可靠采集 + 基础运维 + Preview 发布 |
| **G2.1** | 导入 Telegram Desktop JSON |
| **G2.2** | 对账、补洞与修复 |
| **G2.3 / G2.4** | 本地媒体缓存 / S3-compatible storage |
| **G2.5** | 搜索与 RSS（pg_trgm） |
| **G2.6** | 发布 `@coszone/koharu-astro` |
| **G2.8** | Portable archive（export/import/recovery drill，拆 7 步，替代 pg_dump） |
| **G3.1** | Owner Desk 重设计（Tailwind v4 + shadcn/ui + HashRouter 8 页 + TriageLane，已实现） |

---

## 13. 关键架构要点

1. **不可变修订 + 指针**：正文以修订序列存取，`currentRevisionNumber` 决定公开快照，天然支持编辑历史与并发。
2. **多源证据模型**：`messageSourceObservations` 统一 bot update 与 desktop 导入两条来源，通过内容指纹去重/对账。
3. **crash-safe 三支柱**：① ingest 落持久任务表（poller 崩溃可重放）；② media blob 三段式 stage→publish→settle + 孤儿租约恢复 + 内容寻址幂等；③ 所有修复/导入/对账靠 advisory lock + `evidenceVersion` 乐观并发。
4. **确定性优先**：消息指纹、媒体证据指纹、渲染 HTML、观测 sourceKey 全部可复算，修复只信任 immutable raw 而非易变派生数据。
5. **tombstone 是"逻辑删除 + 审计回滚"**，由对账 finding 驱动、仅 owner 可改，区别于硬删除。
6. **同一 controller 双认证通道**：owner 浏览器 session 与 service token 统一抽象为 `AdminPrincipal + scope`，但破坏性人工操作显式要求 owner_session。
7. **无状态公开读**：公开 API 全部 GET，游标自包含 + 校验；限流与 CORS 内建于中间件。
8. **强约束 schema**：DB 层即"不变量守卫"，整表大量内联 check 约束表达状态机。
9. **三层数据契约独立**：admin 的 `lib/types.ts`、koharu-astro 的 `schemas.ts`、archive-format 的 `schemas.ts` 三处各自独立，靠 server 的 HTTP contract test 防漂移。
