# 乘车码（个人自用网页版）

手机上打开网页或主屏幕图标，直接看到已预约班车的乘车二维码（最近一班默认展开，其余班次可逐个显示或隐藏）。前端是纯静态页面，可挂在 GitHub Pages；账号登录和取码只在你自己的常开机器上运行。

GitHub 仓库里只有静态前端和本机服务代码，不放账号、密码、`.env` 或任何登录凭据；Pages 只发布 `docs/`，也不使用 GitHub Actions 登录或取码。

## 工作原理

```
iPhone（Safari / 主屏幕 PWA）
   │ 静态页面来自 GitHub Pages
   │ API 请求带 Bearer token，经 Tailscale 私网
   ▼
你的常开机器（树莓派 / 电脑）
   ├─ 本机服务 127.0.0.1:8787
   └─ 用你的账号登录 PKU IAAA / wproc，生成二维码
```

浏览器无法直接调用 PKU 接口（跨域、第三方 Cookie、CORS 等限制），所以登录必须由本机服务完成。密码只保存在服务进程的内存里，用于会话过期后自动重登；退出登录或重启服务即消失。

## 依赖

- Linux、macOS 或 Windows 10/11（Windows 步骤见下文）
- Python ≥ 3.9
- 生成主屏幕图标时另需 Pillow（见第 2 步；不影响服务运行）
- 常开的电脑或树莓派
- 电脑与 iPhone 安装 Tailscale，并登录同一个账号
- 一个 GitHub 账号（免费账号的 Pages 需要公开仓库；页面本身不含隐私数据）

## 快速开始

### 1. 安装本机服务

在仓库根目录：

```bash
cd server
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
cp .env.example .env
```

编辑刚复制的 `.env`，把 GitHub Pages 的 Origin 加进白名单。只写协议和域名，不带仓库路径、不带末尾斜杠：

```
ALLOWED_ORIGINS=https://YOURNAME.github.io,http://127.0.0.1:8787,http://localhost:8787
```

### 2. 生成图标并启动

上一步结束后终端在 `server/`。回到仓库根目录，安装图标依赖并生成主屏幕图标（只需执行一次）：

```bash
cd ..
server/.venv/bin/pip install -r scripts/requirements-icons.txt
server/.venv/bin/python scripts/make_icons.py
```

再启动服务：

```bash
cd server
bash run.sh
```

浏览器打开 `http://127.0.0.1:8787/`，用学号和密码登录，确认能看到乘车码。先在本机验证成功，再做外网访问。

### 3. 通过 Tailscale 私网访问

```bash
sudo tailscale serve --bg 8787
```

```bash
tailscale serve status
```

如果提示权限不足，在命令前加 `sudo`。记下输出的 `https://设备名.你的tailnet.ts.net`。如果命令提示找不到 HTTPS 证书，到 Tailscale 管理后台的 DNS 页面启用 HTTPS Certificates。

不要使用 `tailscale funnel`，它会把服务公开到互联网。

### 4. 部署 GitHub Pages

1. 新建仓库，把本项目推到仓库根目录。
2. 仓库 Settings → Pages → Source 选 `Deploy from a branch`，Branch 选 `main`，目录选 `/docs`，保存。
3. 等 1–2 分钟，地址为 `https://YOURNAME.github.io/仓库名/`。
4. 确认 `server/.env` 的 `ALLOWED_ORIGINS` 已包含 `https://YOURNAME.github.io`，然后重启服务。

推送前确认没有提交 `server/.env` 和 `server/.venv`（`.gitignore` 已忽略）。

### 5. iPhone 上使用

1. 打开 Tailscale 并保持连接。
2. Safari 打开 GitHub Pages 地址，在登录页的“本机服务地址”填 `https://设备名.你的tailnet.ts.net`，然后登录。
3. 分享 → 添加到主屏幕。以后从主屏幕打开，默认进入“乘车码”页。
4. 如果从主屏幕打开后仍显示登录页，是 iOS 把主屏幕应用的存储与 Safari 分开；在主屏幕应用里再登录一次即可。
5. 把常开机器设置为不休眠。

## 在 Windows 上运行本机服务

服务可以直接运行在 Windows 10/11 上，不需要 WSL。GitHub Pages 部署和 iPhone 使用方式不变（第 4、5 步），下面只讲 Windows 上的服务。下面的 `C:\mck-web` 换成你的实际路径。

### 1. 准备

1. 从 https://www.python.org/downloads/ 安装 Python 3.9 或更高版本，安装时勾选“Add python.exe to PATH”。
2. 安装 Tailscale for Windows，登录与手机相同的账号。
3. 把本仓库克隆或复制到 Windows，例如 `C:\mck-web`。

### 2. 安装、生成图标并启动

在开始菜单搜索 PowerShell 并打开：

```powershell
cd C:\mck-web\server
py -3 -m venv .venv
.\.venv\Scripts\pip.exe install -r requirements.txt
Copy-Item .env.example .env
notepad .env
```

按“快速开始”第 1 步的说明编辑 `ALLOWED_ORIGINS`，保存关闭后再继续：

```powershell
cd C:\mck-web
.\server\.venv\Scripts\pip.exe install -r scripts\requirements-icons.txt
.\server\.venv\Scripts\python.exe scripts\make_icons.py
cd server
.\.venv\Scripts\python.exe app.py
```

打开 `http://127.0.0.1:8787/` 登录验证。`py` 不存在时改用 `python -m venv .venv`。

### 3. Tailscale

```powershell
tailscale serve --bg 8787
tailscale serve status
```

`tailscale` 不在 PATH 时用 `& "C:\Program Files\Tailscale\tailscale.exe" serve --bg 8787`；提示权限不足时改用管理员身份打开 PowerShell。Windows 电脑的设备名就是新的 `https://设备名.你的tailnet.ts.net` 地址，记得在手机网页的“设置 → 服务地址”里更新并重新登录一次。`--bg` 的配置会持久保存，重启后可用 `tailscale serve status` 确认。

### 4. 开机自启与不休眠

1. Win+R 输入 `taskschd.msc`，右侧“创建任务”。
2. 常规：输入名称 `mck-helper`，选择“只在用户登录时运行”。
3. 触发器：新建 → “登录时”。
4. 操作：新建 → 程序填 `C:\mck-web\server\.venv\Scripts\pythonw.exe`，参数填 `app.py`，起始于填 `C:\mck-web\server`（想看到日志就把 `pythonw.exe` 换成 `python.exe`）。
5. 条件：如果是笔记本，取消“只有在计算机使用交流电源时才启动此任务”。
6. 保存后右键任务“运行”，打开 `http://127.0.0.1:8787/api/health` 确认返回 `"ok": true`。

如果希望重启后不登录也自动运行，把第 2 步改为“不管用户是否登录都要运行”，触发器改为“启动时”，保存时输入 Windows 密码。

再到“设置 → 系统 → 电源和电池”（Windows 10 为“电源和睡眠”）把睡眠设为“从不”（插电时）。笔记本合盖运行还需把“合上盖子时”设为“不采取任何操作”。睡眠或休眠会暂停服务和 Tailscale，手机此时只能显示本机缓存的当天二维码；关闭显示器不影响服务运行。服务只监听 `127.0.0.1`，通常不需要开放 Windows 防火墙入站端口；手机连不上时先检查 `tailscale serve status`。

## 配置

`server/.env`：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `HOST` | `127.0.0.1` | 只监听回环地址，由 Tailscale Serve 转发；不要改成 `0.0.0.0` |
| `PORT` | `8787` | 本机端口 |
| `ALLOWED_ORIGINS` | 空 | 允许跨域调用 API 的网页 Origin，逗号分隔；必须与浏览器地址栏的 Origin 完全一致 |
| `SESSION_TTL_SECONDS` | `604800` | 浏览器登录令牌有效期，默认 7 天无操作后失效；服务重启后全部失效 |

网页“设置”页还可以修改本机服务地址和主题。服务地址保存在该浏览器的 localStorage 里，不在仓库里。

## 开机自启（Linux，可选）

编辑 `server/mck-helper.service.example` 中的 `User`、`WorkingDirectory`、`ExecStart`，然后在仓库根目录执行：

```bash
sudo cp server/mck-helper.service.example /etc/systemd/system/mck-helper.service
sudo systemctl daemon-reload
sudo systemctl enable --now mck-helper
```

```bash
systemctl status mck-helper
journalctl -u mck-helper -f
```

## 安全说明

- **GitHub 上只有静态文件**：`docs/` 里的 HTML、CSS、JS 和图标。没有账号、密码、Cookie、二维码或 `.env`。
- **密码只在内存里**：本机服务用密码登录 IAAA，并在 wproc 会话过期时自动重登；密码不写入磁盘。退出登录或重启服务后清除。
- **令牌、学号和二维码保存在手机上**：网页会在 iPhone 的 localStorage 保存登录令牌、学号和最近一次二维码，便于快速打开和离线显示。退出登录会同时清除令牌和二维码缓存；“设置 → 清除缓存二维码”可以单独清除二维码。
- **只走 Tailscale 私网**：服务只监听 `127.0.0.1`，`tailscale serve` 只对 tailnet 内的设备开放。
- **保护好 GitHub 账号**：同一 `YOURNAME.github.io` 源下的其他页面理论上能读取 localStorage 里的令牌和二维码。请给账号开启两步验证，不要在该域名下部署来路不明的页面。
- **CORS 白名单不是唯一防线**：真正的门是 Bearer token。不要把 `ALLOWED_ORIGINS` 设成 `*`，也不要加入不认识的站点。
- 手机丢失时：重启本机服务可让所有登录令牌失效，也可以修改 PKU 密码，然后在自己的设备上重新登录。

## 常见问题

**创建虚拟环境时报 `ensurepip is not available`**

- Debian、Ubuntu、树莓派系统先安装 venv 模块：`sudo apt install python3-venv`，再重新执行第 1 步。

**Windows 启动时报 `WinError 10048` 或 `WinError 10013`**

- `10048`：端口已被占用。用 `netstat -ano | findstr :8787` 找到进程，关掉旧的 Python 实例或换端口。
- `10013`：端口被占用，或落在 Windows 的保留端口段里（Hyper-V、WSL2、Docker 常见）。用 `netsh int ipv4 show excludedportrange protocol=tcp` 查看。
- 在 `server\.env` 里改 `PORT=18080`，重启服务；如果用了 Tailscale Serve，命令也改成 `tailscale serve --bg 18080`。

**`tailscale serve` 提示 `Serve is not enabled on your tailnet`**

- Serve 是 tailnet 级别的功能，首次使用需要在管理后台开启。打开提示里的 `https://login.tailscale.com/f/serve?node=...` 链接，用同一个 Tailscale 账号登录并点击启用，然后重新执行 `tailscale serve --bg 8787`。
- 同时确认管理后台的 DNS 页面已启用 HTTPS Certificates，否则签发 `设备名.xxx.ts.net` 证书会失败。
- 末尾的 `lost connection to tailscaled: context canceled` 是命令退出时的提示，可以忽略。

**iPhone 在中国大陆 App Store 搜不到 Tailscale**

- 国区 App Store 没有上架 Tailscale，搜索结果里没有这个应用，与网络无关。完整步骤见 [TAILSCALE-IOS-CN.md](TAILSCALE-IOS-CN.md)。
- 临时办法：从国区 App Store 安装 TestFlight，打开 Tailscale 官方测试链接 `https://testflight.apple.com/join/tLcYLZJV`，接受邀请后安装。测试版会过期，也可能满员。
- 长期办法：注册一个美区或港区 Apple ID，只在“设置 → 你的名字 → 媒体与购买项目”里退出并登录海外账号，**不要登录 iCloud**；在 App Store 下载 Tailscale 后切回原账号。后续更新需要再切到海外账号。不要使用他人共享的 Apple ID，也不要安装描述文件或企业签名包。
- 国内到 Tailscale 控制服务器和 DERP 中继可能较慢：`tailscale status` 里显示 `direct` 是直连，显示 `relay` 是走海外中继。取码流量很小，通常仍然可用。
- 如果 GitHub Pages 在国内打不开，手机可以直接访问 `https://设备名.你的tailnet.ts.net/`，本机服务也会提供同一套页面，不必经过 GitHub Pages。

**提示“连不上本机服务”**

- `tailscale status` 确认手机和电脑在线且在同一 tailnet。
- `tailscale serve status` 确认转发仍在。
- 在电脑上打开 `http://127.0.0.1:8787/api/health`，在手机上打开 `https://设备名.你的tailnet.ts.net/api/health`。

**浏览器控制台报 CORS 错误**

- `ALLOWED_ORIGINS` 必须与当前网页 Origin 完全一致，例如 `https://YOURNAME.github.io`，不要带仓库路径或末尾 `/`。
- 修改 `.env` 后重启服务。

**乘车码页显示“缓存”或“刷新失败”**

- 说明本机服务暂时不可达，页面展示的是本机缓存的当天二维码。
- 检查 Tailscale 和常开机器，恢复后点右上角刷新。

**主屏幕图标是空白或页面截图**

- 按“快速开始”第 2 步安装图标依赖并运行 `scripts/make_icons.py` 生成 PNG，再提交并部署 `docs/icons/`。

**服务重启后需要重新登录**

- 登录令牌只存在内存里，这是有意设计；重新登录一次即可。

## 已知限制

- 网页无法调节 iPhone 屏幕亮度；全屏出示时请手动调亮。页面会尝试申请屏幕常亮（Wake Lock），不支持时自动忽略。
- iPhone Safari 没有网页全屏 API；全屏是覆盖整个视口的白色页面，添加到主屏幕后效果最好。
- 需要常开机器和 Tailscale 同时在线。静态页面可以离线打开，但取新码需要服务运行。
- 当前只显示真实预约对应的乘车码；原版应用里的“发车后临时码”和“自动预约”尚未实现。

## 目录

```
mck-web/
├── README.md
├── TAILSCALE-IOS-CN.md    # 国区 iPhone 安装 Tailscale 的步骤
├── docs/                  # 静态前端，GitHub Pages 的发布目录
│   ├── index.html
│   ├── app.js
│   ├── style.css
│   ├── sw.js
│   ├── manifest.webmanifest
│   └── icons/
├── server/                # 只在本机运行
│   ├── app.py             # Flask 路由、会话、二维码渲染
│   ├── pku.py             # IAAA 登录与 wproc 接口
│   ├── requirements.txt
│   ├── run.sh
│   ├── .env.example
│   └── mck-helper.service.example
└── scripts/
    ├── make_icons.py
    └── requirements-icons.txt
```
