# 第一次真实验收教程：Windows 电脑上的 Ash × Izzy 一起听

适用版本：合入 `main` 的第一阶段安全链路。文档核对日期：2026-10-31。

这是一份**下次开始真实验收时，由你自己操作**的教程。准备本文时没有创建第三方账号、启动公网隧道、登录真实网易云账号或部署服务器。

## 0. 先知道这次要做成什么

你用 iPhone 网易云主号播放音乐、创建一起听并邀请 Ash 小号。Windows 电脑运行 Bridge，代表小号加入房间。ChatGPT 通过经过 OAuth 认证的 MCP 读取状态、接收消息、发送回复和退出房间。

```text
iPhone 网易云主号 ⇄ 网易云一起听 ⇄ Windows Bridge（Ash 小号会话）
                                         ⇅
                                  ngrok 临时 HTTPS 隧道
                                         ⇅
                                  ChatGPT 自定义 MCP
                                  登录授权由 Auth0 负责
```

Bridge 不需要播放音频，也不需要你的主号 Cookie。Auth0 负责确认“使用工具的人是你”；网易云 Cookie 负责确认“Bridge 操作的是 Ash 小号”。它们是两套独立的登录。

这轮首次验收选择 **Long-wait 工具收消息**，不打开 Widget Listener。电脑、Bridge、隧道需要保持运行，电脑不能睡眠；ChatGPT 必须有正在执行的工具调用。它目前不是可以在 iOS 锁屏后永久自动聊天的机器人。

### 0.1 第一件事：确认 ChatGPT 能添加自定义 MCP

先在电脑浏览器登录你实际要使用的 ChatGPT 账号。按 [OpenAI 的当前指南](https://developers.openai.com/api/docs/guides/custom-mcp-server)，进入 Plugins（插件），点击加号，寻找 **Add custom MCP server（添加自定义 MCP）**，查看是否有 OAuth 和静态 Client ID / Client Secret 输入入口。部分界面可能仍以 Apps、Connectors 或开发者设置呈现；以实际管理界面为准。

此时只查看入口，先不创建。若账号/工作区没有权限、被安全设置限制，先解决这个问题，再做下面的准备。不要选择无认证来绕过。本项目不需要你购买 OpenAI API 用量，也不需要在 Bridge 填 OpenAI API Key；另一个 Secure MCP Tunnel 方案有不同的配置要求，见第 16 节。

### 0.2 准备清单

| 准备项 | 作用 | 这次是否需要付费购买服务器 |
|---|---|---|
| Windows 10/11 x64 电脑，稳定联网 | 运行 Bridge 和隧道 | 否 |
| Git、Node.js 22 x64（含 npm） | 下载代码、安装依赖、启动程序 | 否 |
| ngrok 免费账号及客户端 | 给本机提供稳定的 HTTPS 开发域名 | 否，留意免费额度 |
| 独立 Auth0 租户 | 托管 OAuth 登录 | 个人低用量可从 Free 开始 |
| 支持自定义 MCP 的 ChatGPT 账号 | 使用工具 | 取决于你的账号及工作区权限 |
| 网易云主号和独立 Ash 小号 | 主号邀请、小号入房 | 不保证所有歌曲都对两号可播放 |

先不购买 VPS、域名、数据库或 Render 服务。Auth0 以默认租户域名运行即可，不用付费自定义域名。套餐政策可能变化，以你操作时的控制台为准；不要为完成本教程开启付费试用功能。

## 1. 哪些东西绝对不能发到聊天里

**网易云 Cookie/MUSIC_U、密码、验证码、Auth0 Client Secret、OAuth access/refresh token、ngrok Authtoken** 都属于敏感凭据。只填入下文指定的本机私密文件或服务的私密配置界面。不要发给 Ash、其他聊天、截图、GitHub Issue 或 commit。

公开域名、OAuth Issuer、Client ID 不是密码；`MCP_OAUTH_SUBJECT` 和网易云 UID 是账号标识，仍建议按个人信息保管。`bindingId`、`eventId` 是工具路由标识，ChatGPT 可以从工具结果使用，不能替代 OAuth。

本机 `.env` 是明文秘密文件，不要放在公共电脑、共享文件夹或自动同步的云盘目录。仓库忽略 `.env`，但忽略规则不等于加密。正常操作无需执行 `git add`、`git commit` 或 `git push`。

不要运行会显示全部环境变量的排错命令，不要把 `.env` 内容打印到终端。浏览器开发者工具、Auth0/ngrok 控制台可能显示秘密；截图前先遮挡。遇到失败只提供步骤编号、错误码和脱敏后的现象。

## 2. Windows 安装软件

### 2.1 打开 PowerShell

按 Windows 键，输入 `PowerShell`，打开 **Windows PowerShell** 或 Windows Terminal 的 PowerShell 标签。普通窗口即可，不需要管理员权限。下面所有 `powershell` 代码块都在这个窗口运行，每次复制整个代码块，按 Enter；不要把开头的三个反引号复制进去。

安装软件后需要**关闭旧 PowerShell，重新打开**，让新安装的命令生效。

### 2.2 安装 Git

从 [Git 官方 Windows 下载页](https://git-scm.com/downloads/win)下载安装包，通常默认选项即可。也可以在 PowerShell 运行：

```powershell
winget install --id Git.Git -e
```

如果没有 winget，用网页安装方式。完成后重新打开 PowerShell，运行：

```powershell
git --version
```

正常会显示 `git version ...`。若提示“无法识别”，先关掉窗口再开；仍失败，检查是否完成了安装。

### 2.3 安装 Node.js 22 x64

本仓库明确使用 **22.x**，不要直接安装下载页上其他主版本。打开 [Node 官方 22 系列下载目录](https://nodejs.org/dist/latest-v22.x/)，找到文件名类似 `node-v22.xx.x-x64.msi` 的 Windows 安装包，下载安装。保留 npm 和加入 PATH 的默认选项。本项目正常使用预编译原生库，不要求先安装整套 Visual Studio 编译工具。

如果你已有其他 Node 主版本且其他项目在用，不要贸然卸载。为本项目使用单独的 Node 22 运行环境，并确认下面检测结果是 22；不要顺便修改 one-earbud 的运行环境。

重新打开 PowerShell：

```powershell
node --version
npm.cmd --version
node -p "process.platform + ' ' + process.arch"
```

正常依次显示 `v22...`、npm 版本号、`win32 x64`。本教程统一写 `npm.cmd`，避开某些 Windows PowerShell 对 `npm.ps1` 的执行策略限制；不需要关闭系统执行策略。

如果显示 `arm64`，不要假定 Windows ARM 原生 SDK 可用。当前锁定的 node-nim 下载脚本提供 Windows x64/ia32 包；ARM 机器应另行核对 x64 仿真或使用后续 Linux x64 路线。

### 2.4 安装 ngrok

按 [ngrok 官方 Windows 安装页](https://ngrok.com/download/windows)选择 Microsoft Store 安装，或运行官方提供的命令：

```powershell
winget install ngrok -s msstore
```

安装完重新开 PowerShell：

```powershell
ngrok version
```

正常会显示版本。若 Store 不可用，只从该官方页面下载 Windows x64 版本，不要关闭杀毒软件或下载陌生“免登录版”。

### 2.5 原生依赖的说明

一起听聊天室依赖网易云的 `node-nim` 原生 SDK。厂商支持 Windows x64 和 Linux x64，并在安装时下载对应二进制；这不是必须在 Linux 上才能运行的项目。[厂商说明](https://github.com/netease-im/node-nim#installation)

**支持该平台不等于本 Fork 已用你的电脑和真实账号验证成功。** 当前自动测试 mock 掉了原生登录。若之后出现 `MSVCP140.dll`、`VCRUNTIME140.dll` 等缺失，安装 [微软官方 x64 Visual C++ Redistributable](https://learn.microsoft.com/en-us/cpp/windows/latest-supported-vc-redist)，按要求重启，不要从 DLL 下载站逐个下载文件。

## 3. 下载一个独立的 ash 仓库副本

建议放在个人用户目录下的新文件夹，远离 one-earbud 和云盘。以下命令会创建 `AshIzzyMcp` 文件夹并下载你的 Fork：

```powershell
Set-Location $env:USERPROFILE
New-Item -ItemType Directory -Path 'AshIzzyMcp' -Force | Out-Null
Set-Location 'AshIzzyMcp'
git clone --branch main https://github.com/izzy3u0/ash-izzy-resonance.git
Set-Location 'ash-izzy-resonance'
git branch --show-current
git remote get-url origin
```

正常显示 `main` 和你的 `izzy3u0/ash-izzy-resonance` 地址。若目录已经存在，**不要覆盖或删除**；在资源管理器打开那个独立副本，在地址栏输入 `powershell` 后 Enter，再检查分支和远程。如果里面有自己的未提交修改，先保留，不要执行强制重置。

以后每次新开窗口，回到本教程创建的副本可以运行：

```powershell
Set-Location (Join-Path $env:USERPROFILE 'AshIzzyMcp\ash-izzy-resonance')
```

这是教程建议的位置，不是程序写死的路径。你可以放到自己的其他私有目录，之后命令的工作目录也跟着调整。

### 3.1 安装依赖并构建

在仓库目录内运行，每条成功后再运行下一条：

```powershell
npm.cmd ci
```

首次可能较慢，因为会下载 NIM 原生 SDK。正常结束后回到 `PS ...>` 提示符，没有最终的 `npm ERR!`。出现旧依赖的 deprecated 警告不等于安装失败；下载错误或非零退出才需要处理。

**真实验收安装不能加 `--ignore-scripts`**，否则原生 SDK 可能缺失；自动测试环境能通过并不能证明 SDK 已装好。

```powershell
npm.cmd test
```

正常应为 `tests 104`、`pass 104`、`fail 0`，当前版本没有跳过测试。测试用的是虚构账号和本地 HTTP，不读你的 Cookie。

```powershell
npm.cmd run build
```

```powershell
npm.cmd run typecheck
```

两条都应正常结束，没有 TypeScript 错误。这里先不要启动 Bridge；环境变量还没填。

## 4. 获取固定的临时 HTTPS 地址

### 4.1 为什么先做这一步

ChatGPT 的工具请求来自云端，访问不到你电脑的 `localhost`。ngrok 会建立从电脑向外的连接，把一个 HTTPS 地址转给本机 8787 端口，不用在路由器做端口转发。Bridge 的 OAuth 鉴权仍然保留。

本教程使用 ngrok 免费账号自动分配的**固定开发域名**。它重启不变，适合先配 Auth0；随机域名每次变化会牵动 API audience、环境变量和 ChatGPT 连接。[ngrok 免费方案说明](https://ngrok.com/docs/pricing-limits/free-plan-limits)

### 4.2 注册并记下域名

1. 自己打开 [ngrok 控制台](https://dashboard.ngrok.com/) 注册/登录，选择免费方案。
2. 找到 Domains/开发域名或 Getting Started 中分配的地址，类似 `your-assigned-name.ngrok-free.app`。不要照抄这个示例。
3. 把它组成 `https://你的实际域名`，记在自己的私密笔记中。这个就是 `BRIDGE_PUBLIC_ORIGIN`，**后面不要加 `/mcp/music`，不要加结尾 `/`**。
4. 在 Settings → Observability/Traffic Inspector 检查 **Full Capture 关闭**。本教程不需要捕获请求头/正文、不使用 Replay。默认元数据记录与“完全无日志”是两回事；隧道服务是受信任的中间服务，会终止公网 HTTPS。

若尚未找到分配的域名，可以先完成下面的本地 Authtoken 输入，再临时运行隧道命令看 Forwarding 地址；本机没有启动 Bridge 时出现 upstream/offline 错误是预期，只记地址，随后 Ctrl+C 停止。不要转发电脑上的其他服务。

### 4.3 安全输入 ngrok Authtoken

Authtoken 在 ngrok 控制台 **Your Authtoken** 页面获取，只用于本机隧道客户端，不填进 Bridge `.env` 或 ChatGPT。为了不把真实 token 写进 PowerShell 历史，推荐新开一个 PowerShell 作为**窗口 B：隧道**，复制整段：

```powershell
$tunnelSecret = Read-Host '在本机粘贴 ngrok Authtoken（输入不回显）' -AsSecureString
$tunnelPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($tunnelSecret)
try {
    $env:NGROK_AUTHTOKEN = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($tunnelPointer)
} finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($tunnelPointer)
    $tunnelSecret.Dispose()
    Remove-Variable tunnelSecret, tunnelPointer
}
```

出现提示后，把真实 token 粘贴到**这个本机输入框**再按 Enter，字符不可见是正常的。不要把它替换进上述代码，不要回显变量。这里只设置当前窗口及其子进程的环境，关闭窗口后需重新输入；不会把秘密作为命令参数写入历史。

`NGROK_AUTHTOKEN` 是 ngrok 客户端官方支持的进程环境变量，见 [ngrok 配置说明](https://ngrok.com/docs/gateway/agent/config#environment-variables)。

暂时可留着窗口 B，真正启动命令在第 9 节。如果你使用了官方 `ngrok config add-authtoken` 方式，token 会保存在本机 ngrok 配置文件，也应按秘密保护；不要把带真实值的命令粘贴到聊天。

## 5. 从零配置 Auth0

### 5.1 先分清四个对象

| 对象 | 本教程建议名称 | 含义 |
|---|---|---|
| Auth0 管理账号 | 你自己的账号 | 登录 Auth0 控制台，管理配置 |
| 独立 Tenant（租户） | 自选唯一名称 | 隔离这套登录设置，别复用 one-earbud |
| API | `Ash Izzy Bridge API` | 代表被保护的 Bridge，Identifier 是公开 origin |
| Application | `Ash Izzy ChatGPT` | 代表请求访问的 ChatGPT，提供 Client ID/Secret |
| Tenant 内的 User | 你自己的登录用户 | OAuth 弹窗里真正登录的人，User ID 是 sub |

管理账号**不自动等于** Tenant 内 User。这里没有让 Ash 网易云小号注册 Auth0；授权使用者是你本人。

### 5.2 注册 Auth0，创建独立 Tenant

1. 打开 [Auth0 官网](https://auth0.com/) 注册，由你在官网完成邮箱验证和密码设置。
2. 进入 Dashboard，根据引导创建一个独立开发租户。选择自己合适的区域；以后迁移腾讯云新加坡不要求更换租户。
3. 保留默认 Auth0 域名，不开启自定义域名、付费扩展或 M2M 专用产品。
4. 在 Tenant Settings 或之后 Application Settings 中找到 **Domain**，类似 `your-tenant.us.auth0.com`。
5. `MCP_OAUTH_ISSUER` 写为 `https://你的实际Domain/`。不要填 Dashboard 地址、Application 登录页、API 域名、`/authorize` 或 `/.well-known/...` 路径。

Free 方案当前有免费月活额度，个人验收不需要购买套餐；收费功能和免费额度以 [Auth0 定价页](https://auth0.com/pricing)及当前 Dashboard 为准。

### 5.3 创建 API 和权限

在 **Applications → APIs → Create API**：

1. Name：`Ash Izzy Bridge API`（名字可自定）。
2. Identifier：第 4 节拿到的 `BRIDGE_PUBLIC_ORIGIN`，例如 `https://你的实际ngrok域名`。**精确一致，不带 `/mcp/music` 或末尾斜杠。** Identifier 常常不能直接修改，因此先确定域名。
3. Signing Algorithm：**RS256**。
4. 创建后打开 Settings/Access Token Settings，将 **JSON Web Token (JWT) Profile 设为 Auth0**，不是 RFC 9068；不开启 JWE 加密。
5. **Token Expiration** 和 **Token Expiration For Browser Flows** 如都显示，均设为 `900` 秒，保存。本服务拒绝有效期超过 3600 秒的访问令牌。
6. 打开 Permissions，新增 Permission/Scope **`bridge:access`**，Description 可写“使用私人 Bridge”。点击 Add/Save。
7. 第一次验收可保留 **Enable RBAC 关闭**，由应用授权、用户同意和 Bridge 的唯一 `sub`/`azp` 白名单共同控制访问。这不开放匿名访问。若你已经启用 RBAC，则在 User Management → Roles 创建角色、给角色加这个 API 的 `bridge:access` 权限，再在 Users → 你的用户 → Roles 分配该角色；最终 `scope` 仍必须包含 `bridge:access`，只有 `permissions` 字段不够。
8. 如要刷新令牌，API 的 **Allow Offline Access** 打开；应用还要开启 Refresh Token，见下一节。不启用刷新也能先做短时验收，15 分钟后可能需要重新连接授权。

当前代码要求 Auth0 格式中的 `azp` 表示预注册应用 ID；RFC 9068 用不同的客户端声明，不能直接混用。不要为消除错误放松 Bridge 检查。[Auth0 格式说明](https://auth0.com/docs/secure/tokens/access-tokens/access-token-profiles)、[设置位置](https://auth0.com/docs/get-started/apis/configure-access-token-profile)。

### 5.4 创建 ChatGPT 使用的 Application

在 **Applications → Applications → Create Application**：

1. Name：`Ash Izzy ChatGPT`。
2. Type：**Regular Web Applications**。不是 Machine to Machine，也不是让你自己编写网页。
3. 创建后在 Settings 记下 **Client ID**，以后填 `MCP_OAUTH_CLIENT_ID` 和 ChatGPT 私密连接设置中的 Client ID。
4. **Client Secret** 只复制到 ChatGPT 的 OAuth 私密配置输入框，Bridge 不需要它，不填 `.env`，不发聊天。部分界面把它放在 Credentials 标签。
5. Credentials → Application Authentication → Authentication Method 选择 **Client Secret (Post)**，旧界面可能叫 Token Endpoint Authentication Method：Post。若 ChatGPT 明确提供认证方式选择，也选对应的 `client_secret_post`。不要为了“兼容”把 confidential 应用改成无秘密认证。
6. Settings → Advanced Settings → Grant Types：开启 **Authorization Code**；需要时开启 **Refresh Token**。不需要 Password、Implicit 或 Client Credentials 流程。PKCE S256 由 ChatGPT 发起，Auth0 discovery 必须公开支持；不需要自己生成 PKCE。
7. Connections：启用你接下来创建登录用户的数据库连接，通常为 `Username-Password-Authentication`。
8. **Allowed Callback URLs 暂留空**，在第 10 节从 ChatGPT 复制精确地址后回来填。不要写 ngrok URL、localhost 或通配符。不需要随意给 Allowed Web Origins、CORS、Logout URLs 填 `*`。
9. Save Changes。

如果界面没有某个标签，按字段名在应用设置中查找。不要使用 Default App 的 Client ID，也不要把 API 的 Identifier 当 Client ID。

### 5.5 只授权这个应用访问 API

若 API 提供 **Application Access Policy**（新界面）：

1. 打开刚创建的 API → Settings。
2. **User-delegated access** 选择 **Per-app authorization**。
3. **Client access / Machine-to-machine** 选 **No apps allowed**，本项目不使用该流程。
4. 保存，打开 API → **Application Access**，找到 `Ash Izzy ChatGPT` → Edit。
5. 仅对 **User-Delegated Access** 选择 Grant Access，并勾选 `bridge:access`，保存。

这是“你通过 ChatGPT 登录后访问”，不是购买或启用机器账号授权。旧租户若没有此界面，保留已有用户授权机制，核对用户同意页面能请求该 scope；Bridge 仍只接受指定应用和指定用户。详细路径见 [Auth0 API 应用访问策略](https://auth0.com/docs/get-started/apis/api-access-policies-for-applications)。

### 5.6 开启 resource 参数兼容

进入 **Tenant Settings → Advanced → Settings**，打开 **Resource Parameter Compatibility Profile**，保存。建议独立租户，是因为这是租户级设置。

ChatGPT 用标准 `resource` 参数告诉 Auth0 要访问哪个 Bridge；此开关使 Auth0 将其用于正确的 API audience。不要把 Tenant Default Audience 随意改成其他项目 API，也不要通过允许任意 audience 排错。[Auth0 官方问题说明](https://support.auth0.com/center/s/article/mcp-audience-error-with-auth0)

本路线使用预注册应用：**无需打开 Dynamic Client Registration（DCR）**，不需要配置 CIMD，不创建 Auth0 Actions 或 Management API Token。

### 5.7 创建唯一登录用户，获取 MCP_OAUTH_SUBJECT

1. 在 Auth0 Dashboard → **User Management → Users → Create User**。
2. 选择本租户的数据库连接，例如 `Username-Password-Authentication`。
3. 输入你自己控制的邮箱、设置独立密码；只在 Auth0 官方页面输入。这是之后 OAuth 登录使用的用户，不是网易云账号。
4. 创建后打开该用户详情，找到 **User ID**，常见格式 `auth0|一串字符`。
5. 完整复制 User ID，填作 `MCP_OAUTH_SUBJECT`。不要复制邮箱、昵称、Auth0 管理账号 ID、网易云 UID 或应用 Client ID。
6. 按页面要求完成邮箱验证。确认本用户的连接已在 `Ash Izzy ChatGPT` Application → Connections 启用。
7. 只有你使用时，可在 Authentication → Database → 对应连接 → Settings 打开 **Disable Sign Ups**，保留已创建用户登录。不要同时禁用整个连接。

其他人即使能在同一租户注册/登录，Bridge 的 `sub` 白名单也不允许他们使用。以后如果删除重建用户，User ID 可能变，需要手工更新配置。

## 6. 创建本机私密 .env，先不放网易云 Cookie

回到**窗口 A：Bridge**，确认位于第 3 节的 ash 仓库目录。第一次创建时执行：

```powershell
if (-not (Test-Path -LiteralPath '.env')) { Copy-Item -LiteralPath '.env.example' -Destination '.env' }
notepad .env
```

会打开记事本。`KEY=value` 表示把右边的值交给程序；等号左边不要改。下面只是格式示意，所有 `你的...` 都要换成自己的值，不能原样启动：

```dotenv
BRIDGE_PUBLIC_ORIGIN=https://你的实际ngrok域名
MCP_OAUTH_ISSUER=https://你的实际Auth0域名/
MCP_OAUTH_SUBJECT="你的完整Auth0 User ID"
MCP_OAUTH_CLIENT_ID=你的Auth0应用ClientID
TOGETHER_ENABLED=false
NETEASE_INVITER_UID=
NETEASE_COOKIE=
NODE_ENV=production
PORT=8787
BRIDGE_INGEST_TOKEN=
BRIDGE_UNIX_SOCKET=
```

这一步暂用 `TOGETHER_ENABLED=false`：只验证隧道和 OAuth，完全不需要网易云 Cookie。所有 MCP 路径仍需 OAuth。其他轮询配置先保留模板默认值。按 Ctrl+S 保存，关闭记事本。文件名必须是 `.env`，不能是 `.env.txt`。

检查文件存在且被 Git 忽略（不会显示内容）：

```powershell
Test-Path -LiteralPath '.env'
git check-ignore .env
git status --short
```

正常为 `True`，下一条显示 `.env`，最后不应出现 `.env`。如果 Git 把秘密文件列为待提交，先停止，不要 add/commit/push。

### 6.1 六个主要变量的对照表

| 变量 | 是什么、哪里找 | 填在哪里 | 敏感性 |
|---|---|---|---|
| `BRIDGE_PUBLIC_ORIGIN` | ngrok 分配的 HTTPS 域名；不带路径/结尾斜杠 | 本机 `.env`、Auth0 API Identifier；ChatGPT URL 另加路径 | 公开配置 |
| `MCP_OAUTH_ISSUER` | Auth0 Application/Tenant 的 Domain，前加 `https://` 后加 `/`；应与 OIDC metadata 的 issuer 一致 | 本机 `.env` | 公开配置 |
| `MCP_OAUTH_SUBJECT` | Auth0 User Management → Users → 你的用户 → User ID | 本机 `.env` | 个人标识，非密码 |
| `MCP_OAUTH_CLIENT_ID` | Auth0 → 专用 Application → Settings → Client ID | 本机 `.env`、ChatGPT OAuth Client ID 输入框 | 公开客户端标识 |
| `NETEASE_INVITER_UID` | iPhone 网易云**主号**的个人主页分享链接中的数字 `id` | 本机 `.env` | 个人标识，非密码 |
| `NETEASE_COOKIE` | 自己在可信电脑浏览器登录 **Ash 小号** 后，本机开发者工具取得的会话 | 只放本机 `.env`；将来 VPS 的 Secret/受限文件 | **秘密，等同会话钥匙** |

另外，Auth0 **Client Secret** 只在 Auth0 与 ChatGPT 的私密 OAuth 设置中使用；ngrok **Authtoken** 只给本机隧道进程；都不属于 Bridge 的配置变量。

## 7. 在本机启动 Bridge：先验 OAuth

在窗口 A、仓库目录中运行：

```powershell
node --env-file=.env dist/src/server.js
```

正常应看到 `Cove Resonance listening (authenticated MCP)`，窗口持续运行，不再返回提示符。名字中仍有上游 Cove 是正常的，本阶段没做品牌文案改造。因为一起听暂时关闭，不应开始真实网易云登录。

**不要用未注入环境的 `npm start` 代替这条命令。** 仓库不会自动加载 `.env`；`--env-file` 才让 Node 22 加载它。修改 `.env` 不会自动生效，要在窗口 A 按 Ctrl+C 后重新启动。

若出现 `Startup refused: invalid or missing OAuth/NetEase configuration`，检查第 6 节四个 OAuth 必填项、HTTPS 格式、文件名和 `TOGETHER_ENABLED=false`。不要打印整份 `.env` 排查。

### 7.1 用第三个窗口检查本机

新开**窗口 C：检查**，不需要在仓库目录，执行：

```powershell
curl.exe -sS http://127.0.0.1:8787/healthz
curl.exe -i http://127.0.0.1:8787/mcp
curl.exe -i http://127.0.0.1:8787/mcp/music
```

预期第一条返回仅含存活信息的 JSON，例如 `ok:true`。后两条都是 **401 Unauthorized**，有 `WWW-Authenticate`；这是鉴权生效的正确结果。不是看到 401 就删掉认证。

当前服务监听 `0.0.0.0:8787`，适配本机和未来容器/VPS；本地验收请保持 Windows 防火墙开启，不批准新增公网/局域网入站开放，不做路由器端口转发。ngrok 转发到 `127.0.0.1` 即可。不要把端口改成 one-earbud 正在使用的端口；如 8787 已占用，可以换成例如 8788，并同时修改 `.env`、隧道目标和检查命令。

## 8. 验收前不需要额外配置的项目

`BRIDGE_INGEST_TOKEN` 留空：通用 `/events` 入口关闭。不要为了聊天室收消息打开它。

`BRIDGE_UNIX_SOCKET` 留空：Windows 首次验收走 HTTP，不需要 Unix socket。

`TOGETHER_PLAYBACK_DIAGNOSTICS=false`：先保留脱敏常规日志，不开底层抓包、请求正文捕获、全量异常上报或 SDK 调试日志。

不需要网易云开放平台开发者账号、自己申请云信 AppKey、OpenAI API Key、数据库、Redis、服务器 SSH Key，也不需要在 iPhone 安装 Bridge。

## 9. 临时打开 HTTPS 隧道

回到已输入 Authtoken 的**窗口 B**，运行：

```powershell
ngrok http http://127.0.0.1:8787 --inspect=false
```

预期 Session Status 为 online，Forwarding 一行是 `https://你的实际域名 -> http://127.0.0.1:8787`。它应该与第 4 节记下的域名一致；如果不同，停止 Bridge，修正 `BRIDGE_PUBLIC_ORIGIN` 和 Auth0 API Identifier 后再继续，不要容忍 audience 不匹配。

`--inspect=false` 关闭 agent 的 HTTP 内容检查；还要保留第 4 节 Dashboard 的 Full Capture 关闭。这并不声称第三方隧道完全看不到传输数据。[ngrok 命令参数](https://ngrok.com/docs/gateway/agent/cli)、[云端捕获设置](https://ngrok.com/docs/obs/traffic-inspection/http-requests)。

窗口 C 输入下面的非敏感域名（提示只输入域名 origin，不要加 `/mcp/music`）：

```powershell
$bridgeOrigin = (Read-Host '输入你的 BRIDGE_PUBLIC_ORIGIN').TrimEnd('/')
curl.exe -sS "$bridgeOrigin/healthz"
curl.exe -i "$bridgeOrigin/mcp/music"
curl.exe -sS "$bridgeOrigin/.well-known/oauth-protected-resource"
```

正常仍为健康 JSON、MCP 401、资源元数据 JSON；元数据的 `resource` 是公开 origin，`authorization_servers` 是 Auth0 issuer，scope 包含 `bridge:access`。

免费 ngrok 在浏览器 HTML 流量前可能显示 Visit Site 提示；它不应替代 JSON MCP 响应。以上 curl 测试没有令牌，可安全用于检查。若 ChatGPT 获取到 HTML 提示页而非 MCP，先按第 14 节排错，不添加需要 ChatGPT 自定义请求头的“解决方案”，也不取消 OAuth。

## 10. 在 ChatGPT 创建自定义 MCP，完成 OAuth

电脑上用浏览器操作，iPhone 先保持网易云主号登录。

1. 打开 ChatGPT 的 **Plugins → 加号 → Add custom MCP server**，选择你要使用的个人空间/已获授权工作区。
2. 名称建议 `Ash Izzy 一起听测试`，方便区分 one-earbud；描述可留简短。
3. Connection 选 **Server URL**。地址填 **`BRIDGE_PUBLIC_ORIGIN` 后加 `/mcp/music`**，例如 `https://你的实际ngrok域名/mcp/music`。
4. Authentication 选 **OAuth**，不是 No authentication，也不是 OAuth or no authentication。
5. 使用静态/预注册客户端配置：Client ID 填第 5.4 节应用 Client ID；Client Secret 填同一应用的秘密。它们只在配置表单内输入，不作为对话消息发送。不选择 CIMD/DCR 来替换这个应用身份。
6. 按界面要求创建连接/插件。工具发现如果立刻要求登录，先转到它的管理/详情页找 **OAuth redirect/callback URI**。从这里复制完整地址。
7. 回到 Auth0 → `Ash Izzy ChatGPT` Application → Settings → **Allowed Callback URLs**，粘贴上一步的完整 URI，Save Changes。
8. 返回 ChatGPT 重试 Connect/Install/Authorize，浏览器应跳到你自己的 Auth0 租户的托管登录页面。
9. 使用第 5.7 节 **Tenant 内 User** 的邮箱/密码登录，按要求验证并同意 `bridge:access`。这里不输入网易云 Cookie，不使用 Auth0 Dashboard 管理账号代替该 User。
10. 成功后返回 ChatGPT，插件显示已连接/可安装。安装到你自己的账号；在对话输入框 `@` 选择它，或按界面的工具选择入口启用。

如果第一次创建只有 OAuth 错误页，在错误 URL/管理页核对 redirect URI；可以先取消本次授权，保存正确白名单后重试。不要把带授权码、state 或 token 的完整浏览器地址发到聊天。Callback 可能是稳定地址或连接专属地址，**必须复制实际值，不猜 `{callback_id}`**。[OpenAI OAuth 回调要求](https://developers.openai.com/plugins/build/auth)

如果表单要求填写 Authorization/Token Endpoint，分别从你的 Auth0 `https://你的Auth0域名/.well-known/openid-configuration` 中复制 `authorization_endpoint` 和 `token_endpoint`；标准 Auth0 通常分别为 `/authorize`、`/oauth/token`。不要把这些地址填成 issuer。需要 scopes 时填 `bridge:access`，OIDC 的 `openid profile email` 依平台要求保留；要自动续期还需请求 `offline_access` 并开启前述刷新配置。若界面只提供静态 Client ID/Secret，其他内容由 discovery 读取，不必额外发明配置项。

### 10.1 先做一个不登录网易云的工具测试

在已选择这个测试插件的 ChatGPT 对话中发送下面的话（没有秘密）：

> 只使用“Ash Izzy 一起听测试”插件，调用 netease_together_status，告诉我 enabled、phase、bound、realtimeConnected。不要使用 one-earbud，也不要调用任何写入工具。

预期这次**真的有工具调用**，返回 `enabled=false`、`phase=disabled`、`bound=false`。只看到 Ash 口头说“已连接”不算通过。成功说明公网 → OAuth → MCP 链路已通；失败先修这一层，不要提前加入 Cookie 增加排错变量。

先在网页做通，再在同一 ChatGPT 账号的 iPhone 上检查是否能选用该私人插件。创建/管理在网页进行；移动端能否使用、是否出现工具确认取决于账号与当前客户端。手机若找不到，先继续用电脑网页验收，不降低认证。

## 11. 配置主号 UID 和 Ash 小号 Cookie

这一步才开始由你在自己的设备上使用真实网易云账号。以下没有任何需要把凭据发给聊天的步骤。

### 11.1 获取 NETEASE_INVITER_UID：只要主号数字 UID

1. 在 iPhone 网易云 App，确认登录的是你的主号。
2. 打开自己的个人主页，选择分享/复制链接。
3. 如果是短链接，在自己浏览器打开，找到最终个人主页地址中的数字 `id`，常见形式 `music.163.com/#/user/home?id=123456789`。
4. 只取数字 `123456789` 这一类 UID，填进本机 `.env` 的 `NETEASE_INVITER_UID=`。

不要填手机号、昵称、歌单 ID、歌曲 ID、一起听房间 ID，也不要填 Ash 小号的 UID。可以在浏览器主号个人页和 App 昵称/头像比对，确认不是其他人。

### 11.2 在独立浏览器会话登录 Ash 小号

1. 在 Windows 用 Edge/Chrome 新建**专门浏览器配置文件**，或另开 InPrivate/无痕窗口，避免复用主号网页会话。
2. 自己输入 [网易云音乐官方站](https://music.163.com/) 地址，确认域名和 HTTPS，再按官方入口登录 Ash 小号。密码/验证码只输入官方登录页。
3. **不要用已登录主号的 iPhone App 扫码**，那很可能会把网页登录成主号。本次必须是 Ash 小号。网页如果不提供适合小号的官方登录方式，先停止此步，另选可信的官方客户端登录方式再核对会话，不使用陌生 Cookie 获取器。
4. 登录后查看网页个人头像/昵称/主页，确认是 Ash 小号。先别让它加入一起听，旧房间要用官方客户端主动退出。

### 11.3 只在本机开发者工具取会话

1. 在已登录小号的官方网页按 **F12**（有些键盘 Fn+F12），打开开发者工具。
2. 找 **Application（应用程序）**；Edge 有时在顶部 `>>` 里。展开左侧 **Storage → Cookies**，选官方 `music.163.com` 对应站点。
3. 找名称 **`MUSIC_U`**，复制 Value；若有 `__csrf` 也可以一起取。HttpOnly cookie 不会通过普通页面脚本显示，使用开发者工具存储面板即可。
4. 这些值只复制到本机记事本打开的 `.env`，写成一行（以下是格式占位，不能照抄）：

```dotenv
NETEASE_COOKIE="MUSIC_U=在本机取得的小号值; __csrf=在本机取得的值"
```

如果没有 `__csrf`，不要编造：

```dotenv
NETEASE_COOKIE="MUSIC_U=在本机取得的小号值"
```

保留英文双引号；不要加 `Cookie:` 前缀、换行或复制成 JSON。当前程序要求非空 `MUSIC_U`；如果官方网页没有这一项，说明还没得到该会话，不能填网页登录临时码、其他 App Token 或主号值来代替。

5. 将 `.env` 的 `TOGETHER_ENABLED` 改成 `true`，主号数字 UID 也填好，保存。
6. 关开发者工具，及时清理含秘密的剪贴板；不要截图、保存 HAR 网络包或导出所有 Cookie。不要为了清理而立即退出网页账号，退出可能使已取会话失效。

如果 Cookie 失效，仍由你在本机更新并重启；没有“发给 Ash 帮忙检查”的环节。不要从 iPhone 主号提取 Cookie。

## 12. 重启 Bridge，邀请并确认入房

### 12.1 重启只影响 Bridge，不用重启隧道

窗口 A 按 **Ctrl+C**。在同一仓库目录再运行：

```powershell
node --env-file=.env dist/src/server.js
```

正常先显示监听成功，再出现类似：

```text
NetEase Together worker ready for account <Ash小号UID>
```

这行仅表明会话校验成功，不等于已经入房。让 ChatGPT 再调用 `netease_together_status`，核对：

| 字段 | 等邀请时应看到 |
|---|---|
| `enabled` | `true` |
| `accountId` | Ash 小号 UID，与主号不同 |
| `phase` | 通常最终 `waiting_invite` |
| `bound` | `false` |
| `binding` | `null` |
| `realtimeConnected` | `false` |

若 `lastError` 存在先查第 14 节。程序不会接管启动前小号已经在的未知房间。

### 12.2 主号创建一起听并发出新邀请

1. iPhone 网易云保持主号登录，选一首两号都能播放、有普通歌词的歌。先在主号确认能正常播放。
2. 在歌曲播放页的菜单/一起听入口创建房间；不同 App 版本入口可能不同，以“一起听”“邀请好友”等功能名称寻找。
3. 通过网易云**站内私信**把邀请发送给 Ash 小号。可以提前关注/互相关注并确认双方私信可达。
4. 本实现读取主号 → 小号这条私信中的邀请链接；仅把邀请复制到微信或 ChatGPT 不会被 Bridge 识别。不要手工拼造带房间 ID 的 URL。
5. **先启动 Bridge，再发送新的邀请**。只接受启动/上次主动退出后、5 分钟内的新邀请，发送者和链接 inviterId 都必须是配置的主号。
6. 保持主号房间开启，给轮询和 NIM 连接留出几十秒。不要反复快速邀请或同时在小号官方客户端手动接受。

### 12.3 确认真正入房

请 ChatGPT：

> 调用 netease_together_status，报告 accountId、roomId、bound、binding 是否存在、realtimeConnected 和 lastError；再调用 netease_together_now。只报告这次工具结果。

预期 `bound=true`、有 `roomId` 和 `binding`，最终 `realtimeConnected=true`，`now.inRoom=true`。窗口 A 可能显示 `NetEase NIM realtime connected: roomId=... chatRoomId=...`。iPhone 一起听成员里应看到 Ash 小号。

**工具状态与手机成员列表都要核对**。仅 `inRoom=true` 但 `realtimeConnected=false` 不能算消息链路通过。当前 `binding.bindingId` 由每次入房生成；不要把以前的值硬编码进指令。

## 13. 逐项进行最小真实验收

建议先在电脑 ChatGPT 网页操作、iPhone 负责网易云，便于切换；网页通过后再用同一 ChatGPT 账号在 iPhone 重做关键项。任何写入操作如果 ChatGPT 要求确认，先看工具名和参数，再由你确认。

### 13.1 当前歌曲

发给 Ash：

> 只使用“Ash Izzy 一起听测试”，调用 netease_together_now。告诉我当前歌名、歌手、歌曲 ID 和 observedAt，不要根据上一轮猜测。

正常：歌名/歌手/歌曲 ID 与网易云当前歌一致，`inRoom=true`，有最近的 `observedAt`。这个时间是最近观测点，不是你提问的精确时刻；短暂变化要重新读，不能沿用旧结果。

### 13.2 播放、暂停、进度

1. 手机播放十几秒，请 Ash 调用 `netease_together_now`，查看 `playStatus=PLAY`、`progressMs`。
2. 过 5–10 秒再读一次，进度应整体增加，不要求毫秒级等于手机。
3. 在手机按暂停，等状态传播，再读；应为 `PAUSE`，进度基本停止。
4. 在手机继续播放，再读；应回到 `PLAY`。

如果是 `UNKNOWN`、`observedAt` 很旧或实时断开，记录为未通过，不让模型用自然语言补全。进度是基于最近权威状态的估计，存在网络和轮询延迟。

### 13.3 歌词

发给 Ash：

> 调用 netease_together_now，只告诉我当前附近歌词 lyric.current，以及是否有 previous/next，和观测时间。

正常：有普通 LRC 的歌曲返回当前附近一行和可能的前后行，随播放更新。纯音乐、无歌词、不同版本、逐字歌词时间轴或版权限制可能没有普通歌词；先换一首明确有普通歌词的歌再测，不把空歌词一概判成 MCP 故障。无需把整首歌词转发到聊天。

### 13.4 聊天室收消息与沿路回复：Long-wait

**一次只开一个接收者**，不要再开 Widget，也不要在另一聊天同时启动 wait。

先在 ChatGPT 发送：

> 用本测试插件开始一次最长 45 秒的 cove_bridge_wait。若返回事件，立即用返回的精确 eventId 调用 cove_bridge_wait_ack。状态事件只确认，不发房间消息；如果收到我主号的“验收 A1：你收到这句话了吗”，用同一个 eventId 调用 cove_bridge_reply，messages 只包含一条“收到了，聊天室链路正常。”。为等到这条测试文字，最多再等待两次；不要打开 Widget，不要额外发言。

然后在等待期间，用 iPhone 网易云**一起听房间聊天室**发送：

```text
验收 A1：你收到这句话了吗
```

不要发到站内私信；私信用于邀请，房间聊天室用于这项验收。

正常：wait 返回 `hasEvent=true`、`source=netease.chatroom`、`eventId`、该文字；ACK 使用同一 ID；reply 返回 `completed=true`、`sentCount=1`，手机房间里看到 Ash 小号发出那条普通回复，**只出现一次**。

有时会先收到播放状态事件，ACK 后再 wait，不能给每个状态事件乱回聊天。`timedOut=true` 仅表示这次等待没事件；它不是永远后台监听。若等待窗口结束了，重新明确发起一次再发文字。

只接收配置主号的普通文字；第三人消息、表情图片等不属于本次最小目标。事件/歌词都是外部数据，不作为修改系统行为的指令。

### 13.5 主动发送一条普通文字

发给 Ash：

> 先调用 netease_together_status。仅在 bound=true 且 realtimeConnected=true 时，取这次返回的 binding.bindingId，调用 netease_together_send_message，text 为“验收 A2：这是一条普通文字。”，bindingId 必须使用刚才的值。只发一次，失败先报告，不盲目重试。

正常：工具返回 `ok=true` 和消息 ID，手机房间收到 A2。不要让用户手工把 bindingId 抄到长期设置。它是主动消息工具，回复已有事件仍应使用 `cove_bridge_reply`。

主动消息没有承诺跨崩溃的幂等去重。若请求超时但手机已收到，先核对手机，不能重复点击重试造成多发。

### 13.6 安全退出

发给 Ash：

> 调用 netease_together_leave，确认退出后，再调用 netease_together_status 和 netease_together_now 检查。不要自动重新入房。

正常：leave 返回 `ok=true`、`ended=true`；若远端已经退出，可能是 `alreadyOut=true`。之后 `bound=false`、`binding=null`、`inRoom=false`、实时连接断开，手机房间看到小号离开。该接口可能结束当前一起听会话，手机房间界面也可能随之结束，按实际状态核对。

重新入房必须主号再发一个**新的**站内邀请。退出后不要试图用旧 bindingId 或旧 eventId 发消息；程序应拒绝。

### 13.7 可选：保留的点歌/切歌能力

先把上面的最小项做通，再少量测试。`netease_search_songs` 搜歌；`netease_together_enqueue_next` 把歌曲放进队列；`netease_together_goto` 只接受当前队列已有歌曲，`netease_together_next` 播下一首。新歌先插入队列再切，下一首/插歌当前要求 `ORDER_LOOP`。

控制成功应有 `confirmed=true`，同时人工看手机确实切到可播放歌曲。HTTP 请求成功或模型说“切好了”不算。版权、VIP、区域和两号播放权限仍可能使手机无法播放。本轮不扩展歌单、喜欢、历史或每日推荐。

### 13.8 把结果记下来

| 项目 | 通过依据 | 结果 |
|---|---|---|
| 未授权拒绝 | 无 token 的两个 MCP 地址均 401 | 待验 |
| OAuth | 指定 Auth0 用户登录后真实工具可调用 | 待验 |
| 小号会话 | accountId 是 Ash 小号，非主号 | 待验 |
| 主号邀请 | 新邀请后 bound 与实时连接均 true，手机看到小号 | 待验 |
| 当前歌曲 | 工具与手机一致 | 待验 |
| 播放状态/进度 | 播放增长、暂停基本停止 | 待验 |
| 当前歌词 | 有普通歌词的歌曲能返回附近歌词 | 待验 |
| 聊天收消息 | wait 收到 A1 的新事件并 ACK | 待验 |
| 事件回复 | reply 完成，手机只收到一条 | 待验 |
| 主动发言 | 用当前 bindingId 发出 A2，手机收到 | 待验 |
| 退出 | 远端确认退出，绑定/播放状态清空 | 待验 |

不要把“待验”提前改成通过。保存结果时只写成功/失败、时间、脱敏错误码，不附凭据。

## 14. 常见失败：按层排查

| 现象 | 先看哪里 | 处理方式 |
|---|---|---|
| `git`/`node`/`npm.cmd` 无法识别 | 安装与新窗口 PATH | 重开 PowerShell，确认 Node 是 22；不要更改 one-earbud |
| `npm.ps1` 不允许执行 | PowerShell 脚本策略 | 使用教程的 `npm.cmd`，不必降低全局策略 |
| npm 下载失败/超时 | npm、网易云 SDK 下载网络 | 不需要 Cookie；网络恢复后重试 `npm.cmd ci`，不要换陌生 SDK 包 |
| SDK 安装不完整 | 是否曾用 `--ignore-scripts` | 先停 Bridge，在仓库运行 `npm.cmd rebuild node-nim`，成功后重建；不要靠只跑测试证明原生库存在 |
| `.node` 找不到/DLL 缺失 | Node x64、原生安装、VC++ runtime | 用官方二进制/微软运行库；若仍失败记录为 Windows 原生兼容问题，不关防护 |
| `EADDRINUSE` | 8787 已被其他进程占用 | 不停止陌生服务，换本项目 PORT 并同步隧道/检查命令 |
| 本机 healthz 失败 | 窗口 A 是否运行 | 配置后重启；不要先查 ChatGPT |
| ngrok 离线/502/upstream error | 窗口 B、目标端口、窗口 A | 确认本机 healthz 通，再检查 token 是否过期/隧道额度和联网 |
| 未授权 MCP 401 | curl 没有凭据 | 正常，下一步完成 OAuth，不能选匿名 |
| ChatGPT 报 HTML/Unexpected token `<` | 公网 curl 是否返回 HTML | 免费浏览器提示或代理拦截；确认 JSON MCP 请求正常，检查 ngrok 服务限制。不要要求 ChatGPT 携带自定义跳过头；仍失败暂停选择另一兼容隧道 |
| `Callback URL mismatch` | Auth0 应用 Callback allowlist | 从当前 ChatGPT 连接详情重新复制完整 URI，保存后重试 |
| `invalid_client` | 应用 Client ID/Secret、认证方式 | 确认是同一个 Regular Web Application、Post 方式；重置 Secret 后同步更新 ChatGPT，不发 Secret 排错 |
| API/audience/userinfo 错误 | Auth0 API Identifier、resource profile | Identifier=公开 origin；打开 resource compatibility；别填 `/mcp/music` |
| `access_denied`/应用无权访问 API | API Application Access、数据库连接 | 授予该应用 User-Delegated Access 和 bridge:access；不是 M2M |
| 登录成功但每个工具仍 401 | 本机四个 OAuth 变量与 Auth0 设置 | sub=当前登录 User ID，clientId=该应用；Auth0 JWT profile、RS256、scope、900 秒；检查 Windows 时间自动同步 |
| 约 15 分钟后 401 | access token 到期与刷新设置 | API Allow Offline Access、应用 Refresh Token、客户端 offline_access；重新授权。不要拉长至超过 1 小时 |
| `enabled=false` | .env 的 TOGETHER_ENABLED | OAuth 预检时正常；真实入房阶段改 true 后重启 |
| `Cookie validation failed`/安全 API 错误码 | 小号登录、MUSIC_U、会话期限 | 由你在官方网页本机更新小号 Cookie，别复制主号，不上传原始异常 |
| `same_account_configuration` | 主号 UID 与 Cookie 所属号 | 误用了同一账号；停止后改为 Ash 小号 Cookie |
| 一直 `waiting_invite` | 主号 UID、站内私信、邀请时间 | 确认是主号给小号的新邀请、服务已启动、5 分钟内；不是微信链接/普通文字，也不是房间聊天室邀请文本 |
| `unbound_room` | 小号启动前已经在房间 | 用官方客户端让小号退出旧房间，再发新邀请；不接管未知房间、不解除白名单 |
| bound=true 但 realtimeConnected=false | NIM 原生库、票据/云信网络 | HTTP 入房不代表聊天室已通；查脱敏 NIM 错误、原生依赖、网络，不分享 token；必要时安全退出后重邀 |
| 歌曲有、歌词没有 | 歌曲是否有普通歌词 | 换已知有 LRC 的版本，检查观测时间，不虚构歌词 |
| 聊天没触发 Ash | 是否真的在 wait、窗口是否超时 | 重新明确启动 wait；只开一个接收者；主号发房间普通文字，不是私信 |
| `awaitingReply=true` 卡住 | 上一个 required 事件 | 用其精确 eventId 完成已授权回复；不能省略 ID、伪造新 ID或乱用 dismissed |
| `Room binding changed`/stale | 退出重入/重启后的旧工具参数 | 重新读状态；旧事件不再发送，不绕过保护 |
| 切歌超时 | 权威实时回执、队列、ORDER_LOOP | 先看手机，别盲重试；不把 HTTP 成功写成播放成功 |
| 手机切后台/锁屏后不继续 | ChatGPT/iOS 调度、活跃工具调用 | 回前台重新发起 wait；本阶段不承诺无人值守 |

本机配置变化后先 Ctrl+C 重启 Bridge；只改 Auth0/ChatGPT 时通常先重试授权即可。重启会清空队列与绑定，按“退出旧房间 → 服务运行 → 主号发新邀请”恢复，不尝试重放旧消息。

查看 Windows 端口的非敏感检查命令（窗口 C）：

```powershell
Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue
```

不要结束查出来的未知进程；本项目窗口 A 可用 Ctrl+C 停止。常规日志不打印完整 Cookie/Token/聊天正文，但第三方 native SDK 可能生成本机诊断文件；不要上传整份日志目录、内存转储、HAR 或 ngrok 捕获记录。

## 15. 验收结束、下次启动、以后迁移

### 15.1 正常结束

1. 先让 ChatGPT 调用 `netease_together_leave`，核对手机与工具确认退出。
2. 窗口 A 按 Ctrl+C 停 Bridge。
3. 窗口 B 按 Ctrl+C 停 ngrok，关闭窗口清除进程环境中的 Authtoken。
4. 关闭其他不需要的窗口。`.env` 留在私有本机目录；不想保留小号会话可自己清空该值/撤销会话，后续需重新取值。

只停进程不能保证网易云立即显示退出；所以先做 leave。异常断电后，下次用官方客户端核对旧房间再重邀。

### 15.2 下次再次运行

1. 电脑联网，确认 `.env` 仍有效、域名没变、小号不在旧房间。
2. 窗口 A 回仓库，运行 `node --env-file=.env dist/src/server.js`。
3. 窗口 B 重新安全输入 ngrok Authtoken，运行第 9 节的隧道命令。
4. ChatGPT 必要时重新 OAuth，读状态，主号发新邀请。

没有更新源码时不用每次都重新安装/构建。源码更新后先看变更，再在 ash 独立目录安装/测试/构建，避免运行旧 dist。更新前不删除你的 `.env`。

### 15.3 将来迁移腾讯云新加坡 Linux VPS 的对应关系

本轮**不执行**这些部署操作，只说明迁移边界：

- 使用 Linux x86_64、Node 22 和 glibc（如 Debian/Ubuntu）；保留 package-lock，用 `npm ci` 重新下载 Linux 原生 SDK，不能把 Windows `node_modules` 复制过去。不使用 Alpine/musl。
- 源码、构建入口和六个主要变量不变。将环境交给进程管理器/Secret 或受限配置文件；Linux 文件权限可设为仅运行用户可读，服务用普通用户。示例本地目录不会进入运行逻辑。
- VPS 上通常用自己的稳定 HTTPS 域名和反向代理，配置支持至少 45 秒工具等待及可选 SSE；只开放必要端口，不直接暴露无 TLS 的 8787，不记录认证头、请求正文或完整查询串。
- 新 HTTPS origin 必须同步设置 Bridge、Auth0 API Identifier（必要时新建 API 并重授应用权限）、ChatGPT Server URL，再重新授权。Auth0 Tenant/User/专用应用可以保留，不需要换成网易云账号登录 OAuth。
- 网易云 Cookie 由你私下填到 VPS 的 Secret；不要经 Git、聊天或教程运输。公网 Auth0 可达不代表新加坡出口对网易云、云信、具体歌曲版权都可用，迁移后还需重做真实验收。
- 当前仍单实例、一个活跃接收者，无数据库。进程重启会丢队列/绑定/去重状态，必须重新邀请；本阶段没有 crash-safe 回复日志，不在重启后自动补发旧消息。
- 需要保存的是受限环境配置，以及身份服务/隧道或未来域名配置；不要持久保存真实 Cookie 到仓库。原生 SDK 可能有本机缓存/诊断文件，bootstrap 临时目录正常会清理，异常退出可能残留；这些文件可能含账号相关数据，不上传，不当长期记忆备份。
- one-earbud 保持独立仓库、进程、端口、OAuth 应用、秘密文件和未来服务单元，不共享房间状态，不合并代码。

## 16. OAuth 方案复核：为什么这轮保留 Auth0

**结论：当前 Auth0 路线符合 ChatGPT 自定义 MCP 的已文档化要求，适合继续做真实验收，但尚未以真实账户完成端到端验证。**

代码提供受保护资源元数据与 401 challenge，验证 RS256、issuer、audience、scope、用户 sub、客户端 azp 与令牌时限。外部 Auth0 提供公开 discovery、PKCE S256 授权码流程和令牌签发；ChatGPT 官方支持预注册静态客户端凭据。这是现有实现与官方协议的对照结论，不是宣称已经替你创建连接。

它不是可任意替换 issuer 的通用身份平台适配：当前预期 Auth0 根域名的 JWKS 路径及 `azp` 声明。Keycloak/其他平台可能需要修改验证适配和测试，不能只换一个 URL。

| 方案 | 对这次验收的判断 |
|---|---|
| 保留 Auth0 Free + 预注册应用 | 无需自己维护登录系统，可保留唯一用户/客户端白名单；本教程选用 |
| 自建 OAuth 服务 | 还需正确维护登录、授权码、PKCE、刷新、撤销和持久存储，当前并不更简单 |
| 自托管 Keycloak | 软件可免费，但多一个需要维护的服务，且验证适配不同，不适合这轮减负 |
| API Key、随机长网址、ngrok Basic Auth/网页登录门禁 | 不等价于当前 MCP OAuth 安全契约，可能让 ChatGPT 无法完成发现/授权，不替代 |
| OpenAI Secure MCP Tunnel | 官方提供面向私有 MCP 的出站隧道；可能减少第三方隧道需求，但需 Platform tunnel 权限、runtime API key、工作区关联；OAuth 仍有自己的要求，本轮不切换 |

没有找到可以在当前实现中“直接换掉 Auth0、明显更简单、免费且保持同样访问控制”的替代品。未来可以单独评估官方 Secure MCP Tunnel；其文档不意味着它自动替代身份授权，也不在本教程内声称对你的账号免费可用。[官方说明](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)

临时公网地址方面，ngrok 免费开发域名稳定，较适合本次配置顺序；当前文档列出 20,000 HTTP 请求/月、1 GB 出站/月，适合短时验收，不当作无限流量常驻服务器。Cloudflare Quick Tunnel 无需账号但地址随机，且官方明确不支持 SSE，因此不作为这份首次教程的默认路线。[Cloudflare 限制](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/)

## 附录 A：完整 Bridge 环境变量表

本轮没有新增环境变量或更改认证架构；保留清单如下。每次修改均需重启进程。

| 变量 | 必填条件 | 敏感性 | 默认/用途 |
|---|---|---|---|
| `BRIDGE_PUBLIC_ORIGIN` | 必填 | 公开 | HTTPS origin；resource/audience，与 API Identifier 一致 |
| `MCP_OAUTH_ISSUER` | 必填 | 公开 | Auth0 issuer，默认域名带 HTTPS |
| `MCP_OAUTH_SUBJECT` | 必填 | 个人标识 | 唯一使用人的 Auth0 User ID |
| `MCP_OAUTH_CLIENT_ID` | 必填 | 公开 | 预注册应用 ID，用于验证 azp |
| `NETEASE_INVITER_UID` | 一起听启用时必填 | 个人标识 | 主号数字 UID，限制邀请与聊天来源 |
| `NETEASE_COOKIE` | 一起听启用时必填 | **秘密** | Ash 小号 Cookie，含有效 MUSIC_U |
| `TOGETHER_ENABLED` | 可选 | 公开 | 默认启用；false 可只验 OAuth，不绕过鉴权 |
| `NODE_ENV` | 可选 | 公开 | 建议 production，不影响是否鉴权 |
| `PORT` | 可选 | 公开 | 8787；本地隧道必须指向相同端口 |
| `BRIDGE_UNIX_SOCKET` | 可选 | 本机路径 | 留空；Linux 可选 socket，仍强制 OAuth |
| `BRIDGE_INGEST_TOKEN` | 可选 | **秘密** | 留空关闭 /events；若启用需独立随机至少 32 字符，本次不用 |
| `TOGETHER_POLL_INTERVAL_MS` | 可选 | 公开 | 4000，邀请/房间轮询 |
| `TOGETHER_HEARTBEAT_INTERVAL_MS` | 可选 | 公开 | 10000，心跳 |
| `TOGETHER_PLAYBACK_RECONCILE_INTERVAL_MS` | 可选 | 公开 | 30000，HTTP 状态校准 |
| `TOGETHER_PLAYBACK_CONTROL_TIMEOUT_MS` | 可选 | 公开 | 8000，等待控制确认 |
| `TOGETHER_PLAYBACK_DIAGNOSTICS` | 可选 | 公开 | false；诊断只限白名单字段，本次保持关闭 |

Node 的 `--env-file` 在同名进程环境变量已存在时优先保留原环境值。因此不要同时在 Windows 全局环境里设另一套 Bridge 配置；如果换文件后状态仍旧，检查并移除你自己以前设置的同名变量，然后新开窗口，而不是显示整份环境。

`NGROK_AUTHTOKEN` 是隧道客户端变量，**不由 Bridge 读取**。Auth0 Client Secret、你的登录密码、验证码、access/refresh token 都不是上述表的配置项。

## 附录 B：本次准备已检查与未检查的边界

- 合并后的 main：Node 22 下完整自动测试 **104 通过、0 失败、0 跳过**；TypeScript 构建、类型检查通过。
- Windows 平台检查：已静态核对锁定版本 node-nim 下载脚本支持 win32 x64，以及代码使用系统临时目录、模块相对路径和当前 Node 子进程；未创建个人路径/域名硬编码。
- 自动测试依赖以跳过安装脚本的方式安装，真实 NIM 原生连接未执行；所以教程要求你真实准备时正常 `npm ci`，不能把 mock 测试通过等同于 DLL/网络/账号链路通过。
- 未登录 Auth0 或网易云真实账号、未创建第三方资源、未读取真实凭据、未启动公网隧道、未部署。本教程的真实验收表全部保留“待验”。

以后第三方界面或套餐变化时，以链接的官方说明与实际字段为准。若某步缺少所需入口，停在该步排查权限/兼容性，不改成匿名、不把秘密发给模型。
