# WebDrop — 网页文件传输工具

WebDrop 是一个无需安装客户端、打开浏览器即可使用的文件传输与聊天工具。支持**点对点（P2P）**与**房间**两种模式，采用 WebSocket + WebRTC DataChannel 实现直连，失败自动回退服务器流式中转（不落盘）；单容器 Docker 部署，配置与数据全部挂载在宿主机上，可轻松私有化部署。

## 效果截图

| 点对点会话 | 房间聊天 |
| --- | --- |
| ![P2P 会话](docs/screenshots/p2p-chat.png) | ![房间聊天](docs/screenshots/room-chat.png) |

| 房间文件（缩略图模式） | 管理台仪表盘 |
| --- | --- |
| ![房间文件](docs/screenshots/room-files.png) | ![管理台](docs/screenshots/admin.png) |

| 点对点在线列表 | 手机端房间 |
| --- | --- |
| ![在线列表](docs/screenshots/p2p-home.png) | ![手机端](docs/screenshots/mobile-room.png) |

## 功能特性

### 点对点模式（免登录）
- 打开网页自动分配临时身份与趣味昵称（如"可爱的桃子""愤怒的香蕉"），进入即在线；聊天消息显示发送时间，可一键注销释放身份。
- 同一浏览器不允许多开；同一账号可多端登录，设备按指纹生成唯一 UUID，在线列表同时展示"在线设备"与"在线用户"，会话按设备建立。
- 优先尝试 WebRTC 直连（ICE 候选优先 IPv6），同一局域网自动识别并优先局域网地址；失败自动回退服务器中转（不落盘）。
- 文本实时送达；< 10M 文件服务器暂存，> 10M 需对方点击接收后传输，接收完成自动下载；大文件传输支持随时取消。
- 会话建立前仅展示请求列表，建立后只显示聊天窗口；会话中的用户对其他用户显示"繁忙"。
- 选文件时心跳自动放宽到 5 分钟，回到聊天界面立即检查对方在线状态并补拉错过的消息。

### 房间模式（注册制）
- 注册需邮箱或 QQ，管理员审核通过后登录；房间数量按会员等级（V0-V6）分配。
- 随机 6 位房间号；自定义房间号需管理员审批；可设置房间密码（默认无）。
- 文字、语音（m4a 录制）、照片、视频、任意文件；上传带进度条，完成后其他成员才能看到。
- 房主可设置文件最长保留时间、单文件上限、房间总容量、上传/下载权限，可踢出/拉黑成员，可删除/恢复聊天消息。
- 房间文件支持缩略图/列表模式、分类筛选、名称搜索、文件夹管理（创建/重命名/移动/删除，仅房主）。
- 已删除的文件不在列表中展示，聊天气泡显示"文件已删除"；成员列表仅显示当前在线成员。

### 管理后台
- 通过http://host[:port]/admin , 可以打开管理后台
- 唯一管理员 `admin:admin`，首次登录强制修改用户名和密码；登录后直接进入管理台，不参与普通用户功能。
- 仪表盘实时监控 CPU / 内存 / 存储占用；文件管理按会话与房间分组；房间管理可查看与修改每个房间的设置。
- 用户管理支持审批、封禁、删除与会员等级调整，可一键清理全部临时用户。
- 主题系统：管理员可上传/删除公共主题、下载默认模板、设置全局主题；用户可上传个人主题并预览。

## 主题系统

WebDrop 默认采用新拟物派（Neumorphism）风格，并内置了 6 套风格各异的公共主题：**暗黑模式、孟菲斯风格、拟物风格、漫画风格、蒸汽朋克、吉卜力风格**。登录用户在设置页即可一键切换，管理员还能将任意主题设为**全局默认主题**（所有人跟随）。下面为默认主题与其中 3 套内置主题在房间页面的实际效果：

| 默认主题（新拟物派） | 暗黑模式 |
| --- | --- |
| ![默认主题](docs/screenshots/theme-default.png) | ![暗黑模式](docs/screenshots/theme-dark.png) |

| 孟菲斯风格 | 吉卜力风格 |
| --- | --- |
| ![孟菲斯风格](docs/screenshots/theme-memphis.png) | ![吉卜力风格](docs/screenshots/theme-ghibli.png) |

### 自制主题

主题以 zip 包形式分发，内含两个文件：

```text
主题包.zip
├── theme.json   # { name, version, author, description }
└── theme.css    # 覆盖 :root 下的 CSS 变量（模板内含详细注释）
```

主题包存放位置与权限：

| 上传者 | 位置 | 权限 |
| --- | --- | --- |
| 管理员 | `data/themes/public/` | 所有用户可见；管理员可删除 |
| 注册用户 | `data/themes/{用户UUID}/` | 仅自己可见；注销账号时自动删除 |

- 管理员可在主题管理中**下载默认模板 zip**，修改 `theme.css` 变量即可快速换肤；
- 用户设置页同样提供模板下载；公共主题只读，个人主题可上传/删除；
- 选中主题包会打开**预览窗口**，渲染各界面效果图并展示版本、作者与描述；
- 用户可在"跟随全局（默认）/ 指定主题"之间切换；管理员确认后可将主题设为全局默认。

## Docker 部署（推荐）

项目使用单容器架构，只需一条命令即可启动；`config/` 与 `data/` 两个目录绑定挂载到宿主机，数据持久化、升级与迁移都非常简单。

### 方式一：docker compose（推荐）

```bash
# 1. 克隆仓库
git clone https://github.com/kuka1774083-wq/WebDrop.git
cd WebDrop

# 2. 启动（首次会自动构建镜像）
docker compose up -d --build

# 3. 查看状态
docker compose ps
```

启动完成后访问 `http://服务器IP:60003`（端口可在 `docker-compose.yml` 中修改），使用 `admin / admin` 登录，首次登录会强制要求修改用户名和密码。

### 方式二：docker run

```bash
docker build -t webdrop .
docker run -d --name webdrop --restart always \
  -p 60003:8080 \
  -v "$(pwd)/config:/app/config" \
  -v "$(pwd)/data:/app/data" \
  webdrop
```

### 方式三：本地运行（需要手动安装node.js以及管理依赖）

```bash
sudo node /src/server.js
```

### 数据持久化与迁移

| 宿主机目录 | 容器内 | 用途 |
| --- | --- | --- |
| `./config` | `/app/config` | 配置文件 `config.json` |
| `./data` | `/app/data` | SQLite 数据库、房间文件、暂存文件、缩略图/预览、主题包 |

备份、迁移或升级时，只需停止容器并整体复制这两个目录即可：

```bash
docker compose down
cp -r config data /backup/   # 或 rsync 到新服务器
docker compose up -d --build
```

### 健康检查

镜像内置健康检查，每 30 秒请求 `/api/health`，可通过 `docker inspect webdrop` 查看容器状态；也可在宿主机直接验证：

```bash
curl http://127.0.0.1:60003/api/health
# {"ok":true}
```

### 忘记管理员密码

```bash
docker compose exec webdrop node scripts/reset-admin.js
# 默认重置为 admin:admin；也可指定：node scripts/reset-admin.js 新用户名 新密码
```

重置后旧会话全部失效，需重新登录。

### HTTPS（推荐生产使用）

麦克风语音录制依赖安全上下文（HTTPS 或 localhost）。仓库附带可选 Caddy 反向代理方案：

1. 复制 `Caddyfile.example` 为 `Caddyfile`，将 `your-domain.com` 替换为你的域名；
2. 在 `docker-compose.yml` 中启用 `tls` profile；
3. 重新启动：

```bash
docker compose --profile tls up -d
```

## 如何更新

更新前先备份 `config/` 与 `data/` 两个挂载目录（升级不会动它们，但养成习惯更稳妥）。然后拉取最新代码并重建镜像：

```bash
# 1. 拉取最新代码
git pull

# 2. 重新构建镜像并重启容器（数据保留在挂载目录中）
docker compose up -d --build

# 3. 确认容器健康
docker compose ps
curl http://127.0.0.1:60003/api/health
```

> 如果改过 `docker-compose.yml` 或想强制重建：
>
> ```bash
> docker compose down
> docker compose build --no-cache
> docker compose up -d
> ```

### 品牌 NAS / 飞牛 OS（fnOS）等图形化部署注意事项

在群晖、威联通等品牌 NAS 或**飞牛 OS（fnOS）**的 Docker 图形界面中重新构建时，界面可能会直接复用上次构建的旧镜像缓存，导致"重新构建"后运行的仍是旧版本。此时需要在**镜像管理**里找到 WebDrop 对应的旧镜像，点击**清除（清理）**删除它，然后再回到**项目/容器**页面重新选择并**构建**，即可得到最新版本。删除镜像不会影响 `config/` 与 `data/` 挂载目录中的数据。

## 配置

配置文件 `config/config.json`（支持 `WEBDROP_*` 环境变量覆盖，管理后台设置优先）：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `port` | `8080` | 监听端口 |
| `dataDir` | `./data` | 数据目录 |
| `storagePath` | `./data/files` | 房间文件存放路径 |
| `dbPath` | `./data/webdrop.sqlite` | 数据库路径 |
| `adminUsername` / `adminPassword` | `admin` / `admin` | 首次引导管理员凭据 |
| `defaultQuotaGb` | `100` | V0 持久配额基准（VIP 每级 +50G） |
| `maxUploadBytes` | `10737418240` (10G) | 全局最大上传大小 |
| `heartbeatIntervalMs` | `30000` | WebSocket 心跳间隔 |
| `heartbeatTimeoutMs` | `120000` | 心跳超时判定下线（选文件时放宽到 5 分钟） |
| `stagingThresholdBytes` | `10485760` (10M) | P2P 服务器暂存阈值 |
| `jobIntervalMs` | `60000` | 定时任务周期（过期/销毁/清理） |
| `tempUserInactiveDays` | `30` | 临时用户不活跃删除天数 |

## 本地开发

需要 Node.js ≥ 22.13：

```bash
npm install
npm start        # 默认 http://localhost:8080
npm test         # 单元 + 集成测试
npm run test:e2e # 双浏览器 E2E（需本机 Chrome/Edge 或 playwright）
```

## 技术栈

- 后端：Node.js 22 + `node:sqlite`（SQLite）
- 前端：原生 JavaScript（无框架），CSS 变量驱动的主题系统
- 实时通信：WebSocket（ws） + WebRTC DataChannel
- 部署：单容器 Docker（内置 ffmpeg，用于语音转码）
