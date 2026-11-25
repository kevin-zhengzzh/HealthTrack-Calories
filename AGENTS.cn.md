# AGENTS.md（中文版）

> English: [`AGENTS.md`](./AGENTS.md)（主文件，agent 工具会自动读取）。两份内容相同，要一起更新。

给在这个仓库里工作的 AI agent（以及回头翻看的自己）的项目手册：结构、命令、约定、**关键决策**和**开发节点**。

**维护规则**：每做出一个关键决策、完成一个节点、踩到一个值得记的坑，就更新对应章节。决策只追加不删除；被推翻的决策标注"已被 D-xx 取代"。英文版 [`AGENTS.md`](./AGENTS.md) 要同步更新。

---

## 1. 项目是什么

HealthTrack 是一个健康习惯 App（打卡、运动记录、积分、排行榜、皮肤商城、AI 助手）。最初是 MSA 2026 Phase 2 的作业项目（仓库 `kevin-zhengzzh/MSA-2026-Phase2`），本仓库 `HealthTrack-Calories` 从它的 `67fb2f4` 复制而来，继续开发**卡路里摄入**功能：

> Stack-chan 机器人（M5Stack CoreS3）+ Mini Scales 称重 → 自动拍照 → 上传后端 → Claude 识别食物和每 100g 热量 → 按实测重量算总热量 → 网页 Food Log 查看。

Phase 2 的原始设计文档在 `specs/`（`05-design-decisions.md` 是 Phase 2 时期的决策，`06-ai-features-spec.md` 是 AI 助手规格）。本文件记录**从本仓库开始**的决策。

## 2. 仓库结构

```
software/backend/    C# / .NET 10, EF Core + PostgreSQL, JWT。Tests/ 是 xUnit（内存库 + 假 AI，不调用真模型）
software/frontend/   React 19 + TypeScript + Vite + Tailwind v4 + Zustand
software/scripts/    seed-demo.sql（演示数据）、send-meal.ps1（模拟设备上传）
firmware/stackchan-scale/   PlatformIO 固件（Arduino on ESP32-S3）
  src/main.cpp       称重/拍照/上传状态机、UI、触摸、Wi-Fi
  src/head.cpp       舵机（SCS0009）+ PY32 IO 扩展芯片供电
  lib/FTServo/       飞特舵机库（MIT，来自 m5stack/StackChan，有 IDF 4.4 兼容补丁）
  include/secrets.h  Wi-Fi、后端地址、设备密钥（git 忽略；模板 secrets.example.h）
deploy/vps/          自托管部署（Docker Compose + Caddy + Postgres，D-39）
.github/workflows/   ci.yml（每次 push/PR 到 main），deploy.yml（main 上 CI 通过后自动部署，也可手动触发）
specs/               Phase 2 的规划、提示词日志、设计决策
```

## 3. 常用命令

```bash
# 后端测试（software/backend/Tests/）
dotnet test
# 新迁移（software/backend/）
dotnet ef migrations add <Name>
# 前端（software/frontend/）
npm ci && npm run build && npm test && npx oxlint src
# 固件编译 + 烧录（firmware/stackchan-scale/）。PlatformIO 装在 E 盘，C 盘空间不足
PLATFORMIO_CORE_DIR='E:\.platformio' python -m platformio run -t upload --upload-port COM3
# 本地后端给局域网设备用（不要碰 Phase 2 的 healthtracker 库）。要用 AI 时加 ASPNETCORE_ENVIRONMENT=Development（user-secrets 只在开发环境加载）
ConnectionStrings__DefaultConnection="Host=localhost;Port=5432;Database=healthtrack_calories_dev;Username=postgres;Password=postgres" \
  dotnet run --no-launch-profile --urls http://0.0.0.0:5000
```

本地密钥用 `dotnet user-secrets`（`DeepSeek:ApiKey`、`Anthropic:ApiKey`），由用户自己设置，**不经过聊天**。

## 4. 约定

- 和用户交流用**中文**；代码、注释、提交信息、PR 描述用英文。
- 功能在分支上开发，经 PR 合并到 `main`（CI 必须绿）。提交信息末尾带 `Co-Authored-By` 行。
- 提交前检查：密钥、Wi-Fi 密码、设备密钥、连接串不能进 git（`secrets.h` 已忽略）；用户截图里出现密钥时提醒其轮换。
- 业务代码只依赖 AI 抽象接口（`IChatModel`、`IFoodRecognizer`），测试用假实现。
- 数字由代码算，模型只给语义（例如热量 = 实测重量 × 模型给的 kcal/100g）。

## 5. 线上环境

| 资源 | 值 |
|---|---|
| 前端 | https://healthtrack-frontend.icyglacier-3b078f70.australiaeast.azurecontainerapps.io |
| 后端 | https://healthtrack-backend.icyglacier-3b078f70.australiaeast.azurecontainerapps.io |
| Azure | 资源组 `msa-phase2`，环境 `managedEnvironment-msaphase2-a491`（与 Phase 2 共用），Container Apps `healthtrack-backend` / `healthtrack-frontend`，副本 0–1 |
| 镜像 | Docker Hub `kevinzheng123/healthtrack-calories`（Public），标签 `backend-<sha>` / `frontend-<sha>` |
| 数据库 | Neon 项目 `msa-phase2`，production 分支下的独立数据库 `healthtrack_calories` |
| 自托管 | https://healthtrack.kevinzheng.dev（主域名 302 跳转过来，D-41）：DigitalOcean Droplet `healthtrack`（悉尼，2GB，`209.38.84.117`，SSH 密钥登录 root），代码在 `/root/HealthTrack-Calories`，配置在 `deploy/vps/.env`（只在服务器上）；域名和 DNS 在 Cloudflare（D-39） |
| 后端机密 | `db-connection`、`jwt-key`、`deepseek-api-key`、`healthtrack-prod`（Anthropic key）→ 环境变量 `ConnectionStrings__DefaultConnection` / `Jwt__Key` / `DeepSeek__ApiKey` / `Anthropic__ApiKey` |
| GitHub Secrets | `DOCKERHUB_USERNAME`、`DOCKERHUB_TOKEN`、`AZURE_CREDENTIALS`（服务主体，仅限资源组 `msa-phase2`） |

Phase 2 的 `msa-backend` / `msa-frontend` 和它的 `neondb` 库**保持不动**。

---

## 6. 关键决策

格式：问题 → 决定 → 原因 → 代价/备注。

### D-01 拍照识别放在后端，设备不直连 Claude（2026-11-18）
- **决定**：设备只上传 JPEG + 克数到 `POST /api/intake/device`；后端调用视觉模型。
- **原因**：Anthropic Key 不能烧进固件（可从 Flash 读出）；后端统一做配额、日志、存储；改提示词/换模型不用重新烧录。
- **代价**：多一跳网络。

### D-02 设备用独立的设备密钥认证，不用 JWT（2026-11-18）
- **决定**：网页上配对生成 `hk_` 开头的密钥，只显示一次，库里只存 SHA-256；请求头 `X-Device-Key`；可撤销，每人最多 5 台。
- **原因**：固件里存账号密码不安全，JWT 会过期；设备密钥泄露可单独作废。
- **备注**：密钥是 32 字节随机数，用不加盐的 SHA-256 足够，且能按哈希直接查找。

### D-03 总热量由代码根据实测重量计算（2026-11-18）
- **决定**：模型只返回 `foodName`、`caloriesPer100g`、`confidence`、`isFood`（JSON schema 约束），`Calories = round(weight × kcal/100g / 100)`。
- **原因**：重量是秤的真实测量值，比模型从照片估算可靠。
- **备注**：需要先去皮，提示词假设重量不含盘子。

### D-04 没有 API Key 时只存照片 + 重量（2026-11-18）
- **决定**：`IFoodRecognizer.IsAvailable == false` 时跳过识别，记录名称为空，网页显示 "Unnamed food"，用户手动补填。每日上限 200 次（有识别时 60 次）。
- **原因**：用户要求"先不管识别，先把图片和重量传回客户端"；也让没有 Key 的环境（CI、本地）能完整跑通。

### D-05 照片以 bytea 存在 PostgreSQL（2026-11-18）
- **决定**：`IntakeRecords.ImageData`，和头像的存法一致；照片接口需要 JWT，前端用 fetch + blob URL 显示。
- **原因**：640×480 JPEG 约 22KB，Neon 免费 0.5GB 可存约 2 万张，暂时不值得引入对象存储。
- **以后**：数据量变大时迁到 Blob Storage，库里只存链接。
- **隐私**：判定为非食物的照片不入库（只有一行 `AiUsageLogs` 元数据）。

### D-06 识别模型用 Claude Haiku 5.5（2026-11-18，取代最初的 Opus 5.5）
- **决定**：默认 `claude-haiku-5-5`，`Effort.Low`，结构化输出；可通过 `Anthropic:Model` 配置换模型。
- **原因**：用户要求最便宜。实测约 **$0.00015/张**（比 Opus 便宜约 25 倍），香蕉、苹果的 kcal/100g 与 USDA 一致，非食物能正确拒绝。
- **代价**：Haiku 5.5 不支持服务端拒答回退（已去掉该 beta）；混合菜估算有约 ±15% 的波动。
- **提示词约束**：食物名 ≤ 30 字符（沙拉曾返回 67 字符的食材列表，屏幕放不下）。

### D-07 固件流程由秤驱动，重量稳定后自动拍照（2026-11-18）
- **决定**：> 5g 且 1.5 秒内波动 ≤ ±1g → 拍照上传；结果停留到重量 < 5g（食物拿走）才回到待机。
- **原因**：一开始相机初始化占用内部 I2C，触摸不可用；而且自动触发更顺手。后来触摸修好了，也保留了这个流程。

### D-08 相机 640×480 RGB565，软件压 JPEG（2026-11-18）
- **决定**：GC0308 最大 VGA、无硬件 JPEG；帧放 PSRAM（600KB），`frame2jpg` 质量 80；XCLK 10MHz（20MHz 会 EV-EOF-OVF）；预览按 3/8 缩到 240×180，保持 4:3 不裁切。

### D-09 秤：热插拔 + 等稳定再去皮 + 零点跟踪（2026-11-18）
- **决定**：每 0.5 秒探测地址 0x26；只在探测成功时读重量并丢弃 -1000～6000g 以外的值；开机/插上后等读数 2 秒内波动 < 0.5g 再去皮；空秤时 2g 以内的稳定偏移 5 秒后自动归零；显示 < 0.3g 记为 0.0。
- **原因**：库的 `getWeight()` 读失败会返回未初始化的值，可能误触发上传；开机瞬间去皮会记下漂移中的零点。

### D-10 内部 I2C 交还给 M5Unified，以启用触摸和舵机（2026-11-18）
- **决定**：相机初始化后 `i2c_driver_delete()` 卸载相机的驱动，再 `M5.In_I2C.begin()`。
- **原因**：两个驱动同时挂在一条总线上，读写时好时坏；相机推流不需要 SCCB。

### D-11 舵机控制自己实现，不用官方动画框架（2026-11-18）
- **决定**：UART1 1Mbps GPIO6/7，舵机 ID 1（左右）/2（俯仰），经 PY32 IO 扩展芯片（0x6F）的引脚 0 打开供电；**I2C 必须 100kHz**；读出厂校准值（NVS `servo/zero_pos_1|2`）；俯仰限制在 5°–85°（M5Stack 建议），左右收窄到 ±90°（自定，官方 ±128°）。
- **代价**：没有移植官方的堵转保护。
- **交互**：主界面点画面出现半透明摇杆（拖得越远转得越快）；设置页有 Center（左右 0°、俯仰 5°；最初叫 Home，舵机全速转回太突然，改为软件插值缓动 0.4–1.6 秒）。

### D-12 上传过程分阶段显示（2026-11-18）
- **决定**：请求体包装成会报告进度的 Stream 交给 HTTPClient：Taking photo → Uploading N% → Recognizing… → 结果。
- **原因**：原来整个过程都显示 "Uploading"，分不清是 Wi-Fi 慢还是识别慢。

### D-13 新项目单独部署，不覆盖 Phase 2（2026-11-19）
- **决定**：同一个 Container Apps 环境里新建 `healthtrack-*` 应用，独立的 Docker Hub 仓库和 Neon 数据库，从空库开始。
- **原因**：Phase 2 是作业成果，需要原样保留；新项目还在频繁改动，需要隔离风险。共用环境按用量计费，不额外收费，且域名可以提前确定。
- **备注**：代码层面新仓库是旧仓库的超集，数据库迁移只新增表，所以覆盖部署也是安全的，只是没有选择这样做。

### D-15 用配对码绑定设备，不再手动复制密钥（2026-11-19，部分取代 D-02 的配对方式）
- **决定**：设备 `POST /api/device/pairing/start` 拿到 6 位配对码和**设备私有令牌**；用户在网页 Food Log → Add device 输入配对码（`/claim`），后端为该用户创建 Device，此时 KeyHash 是 `pending-…` 占位；设备带令牌轮询 `/poll`，被认领后**这时才生成密钥**，只返回一次，库里只存哈希。
- **原因**：设备离开局域网后，复制密钥再重新烧录不现实。
- **安全**：只知道配对码拿不到密钥（还需要令牌）；码 10 分钟过期；每个用户每小时最多输错 10 次，每个 IP 每 10 分钟最多申请 10 次（IMemoryCache，单副本够用）；明文密钥只在最后一次响应里出现。
- **保留**：手动生成密钥（"No screen? Create a key manually"）作为没有屏幕的设备或脚本的备用方式。
- **设备端**：上传返回 401 → 清除密钥，回到配对界面（网页上移除设备后的自动处理）。

### D-16 手机配网用热点 + 强制门户，保存多个网络（2026-11-19）
- **决定**：没有可用网络时，Stack-chan 开热点 `StackChan-XXXX`，用**每次随机生成的 8 位密码**（WPA2），二维码 `WIFI:T:WPA;S:…;P:…;;` 里带着密码，扫码即可连上；手机会弹出设备自己提供的网页，列出**设备扫描到的** 2.4GHz 网络，输入密码后先测试能连上，成功后才保存。NVS（`net` 命名空间）最多保存 5 个网络，最近添加的排在前面；开机扫描后按信号从强到弱依次尝试已知网络；断线后在后台异步扫描再重连（不阻塞界面）。
- **原因**：Wi-Fi 不能再写死在固件里；手机比 320×240 的屏幕更适合输入密码。用随机密码而不是开放热点，防止旁边的人趁配网时连进来改配置，体验上一样是扫码。
- **入口**：首次开机（没有已保存的网络）自动进入；之后从设置 → Wi-Fi、配对界面的 Wi-Fi 按钮进入。设置界面的 Reset（点两次）会清除所有网络和设备密钥（恢复出厂）（已被 D-20 取代）。
- **修订（同日，真机测试后）**：最初是"在网页上先测试连接，成功才保存"，结果：①扫码时常"无法加入"——后台重连和扫描让唯一的无线电切换信道，热点短暂消失；②家里信号弱时手机一直停在"连接中"，而且设备一旦连上路由器，热点就跟着换信道，手机掉线，永远看不到结果。改为：配网期间关闭 STA 自动重连和扫描，热点固定在信道 6；**提交后立即保存、3 秒后关闭热点**，连接改到后台进行（弱信号也一直重试）；失败原因（密码错误/找不到网络/信号弱）根据断开原因码显示在 **Stack-chan 屏幕上**；如果已有保存的网络，配网界面 5 分钟无人使用就自动退出。代价：输错的密码也会被保存，要在设备屏幕上看到"Wrong password?"后再进设置重新输入。
- **兼容**：`secrets.h` 变为可选；其中的 `WIFI_*` / `DEVICE_KEY` 只在 NVS 为空的首次开机时导入一次。

### D-17 Wi-Fi 主要在设备屏幕上选择和输入，手机配网改为备用（2026-11-19，调整 D-16 的入口）
- **决定**：设置 → Wi-Fi（以及首次开机、配对界面的 Wi-Fi 按钮）先进入**设备上的网络列表**：异步扫描，每页 4 行（信号强度、加密锁、已保存标记），可翻页、重新扫描；点未保存的加密网络 → 屏幕键盘（小写/大写/数字符号三种布局，密码明文显示）→ Join；开放网络直接连；已保存的网络直接用保存的密码连（密码错误就回到键盘）。在设备上**先测试，连上才保存**；密码错误时带着提示回到键盘；找不到网络或超时（20 秒）时，可以选择重新输入、仍然保存（后台继续重试）或返回。列表页的 **Phone** 按钮进入原来的手机配网（D-16），适合输入很长的密码；**Reset** 也在列表页。
- **原因**：用户实测后更倾向于在设备上直接搜索。离线、手边没有手机，或者手机配网不稳定时，这种方式最直接；而且在设备上测试连接不存在手机掉线、卡住的问题。
- **修订（同日）**：列表改为手指拖动滚动（去掉上下翻页按钮，右侧有滚动条）；点一行展开操作按钮：当前网络 Disconnect / Password / Forget，其他网络 Connect / Password / Forget（Password、Forget 只对加密/已保存的网络出现，Forget 需点两次）。Disconnect 后不自动重连（`net::disconnect()`），直到再次连接某个网络或重启；当前网络置顶并标 "connected"。
- **实现**：选择期间 `net::pause(true)` 暂停后台重连（否则会干扰扫描）；连接结果由断开原因码判断（`net::joinState`）。

### D-18 屏幕上放不下的长文本滚动显示，而不是截断（2026-11-19）
- **决定**：`drawFit(text, x, y, width, align)`：放得下就正常显示；放不下就在裁剪框内像跑马灯一样滚动——停 1.2 秒，以 40px/s 向左滚到末尾，停 1.2 秒，回到开头。用在底部消息栏（识别结果、状态提示）、Wi-Fi 列表的网络名、键盘标题、连接页的网络名、配网状态、配对提示。去掉了之前所有 `substring` 截断（食物名、错误信息等）。
- **原因**：用户反馈文字被截断；网络名、食物名、错误信息的长度都不可控。

### D-19 设备低频自检账号，不做心跳（2026-11-19）
- **决定**：新增 `GET /api/device/me`（`X-Device-Key`）返回设备名和用户名，并更新 LastSeenAt；401 表示已在网页上移除。设备在开机后、打开设置时（距上次 ≥ 1 分钟）、空闲每 6 小时检查一次；在独立的 FreeRTOS 任务里请求（冷启动要 20–30 秒，不能卡住屏幕），检查期间不开始上传（避免同时两个 TLS 连接）。账号名显示在主画面相机左上角。
- **原因**：网页移除设备后，原来要等下一次上传才发现。高频心跳会让最小副本为 0 的后端和 Neon 一直醒着，免费额度扛不住（每分钟一次 ≈ 一直计费；每 6 小时一次 ≈ 每月 120 次唤醒，约占 Container Apps 免费额度的 10%）。
- **代价**：没人碰设备时，移除后最长 6 小时才自动回到配对界面。
- **修订（同日）**：主画面上**任何一次触摸**（距上次检查 ≥ 1 分钟）都触发后台检查——网页上移除设备后，人一般会走过去看设备，碰一下 20–30 秒内就进入配对界面；没人碰时不增加请求。
- **重试**：检查没有得到回答（超时、冷启动、断网）时 2 分钟后重试，每次翻倍，最长 30 分钟；200/401 是确定的回答，不重试。之前开机那次失败要等 6 小时，圆环一直不出现。

### D-20 Reset 改为 Unpair，只取消配对；按硬件 ID 去重（2026-11-19，取代 D-16 中 Reset 的行为）
- **决定**：Wi-Fi 列表和手机配网页去掉 Reset。点主画面左上角的账号标签，打开账号卡片 →（点两次）**Unpair**：设备先在后台调用 `DELETE /api/device/me` 作废自己的密钥（网页列表里随之消失），再清除本地密钥和账号名，进入配对界面；Wi-Fi 不动。删除网络改用列表里每个网络的 Forget。
- **重复配对**：配对时设备上报 MAC（`hardwareId`）；同一账号再次认领同一台设备时，自动作废该账号下这台设备的旧记录（不占设备数上限）。**只在同一账号内**：MAC 不是秘密，旁人可以伪造，跨账号作废会让人能把别人的设备踢下线。换账号的情况靠设备自己的 Unpair，或原账号在网页上手动移除。
- **原因**：换账号是最常见的需求，不应该连 Wi-Fi 一起删；Reset 和 Wi-Fi 混在一起容易误删。
- **代价**：离线时 Unpair 只能清除本地，网页上会留下一条失效记录，需手动移除（重新配对到同一账号时会被自动替换）。

### D-21 每日摄入目标存为用户上的一个值，自动顺延（2026-11-19；存储方式和设置入口已被 D-24 取代）
- **决定**：`Users.DailyIntakeGoal`（可空，null = 未设置），在 Food Log 的 "Eaten today" 卡片里设置/清除（`PUT /api/user/intake-goal`，1–20000）；**不按天存**——设一次之后每天都沿用，直到再改。Dashboard 新增 "Today's intake" 环形图：整圈 = 目标，每餐一段（按当天顺序配色），超过目标时整圈按总量分配、数字变琥珀色；未设目标时提示去 Food Log 设置。
- **原因**：用户要求"设定后没改就顺延"；只看今天，不需要历史目标。
- **代价**：改目标后，过去几天如果以后要显示"当天目标"就无从得知；需要时再改成带生效日期的表。
- **设备上**：主画面右下角一个小圆环，中间 `吃了/目标`（未设目标时显示 `kcal`），超过目标变琥珀色。数据来自上传返回和 `GET /api/device/me?localDate=`（两者都新增 `todayCalories` / `dailyGoal`），**不额外轮询**——网页上的修改要等下一次账号检查（触摸、开机、每 6 小时）才更新；过了本地午夜自动显示 0。
- **标签含义**（Food Log）：`Check me` = 模型置信度 low；`AI estimate` = medium；high 不显示；`Edited` = 用户改过；`Add details` = 没识别（无名称）。

### D-22 设备上查看并删除今天的记录；不做"识别后确认再记录"（2026-11-20）
- **决定**：点主画面右下角的摄入圆环 → 全屏 "Today" 页（与 Settings、Wi-Fi 同样的布局，Back 在右上角）：顶部显示 `吃了 / 目标 kcal`、进度条、剩余或超出量，下面是可拖动的当天记录列表（时间、名称、kcal）；点一行像 Wi-Fi 列表那样展开（显示重量和 Delete 按钮），点两次删除。接口 `GET /api/intake/device/today?localDate=`、`DELETE /api/intake/device/{id}?localDate=`（`X-Device-Key`），都返回更新后的列表和总量。
- **刷新与排序**：最新的排在最上面（与网页一致）；页面打开期间每 10 秒重新加载一次（网页上的删改会自动出现，展开的行按 id 保持展开），3 分钟没人碰就自动关闭，避免一直唤醒后端。
- **范围**：设备密钥**只能删本账号当天的记录**（哪台设备记的都可以），密钥泄露也删不了历史。
- **网络**：后台任务，与上传、账号检查互斥（一次只有一个 TLS 连接）；这两个请求本身也能验证密钥（401 → 回到配对界面），所以点圆环和在 Today 页里触摸不再额外触发账号检查。
- **不做**：用户考虑过"识别后在设备上点 Save/Discard 再记录"，最后决定保持自动记录，记错了在设备的 Today 页或网页上删除/修改即可。

### D-23 净热量只做展示，目标仍然比较"吃了多少"（2026-11-21；位置和计算条件见 D-25）
- **决定**：Dashboard 的 "Today's intake" 卡片加一行 Eaten / Burned / Net（摄入 − 当天运动消耗），运动数据用 Dashboard 已经加载的 workout 记录（按用户本地日期），不新增接口。圆环和"还剩多少"仍按**摄入**对比每日目标。
- **原因**：每日目标是"摄入目标"（D-21），如果改成按净热量算，运动后目标会"变大"，含义就混了；净热量作为参考数字更直观。

### D-24 目标统一放到 Plan 页，按周存储，日/周自动换算（2026-11-21，取代 D-21 的存储和入口）
- **决定**：新增 Plan 页（侧边栏 Dashboard 下面），摄入目标和消耗（运动）目标两张一样的卡片，每张都有"每日"和"每周"两个输入框，改一个另一个自动换算（×7 / ÷7 取整），保存最后编辑的那个。接口 `PUT /api/user/goals/{intake|burn}`，body `{perDay}` 或 `{perWeek}`（二选一；都不传 = 清除，只有摄入可以清除），返回两个目标的 `{perDay, perWeek}`。Food Log 的 "Edit goal" 和每周目标圆环的铅笔改成跳到 Plan；旧接口 `weekly-goal`、`intake-goal` 删除。
- **存储**：两个目标都**只存每周值**（`Users.WeeklyIntakeGoal` 可空、`Users.WeeklyCalorieGoal` 默认 2000），每日值永远由 `Goals.PerDay` = round(每周 ÷ 7) 算出。这样从哪边设都不会漂移：设每日 1,700 → 存 11,900 → 读回 1,700；设每周 2,000 → 每日 ≈ 286（如果存 286，再 ×7 就成了 2,002）。
- **迁移** `WeeklyIntakeGoal`：把 `DailyIntakeGoal` 改名并 ×7（回滚时 ÷7），在本地 PostgreSQL 上验证过升级和回滚。
- **不变**：设备、上传返回、`/device/me` 里的 `dailyGoal` 由后端换算后返回，固件不用改；`WeeklyCalorieGoal` 的名字保留（AI 助手的工具和周总结都在用），含义就是"每周消耗目标"。
- **颜色**：摄入统一用蓝色 `#2a78d6`（`INTAKE_COLOR`），消耗用主题色。

### D-25 Dashboard 只看"今天"，趋势移到 Statistics 页（2026-11-21）
- **决定**：首页只保留四块：顶部 Points / Streak（不变）→ **净热量横幅**（Eaten − Burned = Net）→ **今日摄入**和**今日消耗**两张对称的圆环卡片 → 一条横向的**签到卡片**。AI 周总结、运动柱状图、每周目标圆环、签到热力图移到新的 **Statistics** 页（侧边栏：Dashboard / Statistics / Plan / Check-in History / Record History / Food Log），第 3 步再重做那一页。
- **净热量**：只有当天**既有饮食记录又有运动记录**时才计算，否则 Net 显示 "—" 并提示补录哪一边——防止忘记记录运动时净热量虚高。代价：真正的休息日不会显示净热量（暂不加"休息日"标记）。
- **两张卡片共用 `TodayCard`**：整圈 = 每日目标（摄入目标 / 每周消耗目标 ÷ 7，D-24），每条记录一段（同一颜色、段间留缝；摄入蓝色、消耗主题色），超过目标整圈变琥珀色；右边是"还差 / 超出多少"和当天列表（最新在上）。消耗卡片底部有本周（周一起）进度条，右上角 "+ Record workout" 打开和悬浮按钮同一个弹窗（开关状态移到 store 的 `recordModalOpen`）。
- **手机顺序**：净热量 → 签到 → 摄入 → 消耗（签到是唯一要"做"的事）；宽屏两张卡片并排、签到在下面。
- **修订（同日）**：去掉页面大标题 "Dashboard" 和日期时钟，签到卡片移到最上面，和 Points / Streak 同一行（手机上签到在上、两个数字卡片在下）；悬浮的聊天按钮不再挡住签到按钮。
- **数据**：摄入在 Dashboard 里每 30 秒刷新（设备在后台上传），运动沿用 `workoutRefreshKey`。

### D-26 消耗目标也可清除；Plan 页加身体数据和一年预测（2026-11-21）
- **左右一致**：两张目标卡片结构完全相同，都有 Clear。`Users.WeeklyCalorieGoal` 改为可空（新账号仍默认 2,000/周）；AI 工具 `get_weekly_goal_progress` 在未设目标时返回 `goal: null` 和说明（不再当作"用户不存在"），周总结的 `goalPercent` 为 null；每周目标圆环显示 "—" 和"set a goal"链接，首页消耗卡片显示"No burn goal yet"。
- **身体数据**（可选，`PUT /api/user/profile`）：性别、出生年份、身高、体重、日常活动量，存在 Users 上；`/user/me` 返回 `profile`。限制见 `Models/BodyProfile.cs`。
- **维持热量** = Mifflin-St Jeor BMR × 日常活动系数（1.2 / 1.3 / 1.45 / 1.6）。系数描述的是**不含已记录运动**的日常活动——运动通过消耗目标单独加上，避免重复计算。
- **一年预测**（前端 `src/projection.ts`，有单元测试；体重最低算到 BMI 13，触底时标题显示 "Dangerously low" 并用红色警示，不再出现负体重）：每天 余量 = 摄入目标 −（当日体重下的维持热量 + 每日消耗目标），7,700 kcal ≈ 1 kg，按新体重每天重新算维持热量（曲线会逐渐变平）。显示 12 个月曲线、一年后体重、"吃 − 维持 − 运动 = 每天余量"的分解；第一个月每周减重超过体重 1%、摄入低于 1,200（女）/1,500（男）、终点 BMI < 18.5 时给出琥珀色提醒；注明是粗略估计、非医疗建议。缺目标或身体数据时列出还缺什么。
- **问号提示** `InfoTip`：全站统一的一个 "?"：悬停显示；点击（手机上点按）固定打开，点别处或按 Esc 关闭，所以里面的链接能点（例如 Points 说明里的 Store）。气泡放在贴着 "?" 的带内边距容器里，鼠标从 "?" 移到气泡上不会消失。用在首页 Points（原来的弹窗已删除）、Net，Plan 各卡片标题、日常活动量、维持热量。
- **迁移** `BurnGoalOptionalAndBodyProfile`；回滚时先把空的消耗目标填回 2,000。

### D-27 Food Log / 运动记录 / 签到记录合并成一个 History 页，用标签切换（2026-11-21）
- **决定**：侧边栏只剩 Dashboard / Statistics / Plan / **History**。History 页标题右侧是三个标签 **Food Log | Workouts | Check-ins**（默认 Food Log），每个标签有自己的地址：`/history/food`、`/history/workouts`、`/history/check-ins`（嵌套路由 + `<Outlet>`，`/history` 跳到 food）。旧地址 `/food-log`、`/record-history` 重定向到对应标签。三个原页面去掉各自的 h1，组件本身不变（设备管理仍在 Food Log 标签里）。
- **原因**：三个都是"看记录"，放在一起侧边栏更短（手机上一行放得下）；独立地址让返回键、收藏和首页的 "Food Log →" 链接都还能用。
- **实现**：`App.tsx` 用 `isDashboardSection(path)` 判断是否显示侧边栏（`/history/*` 前缀匹配），不再是固定列表。

### D-28 页面滚动条改用应用内的浮动滚动条（2026-11-21）
- **决定**：隐藏浏览器自带的页面滚动条（`index.css` 里 `html { scrollbar-width: none }` + `::-webkit-scrollbar`），改用 `OverlayScrollbar`（在 `App` 里挂一次）：叠在内容上、不占宽度；滚轮、触摸滑动、键盘滚动或鼠标靠近右边缘时浮现，约 1 秒后淡出，悬停时变粗，可拖动；页面不需要滚动时不显示。页面内部的滚动区域（列表、聊天）用同色的细滚动条。
- **原因**：自带滚动条只在长页面出现并占掉十几像素，导致长页和短页的内容左右错位（例如 Plan 和 Check-ins）。
- **实现要点**：用 `ResizeObserver` 盯 body 尺寸、`MutationObserver` 盯 body 的 style（弹窗锁定滚动时 `overflow: hidden`，此时隐藏）；拖动按比例换算成 `scrollTo`。

### D-29 首页的消耗加上基础消耗（2026-11-22，修改 D-23 / D-25 的净热量算法）
- **决定**：填了 Plan 页的身体数据后，首页 Burned = **基础消耗** + 当天运动，Net = 吃了 − Burned。基础消耗 = Plan 页的维持热量（Mifflin-St Jeor BMR × 日常活动系数，D-26），**按整天计**，前端由 `user.profile` 现算，不新增接口。Plan 页把这一行改名为 "Base burn (maintenance)"。
- **净热量的条件**：有饮食记录，且消耗一侧有数据（有身体数据，或有运动记录）。没有身体数据时保持 D-25 的老规则（饮食和运动都要有）。
- **不变**：消耗圆环和消耗目标仍然只算运动（目标是运动目标）；消耗卡片底部一行显示 "With base burn X: Y kcal today"，没身体数据时提示去 Plan 填。
- **代价**：按整天计，早上刚吃完早饭时 Net 会是很大的负数；没有按时间折算，免得数字一直在变、难以理解。

### D-30 独立的 Device 页；网页上可以手动记一餐；悬浮 + 改为菜单（2026-11-22）
- **Device 页**：侧边栏 Dashboard / Statistics / Plan / History / **Device**（`/device`），配对、设备列表、移除都从 Food Log 搬到这里（D-27 里"设备管理仍在 Food Log 标签里"不再成立）。以后的设备状态、固件版本等也放这里。
- **手动记一餐**：`POST /api/intake?localDate=`，body 和修改一样 `{foodName, weightGrams, caloriesPer100g}`，热量仍由后端按 重量 × kcal/100g 计算（D-03 的原则）；`Confidence = "manual"`，没有照片，Food Log 标签显示 "Typed in"。只记到今天。
- **入口**：首页摄入卡片右上角 "+ Add meal"（和消耗卡片的 "+ Record workout" 对称）；右下角悬浮 + 点开是两项菜单 Add meal / Record workout。两个弹窗的开关都在 store（`mealModalOpen` / `recordModalOpen`），保存后 `intakeRefreshKey` / `workoutRefreshKey` 加一，各页面据此刷新。
- **悬浮按钮**（聊天、回到顶部、+）离窗口右边 16px（原来宽屏是 64px，会盖住宽页面右侧的数字）。

### D-31 History 三个标签统一成 Food Log 的样式（2026-11-22）
- **决定**：共用 `components/HistoryParts.tsx`（`GroupCard` 卡片标题 + 右侧合计、`Row` 64px 方块 + 名称 + 灰色明细 + 右侧数字 + 图标按钮、`Modal`、`SearchBox`、`ShowMore`）和 `historyFormat.ts`（日期格式、分组、模糊搜索、按钮样式）。Food Log 和 Workouts 每天一张卡片、都有搜索；Check-ins 一天只有一条，所以按月一张卡片。分页器改成 "Show older days/months"（每次 10 张卡片）。
- Food Log 顶部的 "Eaten today + 目标" 卡片删除（目标只在 Plan 设，首页已显示今天的进度）。
- **积分记录**也成为 History 的第 4 个标签 **Points**（`/history/points`），同样每天一张卡片（获得绿色、花费红色），顶部显示余额；右上角用户菜单里的 Points 一行改为跳到这个标签（原来的弹窗 `PointsHistoryModal` 删除）。
- **修订（同日）**：用户菜单里的 Points 一行整个去掉（用户要求）；余额在首页 Points 卡片和 History → Points 标签里都能看到。菜单现在是头像/用户名、Store、Sign out。

### D-32 首页两张卡片加 Today / This week 切换（2026-11-22）
- **决定**：两张卡片上方一个共用的切换（记在浏览器 localStorage）。This week = 本周一到今天：圆环整圈 = 每周目标，每条记录一段；"还差/超出"按每周目标；基础消耗 × 本周已过天数。圆环下方列出该时段的记录（本周时带星期几）。净热量横幅始终是今天。

### D-33 Statistics 页按日历周/月/年统计（2026-11-22，完成首页改版三步计划的第 3 步）
- **决定**：顶部 Intake | Burned 切换；Week（周一至周日）/ Month / Year，‹ › 往回翻（不能翻到未来）。显示合计和日均（**只算有记录的天**——忘记记录的那天不等于没吃），柱状图（周、月每天一根；年每月一根，值为该月的日均），虚线 = 每日目标，点线 = 日均，悬停看数值，纵轴最低 100。下面是排行：摄入 = Top foods（按热量，最多 10 个，按名称不区分大小写合并），消耗 = 按运动类型。AI 周总结和签到热力图保留在下面；每周目标圆环和旧的运动柱状图删除。
- **数据**：摄入用新接口 `GET /api/intake/stats?from=&to=`（每天合计 + Top 10 食物，范围最多 366 天）——普通历史接口只返回最近 500 条，不够一年；运动记录本来就全部返回，在前端统计。周期计算在 `src/stats.ts`（有单元测试），图表是 `PeriodBarChart`（摄入、消耗共用，只换颜色）。

### D-34 AI 助手的预设只留"Set my plan"和"Workout advice"；计划由 AI 提案、用户点 Apply 才保存（2026-11-22）
- **去掉**：Weekly review / Rank / Points / Goal 四个预设——内容在页面上都能直接看到（Statistics、Rank、History → Points、首页）；不选预设直接问，助手仍能查这些数据。**保留** Workout advice（页面上没有的生成内容）。
- **新增 🎯 Set my plan**（模式 `plan`）：工具 `get_plan_context`（当前目标、身体数据、基础消耗 = 和 Plan 页同一个公式的服务器版 `BodyProfile.Maintenance`、最近 28 天的日均摄入和每周运动消耗）和 `propose_goals`（`intakePerDay` / `burnPerWeek`）。
- **写入方式**：`propose_goals` **不写库**，只校验（摄入不低于 1,200 女 / 1,500 男，`BodyProfile.MinSafeIntake`；其余按 `Goals` 上限），合格时服务端发 SSE 事件 `{type:"proposal"}`，聊天里显示"旧值 → 新值"的卡片，用户点 **Apply** 才由前端以用户身份调用 `PUT /api/user/goals/*`（和 Plan 页同一个接口）。模型说错话或被提示注入也改不了数据。
- **只有 plan 模式**能用 `propose_goals`：不选预设时只给只读工具（`ChatToolExecutor.ReadOnlyDefinitions`）。
- **粘性模式**：plan 往往要先问"减重/维持/增重"，所以选了 Set my plan 之后，输入框上方显示 "Set my plan — your replies continue this · Done"，之后打字的回复都继续带 `plan`，点 Done 结束。Workout advice 仍是只对一条消息生效。
- **提示词**：总的每日变化 = 摄入 −（基础消耗 + 每周消耗目标 ÷ 7），不超过约 500 kcal；第一次本地实测模型只按基础消耗算，加上运动后缺口约 690，已在提示词里写明运动也算进缺口。
- 本地用真实 DeepSeek 端到端测过：问目标 → 回答"慢慢减" → 卡片出现时数据库没变 → Apply 后两个目标写入，Plan 页同步更新。

### D-35 周总结和签到热力图搬离 Statistics；+ 按钮悬停横向展开；免责说明（2026-11-22）
- **签到热力图** → History → Check-ins 标签顶部（该标签现在也拉取运动记录，热力图按当天运动消耗着色）。
- **"Last week" AI 周总结** → 宽屏时在**侧边栏导航下面**（`WeeklySummaryCard compact`：日期和 "AI summary" 合成一行小字，正文超高时在卡片内滚动）；手机上侧边栏是顶部横条，放在每页顶部太吵，所以放在首页最下面。用 `hooks/useMediaQuery` 只渲染其中一个，不会请求两次。Statistics 页只剩图表和排行。
- **右下角 +**：鼠标设备（`(hover: hover) and (pointer: fine)`）**悬停**即向左横向展开 Record workout · Add meal（离开 250ms 后收起，跨过间隙不闪）；触屏仍点击展开。横向展开不再盖住上面的"回到顶部"按钮。
- **Add meal 弹窗**：说明手动记录没有照片、热量 = 克数 × kcal/100g；灰底提示 "Have a Stack-chan scale? … Pair it on the Device page →"。
- **免责说明（待办里的 1–5 全做）**：公开页面 `/disclaimer`（登录前后都能打开）；`LegalFooter` "Estimates only, not medical advice · Disclaimer" 放在所有登录后页面、登录页、注册页底部，首页（未登录的 Landing）原有页脚也加上；注册按钮下一行告知；AI 计划卡片 Apply 上方提醒；Plan 页标题下一句；Food Log 搜索框下说明热量来源和 ✎ 修正。

### D-36 AI 助手能看饮食数据；周总结写进饮食；悬浮按钮重排（2026-11-22）
- **新工具 `get_intake_summary`**（只读，不选预设时也可用）：范围 today / yesterday / this_week / last_week / this_month / last_month；返回总摄入、有记录的天数、**按有记录的天算的日均**、每天合计、每日摄入目标、未识别的条数、Top 5 食物。通用提示词加上 "meals (calories eaten)"。实测问"昨天吃了什么""这周吃得怎么样"能正确回答。
- **周总结**：统计里加 `meals`（有饮食记录的天数、总量、日均、超目标的天数、上周日均、最低安全摄入、Top 3 食物）；只有运动和饮食**都没有**时才用固定文案（改为 "Nothing was logged last week…"）。提示词改为健康教练，说明日均只算有记录的天；`minimumSafeIntakePerDay` 是通用安全线不是用户自己设的（实测模型说成了 "the minimum you've set for yourself"，已在提示词里纠正），低于时只能建议多吃一点。已缓存的旧周总结不会重新生成。
- **悬浮按钮**：从下往上 +（bottom-6）、聊天（bottom-24）、回到顶部（bottom-42）；回到顶部只在页面滚动超过 400px 后淡入（Rank 页同样）。
- **暗色主题检查**：所有新页面截图检查过，只有 Points 标签"花费"那一格用的浅粉底在暗色下刺眼，改为半透明红。
- 删除不再使用的 `Pagination` 组件和它的测试。

### D-37 网页上用手机拍照记一餐：识别 → 用户确认 → 保存（2026-11-22）
- **流程**：Add meal 弹窗分 **📷 Photo** / **Type it in**。Photo：`<input type=file accept=image/* capture=environment>`（手机直接开相机）→ 浏览器里缩到长边 1024px、重新编码成 JPEG 质量 0.8（`src/imageResize.ts`；重画到 canvas 会**去掉 EXIF，包括 GPS 位置**；实测 1.28 MB 原图存下来 86 KB）→ `POST /api/intake/recognize`（**不存库**）→ 表单预填名称、kcal/100g、克数 → 用户确认点 Add → `POST /api/intake/photo`（multipart，带照片和确认后的值）。
- **为什么要确认**（用户选的）：没有秤的读数，重量是估的，识别也可能错，存之前看一眼更稳。秤那边保持自动记录（D-07）。
- **克数**：手机照片用单独的提示词和 schema（`FoodPhotoSource.Phone`），让模型额外估可食部分的克数（`estimatedGrams`，限 1–5000），只作为默认值，旁边标 "AI estimate — adjust"。这对 D-03（重量来自测量）是个有意的例外：最终数字由用户确认，热量仍由代码 克数 × kcal/100g 算。秤的提示词不变。
- **来源**：`IntakeRecords.Source` = `scale` / `photo` / `manual`（迁移 `AddIntakeSource`，默认 `scale`，旧的手动记录按 `Confidence = 'manual'` 回填；本地验证过升级和回滚）。Food Log 里 photo 的记录多一个 "Phone photo" 标签（悬停说明重量不是秤测的）。`corrected` = 用户改了模型给的名称或 kcal/100g（只改克数不算）。
- **限额**：识别和秤共用每天 60 次（`AiUsageLogs`），保存走 200 条/天的上限；没 Key → 503，超限 → 429，失败 → 502，前端都给出"再试一次 / 改为手动输入"。非食物不存任何东西。
- 本地用真实 Claude（Haiku）测过两张 Wikimedia 照片：蛋炒饭 → "fried rice with egg" 175 kcal/100g、估 350 g；希腊沙拉 → 95 kcal/100g、估 350 g（两张都估 350，克数仅供参考，用户需要改）。

### D-38 固件 0.6.0：设备状态、离线暂存补传、HTTPS 证书校验（2026-11-22）
- **设备状态**：设备在本来就要发的请求（账号检查、上传、Today 页、补传）里带请求头 `X-Firmware`（`FW_VERSION`，现在 0.6.0）、`X-Wifi-Rssi`、`X-Scale`（秤是否连接）、`X-Queued`（离线暂存的条数）；后端 `DeviceStatus.Apply` 存到 Devices 表（迁移 `AddDeviceStatus`：FirmwareVersion / WifiRssi / ScaleConnected / PendingUploads / StatusAt），Device 页显示 "Firmware 0.6.0 · Wi-Fi fair (−71 dBm) · Scale connected · 2 meals waiting to upload · as of …"（弱信号、秤没接、有待传的标琥珀色）。**不增加请求**，所以不会更频繁地唤醒后端（D-19 的考虑）。
- **离线暂存补传**：上传因为没网、服务器 5xx / 超时（冷启动）、每日上限 429、或者还没对时无法 HTTPS 而失败时，把照片 + 重量 + 拍摄时间 + 本地日期存进闪存（LittleFS，`default_16MB.csv` 的 spiffs 分区，`/q/<拍摄时间>-<序号>.jpg/.txt`），最多 10 条；屏幕显示 "Saved for later"、LED 琥珀色。空闲且在线时后台任务（不画屏，一次一个 TLS 连接）按时间顺序补传，失败退避 1 → 30 分钟；4xx 拒绝的直接丢弃；401 回到配对并清空暂存（属于原账号）。**没网时不再等**：重量稳定就拍照存起来（原来是一直等 Wi-Fi）。主画面 Ready 一行显示 "2 meals waiting to upload / saved offline"。
- **后端**：`POST /api/intake/device` 新增可选 `takenAt`（Unix 秒）：两周内、不超过未来 5 分钟时，记录的 CreatedAt 用它，日期用设备给的本地日期（与拍摄时间的 UTC 日期相差 ≤1 天才接受，否则用 UTC 日期）——补传的旧餐不会被 `ResolveToday` 夹到今天。**去重**：同一设备、同一 `takenAt` 已有记录时直接返回那条（不重复记录、不再花钱识别）——第一次上传超时但服务器其实已存的情况。所有上传都带 `takenAt`，所以第一次和重试能对上。
- **HTTPS**：`beginHttp` 不再 `setInsecure()`，改为 `setCACert(ROOT_CA)`（`include/root_ca.h`：DigiCert Global Root G2——当前链 Microsoft TLS G2 RSA CA OCSP 16 → Microsoft TLS RSA Root G2（交叉签名）→ 它；另带 Microsoft RSA Root CA 2017、DigiCert Global Root CA 以防 Azure 换证书；来自 certifi，`openssl s_client -CAfile` 验证通过）。证书校验要正确时间：未对时最多等 5 秒，仍未对时不发 HTTPS（上传进暂存）。**换后端域名或 Azure 换 CA 时要更新 root_ca.h**，否则设备连不上（症状：串口 "HTTPS" / 所有请求 -1）。
- **真机验证（2026-11-22，PR #16 部署后）**：联网后账号检查 200（证书校验通过）；关热点称了两次 → 都存进闪存、中途重启没丢 → 开热点后按顺序补传，两次都 200；Device 页显示 "Firmware 0.6.0 · Wi-Fi strong (−31 dBm) · Scale connected"。补传那次后端还是旧版，所以记录时间是补传时间；之后补传的会用拍摄时间（未再验证）。
- **已知问题（未修，用户说先不改）**：补传的照片如果被判定为"不是食物"，服务器返回 200 + isFood=false、什么都不记，设备也不提示——那条就悄悄没了（测试时两条只记上一条，最可能就是这个原因；补传任务只打印状态码、没打印回复，无法确认）。可选的修法：①补传时打印回复 + 主画面提示 "1 saved photo wasn't recognised as food"；②补传的非食物照片存成 Unnamed food 让用户自己处理（会放宽 D-05）。

### D-39 在一台 VPS 上自托管第二套部署，与 Azure 互不影响（2026-11-25）
- **决定**：`deploy/vps/`：DigitalOcean 悉尼 2GB Ubuntu + 自己的域名 `kevinzheng.dev`（Cloudflare 注册，DNS only；.com 已被占用）；Docker Compose 跑 Caddy + 后端 + 前端 + Postgres。Caddy 自动申请 Let's Encrypt 证书，同一个域名下 `/api/*` 转给后端、其余转给前端（同源，不涉及 CORS）；只开 22/80/443，数据库不对外。空库开始，`backup.sh` 每天 pg_dump，保留 14 份。在服务器上 `git pull && docker compose up -d --build` 更新（暂不做自动部署）。
- **原因**：用户投 web hosting 公司的岗位，JD 要求 Linux、hosting、域名/DNS；自己从零搭一遍才有真实经历可讲。Azure 那套（D-13）保持不动。
- **共用**：代码、DeepSeek/Anthropic Key（每日上限仍然有效）。账号和数据不互通。
- **设备**：Stack-chan 仍连 Azure。改连 VPS 需要把 ISRG Root X1 加进 `root_ca.h`（D-38）。
- **已知**：配对的按 IP 限流在代理后面看到的是 Caddy 的地址（Azure 上同样如此），等于所有人共用一个额度；用的人少，暂不处理（要处理就加 `UseForwardedHeaders`）。

### D-40 VPS 也接入 CI/CD：Actions 构建镜像，经 SSH 让服务器拉取（2026-11-26，取代 D-39 的手动更新方式）
- **决定**：`deploy.yml` 拆成三个任务：`build`（一次构建 backend、Azure 前端、VPS 前端三个镜像，标签都是 commit 短 SHA）→ `azure` 和 `vps` **并行**（一边失败不影响另一边；`concurrency` 保证不会同时跑两次部署）。`vps` 用 SSH 执行服务器上的 `deploy/vps/deploy.sh <sha>`：`git pull` 拿最新的 compose/Caddyfile → 把 `TAG` 写进 `.env` → `docker compose pull` + `up -d` → 清理旧镜像；然后轮询 `https://kevinzheng.dev/api/health`，直到它报告的 `version` 等于这次的 SHA。
- **原因**：和 Azure 统一（构建一次、到处部署，镜像可追溯到 commit、可回滚）；服务器不再编译（省内存、更新更快）。VPS 前端要单独构建，因为 API 地址在构建时写进 bundle；后端镜像两边共用（配置走环境变量）。
- **安全**：GitHub 用一把专用密钥，在 `authorized_keys` 里用 **forced command** 限定只能运行 `deploy.sh`（并禁止端口转发和 pty），客户端请求的命令只当作 tag 传进 `SSH_ORIGINAL_COMMAND`，脚本只接受 7–40 位小写十六进制。密钥泄露最多只能把网站部署成某个已有版本。`VPS_KNOWN_HOSTS` 固定服务器主机公钥（防中间人）。GitHub Secrets：`VPS_HOST`、`VPS_SSH_KEY`、`VPS_KNOWN_HOSTS`。
- **新接口** `GET /api/health`：检查数据库能否连接，返回 `{status, version}`，`version` 来自环境变量 `APP_VERSION`（compose 里设为 `TAG`；Azure 上没设，为 null）。
- **手动**：服务器上 `./deploy.sh <sha>` 回滚到任何部署过的版本；`TAG=local docker compose up -d --build` 从源码构建（测试分支时用）。
- **坑**：`deploy.sh` 包在 `{ … }` 里，让 shell 先读完整个脚本再执行，因为脚本里的 `git pull` 可能替换它自己。

### D-41 应用搬到子域名 `healthtrack.kevinzheng.dev`，主域名留给作品集（2026-11-26）
- **决定**：Caddyfile 里应用用 `healthtrack.{$DOMAIN}`；`kevinzheng.dev` 和 `www` 暂时 **302** 跳转过去。`.env` 的 `DOMAIN` 仍是主域名（不用改），VPS 前端的 API 地址和部署的健康检查改成子域名（`compose.yml`、`deploy.yml` 的 `VPS_URL`）。DNS 多一条 A 记录 `healthtrack`（灰色云朵）。
- **原因**：以后作品集放在 `kevinzheng.dev`（简历上只写这一个），每个项目一个子域名。趁网址还没传出去先改。用 302 而不是 301：301 会被浏览器和搜索引擎永久缓存，以后主域名换成作品集时，访问过的人还会被带去旧地址。
- **作品集**：打算做成静态网站放 Cloudflare Pages / GitHub Pages，届时把主域名的 DNS 指过去，和服务器互不影响。
- **部署**：Caddy 只在容器启动时读 Caddyfile，所以先单独合并了一个 PR，让 `deploy.sh` 在 Caddyfile 变化时先 `caddy validate` 再重建 Caddy 容器（用 `.caddyfile-applied` 记录上次应用的哈希）；切换子域名的 PR 再合并时由新脚本生效。
- **代价**：浏览器里登录状态存在旧网址下（localStorage 按域名隔离），切换后要重新登录一次。

### D-14 部署工作流暂时只能手动触发（2026-11-18；2026-11-19 已恢复自动部署）
- **决定**：`deploy.yml` 只保留 `workflow_dispatch`。
- **原因**：最初镜像名和应用名都指向 Phase 2，自动部署会覆盖线上服务。现在已改为 `healthtrack-*`，并且首次部署已成功。
- **后续（2026-11-19）**：恢复 `workflow_run`：main 上 CI 通过后自动部署（合并 PR 即上线），保留手动触发。

---

## 7. 开发节点

| 日期 | 节点 |
|---|---|
| 2026-11-18 | 从 Phase 2 复制出新仓库；部署改为仅手动触发 |
| 2026-11-18 | 后端：设备配对、上传接口、Claude 识别、迁移 `AddDevicesAndIntake`、17 个测试；前端 Food Log 页 |
| 2026-11-18 | 改为"先只传照片 + 重量"，端到端测试通过（照片字节一致，无 token 返回 401） |
| 2026-11-18 | 首个固件烧录到 Stack-chan；修复屏幕旋转；真机通过局域网上传了第一批照片 |
| 2026-11-18 | 秤热插拔、离线容错、Wi-Fi 兜底重连 |
| 2026-11-18 | 全幅预览布局、TARE、零点跟踪；I2C 交还 → 触摸可用 |
| 2026-11-18 | 舵机控制、设置页（亮度/Home/关机）、摇杆对准 |
| 2026-11-18 | 首批 5 个提交，PR #1 创建 |
| 2026-11-18 | 接入 Anthropic Key，网图测试识别准确；改用 Haiku；真机放鼠标正确判为非食物 |
| 2026-11-19 | Azure 单独部署：Neon 新库、两个 Container App、GitHub Secrets；PR #1 合并（`192148d`），Deploy 成功 |
| 2026-11-19 | Stack-chan 改连线上 HTTPS 后端，重新烧录 |
| 2026-11-19 | 新建 AGENTS.md |
| 2026-11-19 | 分支 `feature/device-setup`：配对码接口 + 迁移 `AddDevicePairing` + 9 个测试（共 112 个）；网页"Add device"输入配对码；固件手机配网、多网络保存、配对界面、401 回到配对；已烧录，旧配置自动导入 NVS |
| 2026-11-19 | PR #2 合并，CI 通过后自动部署成功（Deploy #3） |
| 2026-11-19 | 分支 `fix/pairing-polish`：Reset 后不再重新导入 `secrets.h`；配对后设备显示账号名（主画面左上角）；设备自检接口 `/api/device/me`（D-19）；Food Log 改为 5 秒刷新；Wi-Fi 列表滑动 + 展开操作；Reset → Unpair、硬件 ID 去重（D-20）；设置页改为全屏列表（不显示相机画面，Back 在右上角，亮度滑条，行：Light / Wi-Fi / Account+Unpair / Head+Center / Power），Wi-Fi 的 Password 预填已保存的密码 |
| 2026-11-19 | PR #4 合并，自动部署成功（`8507426`，`/api/device/me` 上线）；分支 `feature/touch-account-check`：触摸触发账号检查 |
| 2026-11-19 | 每日摄入目标（迁移 `AddDailyIntakeGoal`，共 124 个测试）+ Dashboard 环形图；设备实时画面右上角显示本地时间（NTP，`TIMEZONE`） |
| 2026-11-19 | PR #5 合并并自动部署（`600048c`）：每日目标、Dashboard 圆环、设备时钟和摄入圆环、触摸检查账号 |
| 2026-11-20 | 账号检查失败后退避重试；设备 Today 页：查看/删除当天记录（D-22，共 131 个测试）—— PR #6 合并部署（`16b952b`） |
| 2026-11-20 | Today 页行展开（同 Wi-Fi 列表）、最新在上、打开时每 10 秒刷新、3 分钟无操作自动关闭 —— PR #7 合并部署（`d290b1c`） |
| 2026-11-20 | 真机实拍真实食物（番茄、炒肉、炒饭、烤串、火龙果）已能识别入库，kcal/100g 合理 |
| 2026-11-21 | Dashboard 净热量（D-23）；串口日志过滤脚本 `tools/serial_log.py` |
| 2026-11-21 | 浮动滚动条（D-28）：长短页面宽度一致；预测加 BMI 13 下限（极端输入不再算出负体重）、纵轴不低于 0、算式不折行 |
| 2026-11-21 | 首页顶部：去掉标题，签到卡片和 Points / Streak 一行；问号提示统一为 `InfoTip`（悬停 + 点击固定），Points 说明从弹窗改为提示 |
| 2026-11-21 | History 页：Food Log / Workouts / Check-ins 三个标签（D-27），旧地址重定向；本地截图确认跳转和手机布局 |
| 2026-11-21 | Net 问号提示；Plan 页左右一致（消耗目标可清除）、身体数据、一年体重预测（D-26，迁移 `BurnGoalOptionalAndBodyProfile`，后端 153 / 前端 47 个测试） |
| 2026-11-21 | 第 2 步：Dashboard 只看今天（D-25）：净热量横幅、今日摄入/消耗对称圆环卡片、横向签到卡片；临时 Statistics 页放原来的图表；本地 Playwright 截图检查了桌面和手机布局 |
| 2026-11-22 | 首页 Burned / Net 计入基础消耗（D-29）；本地截图检查了三种情况（有身体数据 ± 运动、无身体数据）和手机布局 |
| 2026-11-22 | Device 页、手动记一餐、+ 菜单（D-30）；History 统一样式（D-31）；首页 Today / This week（D-32）；Statistics 周/月/年重做（D-33）。后端 159 / 前端 54 个测试，本地 Playwright 截图检查了宽屏和手机 |
| 2026-11-22 | AI 助手：Set my plan（提案 + Apply 卡片，D-34）；后端 164 / 前端 56 个测试；本地用真实模型端到端验证 |
| 2026-11-22 | PR #10（History 标签、浮动滚动条）、#11（基础消耗、Statistics、Device 页、History 统一样式、Points 标签）、#12（AI Set my plan）合并，均自动部署成功（最新 `b2fa03c`）。存档：待办新增 4 项（Statistics 下两块挪走、+ 按钮悬停横向展开、Add meal 说明和设备入口、免责说明），下次从这里开始 |
| 2026-11-22 | 4 项待办完成（D-35）：周总结进侧边栏、热力图进 Check-ins、+ 悬停横向展开、Add meal 说明、免责说明页和各处提醒；前端 57 个测试，本地截图检查了宽屏、手机、注册页和说明页 |
| 2026-11-22 | AI 看饮食、周总结写饮食、悬浮按钮重排、暗色检查（D-36）；后端 167 / 前端 51 个测试（删了 Pagination 的 6 个） |
| 2026-11-22 | 网页拍照记一餐（D-37，迁移 `AddIntakeSource`）；后端 171 / 前端 57 个测试；本地用真实 Claude 端到端验证 |
| 2026-11-22 | 修复手机上 Plan 页被整体缩小（`InfoTip` 隐藏的气泡撑宽页面）；所有页面在 375px 下宽度检查通过 |
| 2026-11-22 | 固件 0.6.0（D-38）：设备状态头、离线暂存补传、HTTPS 证书校验；后端 `takenAt` + 去重 + 迁移 `AddDeviceStatus`（177 个测试）；Device 页状态；已烧录（开机正常，设备处没 Wi-Fi，联网部分待验证） |
| 2026-11-22 | PR #16 合并部署（`d744aec`）：固件 0.6.0 的后端支持、设备状态、Plan 页手机修复；真机验证 HTTPS 证书校验、离线暂存补传、Device 页状态。存档：下一步用户想研究本地部署 AI（单独的新项目，给本项目调用） |
| 2026-11-22 | 本地 AI 研究项目 `E:\CodeLearning\LocalAI`（Ollama + Qwen3 8B，模型在 `D:\LocalAI\models`）：HealthTrack 式工具调用测试全过，关思考 4.5 秒/题。本项目**没改代码**；本地后端设 `DeepSeek__BaseUrl=http://localhost:11434/v1` 等即可切过去（见 LocalAI 的 `docs/healthtrack.md`），要关思考需新增可选配置 `DeepSeek:ReasoningEffort`。存档：用户说先不做集成 |
| 2026-11-21 | 统计/首页改版三步计划的第 1 步：Plan 页 + 目标按周存储（D-24，迁移 `WeeklyIntakeGoal`，共 141 个测试）。第 2 步首页改版、第 3 步统计页（Intake/Burned 切换，自然周/月/年可往回翻，日均只算有记录的天，排行榜） |
| 2026-11-25 | 自托管部署文件 `deploy/vps/`（D-39）；README 按现在的项目重写（Phase 2 提交时的 README 存为 `specs/07-phase2-submission-readme.md`）；英文版 AGENTS.en.md |
| 2026-11-26 | **存档**（2026-11-25～26 这一轮）：①写了 VPS 部署文件（Compose + Caddy + Postgres + 备份，D-39）；②租了 DigitalOcean 悉尼 2GB、在 Cloudflare 买了 `kevinzheng.dev`、配 A 记录（灰色云朵），手动部署上线并验证注册 / AI / 拍照识别；③每天 cron 备份；④README 按当前项目重写，Phase 2 的 README 存进 `specs/`；⑤AGENTS 出了英文版并成为主文件（中文改名 `AGENTS.cn.md`）；⑥VPS 接入 CI/CD（D-40，forced command 部署密钥、`/api/health` 带版本号），PR #17 / #18 / #19 合并，自动部署跑通。下一步见第 9 节新加的几条（备份异地存放、域名邮件防伪造、合并后的分支清理等） |
| 2026-11-26 | PR #19 合并（`bbe3b8f`），VPS 自动部署跑通：第一次因为 GitHub Secrets 没加好在 "Set up SSH" 失败，换了一把部署密钥、补好 Secrets 后 Re-run failed jobs，build / azure / vps 全部成功，`/api/health` 返回 `version: bbe3b8f`，两套部署的网页标题都变成 HealthTrack |
| 2026-11-26 | 英文版改名为 `AGENTS.md`（主文件，agent 工具会自动读取），中文版改名为 `AGENTS.cn.md` |
| 2026-11-26 | VPS 接入 CI/CD（D-40）：`deploy.yml` 拆成 build → azure / vps 并行，forced command 限定部署密钥，`/api/health` 带版本号；本地验证了 compose 配置、tag 校验（拒绝 `abc1234;rm` 等）和 health 返回值，177 个测试通过 |
| 2026-11-26 | PR #17 合并；VPS 上线：DigitalOcean 悉尼 2GB（`209.38.84.117`）+ Cloudflare 注册的 `kevinzheng.dev`（灰色云朵），Caddy 自动拿到证书，www 和 http 都跳转到 https://kevinzheng.dev。注册、签到、AI 助手（DeepSeek）、手机拍照识别（Claude，香蕉 89 kcal/100g）都在线上验证过；每天 3:00 UTC cron 备份。网页标题 "frontend" 改为 "HealthTrack" |

---

## 8. 踩过的坑

- **Azure "另存为新修订"是基于所选版本生成的**：在缩放页基于 `--0000001`（没有环境变量）保存，新版本拿走了 100% 流量，于是连到默认的 `localhost/healthtracker` 而崩溃（退出码 139）。改配置前一定要确认"基于修订"选的是最新的正确版本。**改机密不会产生新版本**，需要重启或新建版本才会生效。
- **连接串格式**：Npgsql 不认 `postgresql://` 这种网址格式，要用 `Host=…;Database=…;Username=…;Password=…;SSL Mode=Require`。
- **容器一启动就崩溃时**，实时日志流连不上（没有副本）；去"监视 → 日志"用 KQL 查 `ContainerAppConsoleLogs_CL`。
- **PY32 IO 扩展芯片在 400kHz 下**能响应地址扫描，但读寄存器返回 0；改 100kHz（和官方一致）。
- **刚上电的舵机**需要几百毫秒才响应 Ping；开机重试，加上 30 秒内的后台重试。
- **Arduino 的 `degrees` 是宏**，不能用作函数名。
- **FTServo 用的是 IDF 5 的 `UART_SCLK_DEFAULT`**；Arduino-ESP32 2.x 是 IDF 4.4，要用 `UART_SCLK_APB`。
- **Wi-Fi 库自带的自动重连**对 `ASSOC_LEAVE` 等原因不会重试；需要自己的看门狗（每 20 秒）。
- **C 盘满导致工具链安装失败**；PlatformIO 用 `PLATFORMIO_CORE_DIR='E:\.platformio'`。
- **`| tail` 会吞掉退出码**：编译看起来成功，实际失败了；要用 grep 查 SUCCESS/FAILED。
- **Wikimedia `Special:FilePath`** 对不存在的文件返回 404 HTML，频繁请求返回 429；下载后要检查 content-type。
- **固件工具链默认 C++11**：lambda 参数不能写 `auto`。
- **ESP32 只支持 2.4GHz**：双频合一（2.4G/5G 同名）的网络可以看到也能连上（只会连 2.4G）；分开命名时只会看到 2.4G 那个；只发 5G 的网络或扩展器（例如家里的 `DN8245-2CD9_5GEXT`）看不到。隐藏网络不会出现在设备列表里，目前只能在手机配网页面手动输入。
- **ESP32 只有一个无线电**：AP+STA 模式下，热点必须和 STA 用同一信道。STA 一扫描或连上别的信道的路由器，热点就会跟着跳，连着的手机就会掉线。配网期间要让 STA 保持安静。
- **"NVS 为空时从 `secrets.h` 导入"不等于只导入一次**：Reset 清空 NVS 后，设备一重启就把旧 Wi-Fi 和旧密钥又导入回来，于是不会出现配对码。改为在 `hts` 命名空间记一个 `seeded` 标记（Reset 不清除），只在第一次开机时导入。
- **主循环里的同步 HTTP 请求会冻结屏幕**：后端最小副本为 0 时冷启动要 20–30 秒，期间画面不刷新、触摸没反应（例如 Reset 后点 Exit 像是退不出来）。配对请求和账号检查都放进 FreeRTOS 后台任务，主循环只处理结果。
- **`net::forgetAll()` 只删保存的网络，不断开当前连接**：Reset 时要再调用 `WiFi.disconnect(false, true)`（同时清除 SDK 自己保存的凭据）。
- **一次触摸会穿透到下一个界面**：`tapNow` 在整轮 `loop()` 里都有效。Wi-Fi 列表的 Exit 和配对界面的 Wi-Fi 按钮在同一位置，点 Exit 后同一轮里又触发了 Wi-Fi，表现为"回不去配对码"。界面切换后要把 `tapNow` 置为 false。
- **Bash heredoc 里的 Python 补丁脚本会把 `\n` 变成真换行**：C++ 字符串里的 `\n` 被破坏，断言失败（或更糟，悄悄写坏文件）。补丁脚本先写到 scratchpad 的 `.py` 文件再运行；文件是 CRLF，脚本里先转 LF、写回时再转 CRLF。
- **读串口要用不带 `-I` 的 python**：pyserial 装在用户 site-packages，`python -I` 找不到。用 `python firmware/stackchan-scale/tools/serial_log.py [COM3] [秒数]`，它会过滤相机的丢帧警告。
- **`cam_hal: EV-EOF-OVF` / `EV-VSYNC-OVF` 刷屏关不掉**：预编译相机驱动在中断里用"早期日志"打印（每秒好几条），`esp_log_level_set` 管不到；试过 XCLK 6MHz（更多）、`CAMERA_GRAB_WHEN_EMPTY`（更多），都没用，已还原。只是预览丢帧，拍照不受影响；读日志时过滤即可。
- **开机那次账号检查失败 → 摄入圆环不出现**：圆环要有数据才画；原来失败后要等 6 小时才重试（已改为退避重试，D-19）。
- **固件里函数/变量的定义顺序**：`main.cpp` 是单文件，新代码用到后面才定义的东西（`inRect`、`todayBusy`、`localDate`）会编译失败；把定义挪到前面或加前置声明。
- **页面宽度按路由写死在 `App.tsx`**：只有 `isWide` 的路由用 `lg:max-w-5xl`，其他是 `lg:max-w-2xl`。新页面放宽屏内容时要加进 `isWide`（Statistics 一开始只有 672px 宽）。
- **看前端效果**：本机有 Playwright + Edge（`p.chromium.launch(channel='msedge')`）。本地后端 `:5000` + `npx vite`，注册临时账号、`localStorage` 写 `token/userId/username` 后截图；用完删掉临时账号和它的记录（`IntakeRecords`、`WorkoutRecords`、`Users`）。
- **PowerShell 5.1 会吞掉传给原生程序的双引号**：`psql -c 'DELETE FROM "Users" …'` 到了 psql 那里变成 `DELETE FROM Users`（表名被转小写，报"关系不存在"）。带引号的 SQL 用 Bash 跑。
- **停掉后台的 `npx vite` 任务不会结束 node 子进程**（两次都留下了）：下次 `--strictPort` 会报端口被占用（旧进程还在用磁盘上的新代码提供页面）。用 `Get-NetTCPConnection -LocalPort 5173` 找到 PID，确认命令行是本仓库的 vite 后再停。
- **本地后端 AI "unavailable"**：`dotnet run --no-launch-profile` 不设环境，默认 Production，不加载 user-secrets，日志里是 "DeepSeek API key is not configured"。加 `ASPNETCORE_ENVIRONMENT=Development`。
- **跑后端测试前先停掉本地后端**：`dotnet run` 的进程锁着 `bin/Debug/net10.0/backend.exe`，`dotnet test` 构建会失败（MSB3027）。
- **Playwright 截暗色主题**：主题是皮肤（`data-theme` 由已装备的皮肤决定，Users 表里没有主题列）。`add_init_script` 设 `data-theme` 没用（太早，文档还没建好），要在页面加载后 `page.evaluate` 设置，再用 MutationObserver 防止应用改回去。
- **Playwright 按钮名默认是子串匹配**：`get_by_role('button', name='Add')` 同时匹配 "+ Add meal" 和 "Add a meal or workout"，严格模式报错；要加 `exact=True`。另外 multipart 请求的 `post_data_buffer` 取不到大小（是 0），要看上传多大去查数据库里的 `length("ImageData")`。
- **隐藏但仍占布局的元素会把手机页面撑宽**：`InfoTip` 原来用 `invisible`（visibility: hidden）藏气泡，气泡还在布局里；靠右的 "?" 的 256px 气泡伸出屏幕 81px，Plan 页宽度变成 456px，手机浏览器（微信里打开）就把整页缩小，看起来字小、右边空一条。现在气泡只在打开时渲染，打开后测量位置并平移回屏幕内（左右留 8px）。查这类问题：手机宽度下比较 `document.documentElement.scrollWidth` 和 `clientWidth`，再找 `getBoundingClientRect().right` 超出的元素。
- **前端测试要在 PowerShell 里跑**：在 Git Bash 里 `npm test` 报 "Vitest failed to find the runner"（全部失败，不是代码问题）。
- **新增 GitHub Secret 后，合并之前先截一张 Repository secrets 列表确认**：Secret 写进去后谁都看不到内容，工作流里读到空值才会报错。VPS 自动部署第一次就是因为 `VPS_SSH_KEY` / `VPS_KNOWN_HOSTS` 没加好，在 "Set up SSH" 失败（工作流会明确提示）。也要确认加在 **Secrets → Repository secrets**，不是 Variables 或 Environment secrets。
- **部署密钥的本地副本要等部署真正跑通再删**：太早删了，Secret 又没加好，就只能重新生成一把、服务器上换锁（`sed -i '/github-actions-deploy$/d' ~/.ssh/authorized_keys` 再追加新的）。验证 forced command：用部署密钥 `ssh root@<ip> whoami`，应该得到 `usage: deploy.sh <commit-sha>`，而不是 `root`。
- **EF Core 的 `ExecuteDeleteAsync`** 内存测试库不支持；需要在测试里跑到的代码改用加载后 `RemoveRange`。

---

## 9. 待办 / 未决

- [x] 用 Stack-chan **实拍真实食物**测试识别效果 —— 已能识别常见食物；继续留意 `Check me` 的比例和混合菜的偏差
- [ ] 相机对准：秤放在 Stack-chan 前方 20–30cm，用摇杆调整
- [x] 恢复 CI 通过后自动部署（D-14）
- [x] 手机配网（D-16）、配对码（D-15）—— 待部署后在真机上验证配对流程
- [x] HTTPS 证书校验（D-38，待联网真机验证）
- [x] 上传失败暂存 + 补传（带实际称重时间）（D-38，待真机验证）
- [ ] OTA 固件升级；时区跟随账号设置；~~网页显示设备状态（版本、信号、秤、待传）~~（D-38；电量没做，设备一直插电）
- [ ] Stack-chan 处的 2.4GHz 信号很弱（−70～−76dBm）
- [ ] 设备上的 Wi-Fi 列表加"其他网络…"，可以手动输入隐藏网络的名字；确认仅 WPA3 的网络能否连接
- [x] 后端最小副本 0 → 冷启动 20–30 秒：**维持 0**（2026-11-22 用户决定）。改成 1 会一直计费；冷启动导致的上传超时现在由固件的离线暂存补传兜住（D-38），不再丢数据
- [ ] 舵机堵转保护（官方固件有）
- [ ] 与现有功能联动：~~Dashboard 摄入~~（D-21）、~~Dashboard 净热量~~（D-23）、~~AI 助手读取摄入数据~~（D-36）、积分（用户说暂缓）
- [x] 串口日志被 `cam_hal: EV-EOF-OVF` 刷屏 —— 固件里关不掉（见"踩过的坑"），改用 `tools/serial_log.py` 过滤
- [ ] 秤的玩法：饭后称剩菜（按差值记实际吃掉的量）；一盘逐个加食物（按重量差分别识别）
- [ ] 设备上的摄入圆环只在上传/账号检查时更新，网页改动要碰一下设备才显示（D-21，目前可接受）
- [x] README 补充智能秤功能说明（2026-11-25，README 已重写）
- [ ] 识别失败（或误判为非食物）的照片是否要保留供人工确认——补传时尤其明显，见 D-38 的"已知问题"
- [x] **Statistics 页下面两块挪走**（2026-11-22 已完成，见 D-35）（2026-11-22 用户提出）："Last week" AI 周总结和签到热力图不跟随页面的周/月/年和 Intake/Burned 切换，放在统计页里显得不搭。我的初步想法（未定）：签到热力图 → History → Check-ins 标签顶部（本来就是签到记录，热力图自带月/年切换）；AI 周总结 → 首页底部，或者做成 AI 助手里"上周回顾"的内容，或单独放进侧边栏。做之前和用户确认放哪里。
- [x] **右下角 + 按钮改交互**（2026-11-22 已完成，见 D-35）（2026-11-22 用户提出）：鼠标**悬停**就**向左**横向弹出 Add meal / Record workout 两个按钮（现在是点击后向上弹出，会盖住上面的"回到顶部"按钮）。手机上没有悬停，仍然点击展开。
- [x] **Add meal 弹窗加设备入口和说明**（2026-11-22 已完成，见 D-35）（2026-11-22 用户提出）：例如 "Have a Stack-chan scale? Weigh food on it and it's logged with a photo automatically — pair it on the Device page →"，说明手动添加和秤自动记录的区别（手动没有照片，热量 = 克数 × kcal/100g）。
- [x] **免责说明**（2026-11-22 已完成，见 D-35）（2026-11-22 讨论，用户说"之后做"）。现有：聊天底部 "AI answers can be wrong. Not medical advice."、Plan 预测 "A rough estimate, not medical advice."。计划加（文案英文）：
  1. 新页 `/disclaimer` + 每页底部（含登录/注册）一行 "Not medical advice · Disclaimer"：不是医疗服务；热量/基础消耗/预测/AI 建议都是估算；怀孕或哺乳、未满 18 岁、慢性病、进食障碍史者先咨询专业人士；不适时停止运动
  2. 注册按钮下一行告知并链到说明页（不加勾选框）
  3. AI 计划卡片 Apply 上方："A suggestion, not medical advice. Check with a professional if you're pregnant, under 18 or have a health condition."（唯一会写数据的地方，最必要）
  4. Plan 页顶部一句提醒
  5. Food Log 搜索框下："Calories are estimates from the photo and the scale's weight; tap ✎ to correct."
  —— 我的建议是 1 + 3 必做，2、4、5 可选；用户还没定做哪几项
- [ ] **VPS 收尾**（2026-11-26）：①备份只在服务器上，偶尔用 `scp` 拷回本地，或者推到对象存储；②`kevinzheng.dev` 不发邮件，加 SPF（`v=spf1 -all`）和 DMARC（`p=reject`）两条 TXT 记录，防止别人冒充这个域名发信（Cloudflare 的建议）；③删掉已合并的分支（`chore/vps-live`、`feature/vps-cd`、`feature/vps-deploy`、`chore/notes-2`）；④后端加 `UseForwardedHeaders`，让配对限流在 Caddy / Azure 代理后面拿到真实 IP（D-39 已知问题）；⑤可选：镜像从 Docker Hub 换到 GHCR，少存一组凭据；⑥可选：Stack-chan 改连 VPS 需要在 `root_ca.h` 加 ISRG Root X1
- [ ] **营养素和建议摄入量**（2026-11-23 用户提出，想法阶段，未定）：除了热量，再记录蛋白质 / 碳水 / 脂肪（以后可以加纤维、糖、钠），并给出每天的建议量。我的初步想法：
  1. **识别**：模型多返回每 100g 的蛋白质、碳水、脂肪（和 kcal/100g 一样只给语义），克数仍由代码乘实测重量（D-03 的原则）；手动记一餐、修改弹窗也加这三栏。`IntakeRecords` 加可空列，旧记录为空、统计时显示"部分记录没有营养数据"
  2. **建议量**：用 Plan 页的身体数据算，不靠模型——蛋白质按体重（例如 1.2–1.6 g/kg，减重时偏高），脂肪约占热量 20–35%，碳水补足剩下的热量；放在 Plan 页（和摄入目标同一张卡片，或者新开一张），首页摄入卡片下面加三条小进度条
  3. **展示**：Food Log 每条记录的灰色明细加 P/C/F；Statistics 的 Intake 加营养素比例；AI 助手的 `get_intake_summary` 和周总结带上营养素
  4. **以后：食谱推荐**：根据今天还差多少热量和蛋白质，让 AI 推荐下一餐（例如"还差 40g 蛋白质、600 kcal"）；数字由代码算好再交给模型，模型只负责推荐菜。可以先做成 AI 助手里的一个预设，不写库
  —— 问题：照片估营养素比估热量误差更大（尤其混合菜），需要标成估算；做之前先用真实照片测一下 Haiku 给的营养素靠不靠谱
