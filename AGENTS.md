# AGENTS.md

给在这个仓库里工作的 AI agent（以及回头翻看的自己）的项目手册：结构、命令、约定、**关键决策**和**开发节点**。

**维护规则**：每做出一个关键决策、完成一个节点、踩到一个值得记的坑，就更新对应章节。决策只追加不删除；被推翻的决策标注"已被 D-xx 取代"。

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
# 本地后端给局域网设备用（不要碰 Phase 2 的 healthtracker 库）
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

### D-21 每日摄入目标存为用户上的一个值，自动顺延（2026-11-19）
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

### D-23 净热量只做展示，目标仍然比较"吃了多少"（2026-11-21）
- **决定**：Dashboard 的 "Today's intake" 卡片加一行 Eaten / Burned / Net（摄入 − 当天运动消耗），运动数据用 Dashboard 已经加载的 workout 记录（按用户本地日期），不新增接口。圆环和"还剩多少"仍按**摄入**对比每日目标。
- **原因**：每日目标是"摄入目标"（D-21），如果改成按净热量算，运动后目标会"变大"，含义就混了；净热量作为参考数字更直观。

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
- **EF Core 的 `ExecuteDeleteAsync`** 内存测试库不支持；需要在测试里跑到的代码改用加载后 `RemoveRange`。

---

## 9. 待办 / 未决

- [x] 用 Stack-chan **实拍真实食物**测试识别效果 —— 已能识别常见食物；继续留意 `Check me` 的比例和混合菜的偏差
- [ ] 相机对准：秤放在 Stack-chan 前方 20–30cm，用摇杆调整
- [x] 恢复 CI 通过后自动部署（D-14）
- [x] 手机配网（D-16）、配对码（D-15）—— 待部署后在真机上验证配对流程
- [ ] HTTPS 证书校验（目前 `setInsecure()`，见 `beginHttp` 的 TODO）
- [ ] 上传失败暂存 + 补传（带实际称重时间）
- [ ] OTA 固件升级；时区跟随账号设置；网页显示设备状态（版本、电量、信号）
- [ ] Stack-chan 处的 2.4GHz 信号很弱（−70～−76dBm）
- [ ] 设备上的 Wi-Fi 列表加"其他网络…"，可以手动输入隐藏网络的名字；确认仅 WPA3 的网络能否连接
- [ ] 后端最小副本 0 → 冷启动 20–30 秒，可能导致长时间闲置后的第一次上传超时；决定是否改为 1
- [ ] 舵机堵转保护（官方固件有）
- [ ] 与现有功能联动：~~Dashboard 摄入~~（D-21）、~~Dashboard 净热量~~（D-23）、AI 助手读取摄入数据、积分（用户说暂缓）
- [x] 串口日志被 `cam_hal: EV-EOF-OVF` 刷屏 —— 固件里关不掉（见"踩过的坑"），改用 `tools/serial_log.py` 过滤
- [ ] 秤的玩法：饭后称剩菜（按差值记实际吃掉的量）；一盘逐个加食物（按重量差分别识别）
- [ ] 设备上的摄入圆环只在上传/账号检查时更新，网页改动要碰一下设备才显示（D-21，目前可接受）
- [ ] README 补充智能秤功能说明
- [ ] 识别失败（或误判为非食物）的照片是否要保留供人工确认
