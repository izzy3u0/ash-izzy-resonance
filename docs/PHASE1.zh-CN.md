# 第一阶段：安全与最小真实链路

本分支的配置、安全与验收以本文为准。上游 README、V2 与架构文档保留历史背景；其中匿名 MCP、可省略 eventId、误传 ID 自动纠正等旧说明不适用于本分支。

第一次使用 Windows 本机验收，请阅读配套的 **[《第一次真实验收教程》](FIRST_REAL_ACCEPTANCE.zh-CN.md)**。其中包含从零配置 Auth0、临时 HTTPS 地址、Cookie 本机保管与逐项验收步骤；本文件保留安全契约和变量速查。

本阶段没有数据库、新 UI、人格设置或长期记忆，也没有部署。one-earbud 保持独立。原有账号歌单、喜欢、历史、每日推荐实现暂时留在源码，但不再注册到 /mcp 或 /mcp/music；仅开放搜歌、一起听和 Bridge 工具。

## 1. 采用什么鉴权

Bridge 是 OAuth 资源服务器；推荐 Auth0 托管登录与授权。这样不需要在本仓库实现登录页面、保存用户密码、签发或持久化授权码，也不依赖 ChatGPT 手机端不能自行设置的自定义 API Key 请求头。

- 两个 MCP 地址的所有方法（包括 initialize、tools/list、resources/list、tools/call）都必须带有效 OAuth Bearer JWT。
- 校验 RS256 签名、issuer、audience、iat、exp、scope、唯一允许的用户 sub 和预注册客户端 azp。
- scope 固定为 bridge:access；JWT audience 固定为 BRIDGE_PUBLIC_ORIGIN，不含末尾斜杠。
- 只接受有效期不超过 1 小时的访问令牌，建议在身份平台设为 15 分钟。
- 未认证、过期、签名不符、其他用户或其他客户端一律 401；不会执行工具。
- 不支持匿名模式或通过 NODE_ENV 跳过鉴权。
- /.well-known/oauth-protected-resource 提供公开、无敏感数据的资源元数据，401 的 WWW-Authenticate 指向它。
- / 与 /healthz 只返回存活信息，不暴露队列、账号或聊天内容。
- 网易云 SDK 会在失败时自行打印完整响应。本分支按异步调用上下文屏蔽它的 console 输出，仅在 Bridge 层保留脱敏操作码；不会临时全局切换日志而串扰并发请求。
- /events 默认关闭。配置独立秘密后才启用；它不能伪造任何 netease 来源。
- /listener/events 仅接受由已认证 MCP 调用签发的短时、单次使用 capability。它只传 wake，不传聊天正文；它不能代替 OAuth 调用工具。会话最长 10 分钟，不应记录 URL 查询串。

本服务只保存服务器环境变量中的敏感值。OAuth 用户密码、客户端秘密和刷新令牌由 Auth0 与 ChatGPT 各自安全管理，Bridge 不需要 OAuth Client Secret，也不会接收你的身份平台登录密码。

参考：[OpenAI 官方 MCP 鉴权](https://developers.openai.com/plugins/build/auth)、[ChatGPT 自定义 MCP](https://developers.openai.com/api/docs/guides/custom-mcp-server)、[Auth0 的 resource 参数兼容说明](https://support.auth0.com/center/s/article/mcp-audience-error-with-auth0)。

## 2. 配置 Auth0 与 ChatGPT（部署时由你操作）

建议使用独立的 Auth0 租户，避免改变其他应用的租户级设置。本阶段代码没有替你创建租户或应用。

1. 创建一个 API。Identifier 精确设为 Bridge 的公开 HTTPS origin，例如 https://bridge.example.com。签名选择 RS256；使用包含 azp 的 Auth0 JWT access-token 格式，不使用加密 JWE。将访问令牌期限设为 900 秒。
2. 为 API 创建 bridge:access 权限。若启用 RBAC，给你的登录用户分配包含该权限的角色，确认最终访问令牌的 scope 包含 bridge:access。
3. 在租户高级设置启用 Resource Parameter Compatibility Profile，使 ChatGPT 的 resource 参数映射到正确的 API audience。不要靠放宽本服务的 audience 校验解决问题。
4. 创建专门的预注册 OAuth 应用，使用 Authorization Code + PKCE（S256）；允许需要的刷新令牌流程。配置它可访问上述 API。令牌端点认证方式与 ChatGPT 的静态 Client ID / Client Secret 设置匹配（例如 client_secret_post）。
5. 将该应用的 Client ID 配到 MCP_OAUTH_CLIENT_ID。将你在 Auth0 用户详情中的精确 User ID 配到 MCP_OAUTH_SUBJECT；不是邮箱、昵称、网易云 UID，也不是 OAuth Client ID。
6. 在 ChatGPT 网页的自定义 MCP 插件管理中选择 OAuth，填写 /mcp/music 地址，并填该预注册应用的 Client ID / Client Secret 到私密认证设置。不要选匿名，也不要把这些内容发给模型。
7. 从 ChatGPT 管理界面复制实际显示的精确 OAuth 回调地址，加入 Auth0 应用的 Allowed Callback URLs。不要使用通配符，不要猜 callback ID；某些连接显示稳定回调，另一些显示连接专属回调。
8. 安装/连接插件，完成 Auth0 托管登录与授权。使用的是上面指定的你本人账号。另一位即使能在租户登录，也会被 Bridge 的 sub 白名单拒绝。
9. 先确认网页能完成一次读取，再在同一 ChatGPT 账号的 iPhone 客户端验收。

这是预注册客户端路线，Bridge 不需要 DCR 或 CIMD，也不需要开放任意第三方客户端注册。若你的 ChatGPT 界面没有静态 OAuth 凭据配置入口，先核对账号/工作区可用性及官方说明；不要改成匿名来凑通。

身份平台与 ChatGPT 的实际互通仍需部署后验收；自动测试模拟的是签名令牌和 HTTP 请求，不会伪称已经登录真实 Auth0 或 ChatGPT。

## 3. 环境变量完整清单

服务器只从进程环境读取配置，不自动读取 .env。可由托管平台 Secret/环境变量设置，或 systemd EnvironmentFile 加载；本地 Node 22 可用 node --env-file=.env dist/src/server.js。私密配置文件设为仅运行用户可读。

| 变量 | 是否必填 | 是否敏感 | 用途/默认 |
|---|---|---|---|
| BRIDGE_PUBLIC_ORIGIN | 必填 | 否 | HTTPS origin；OAuth resource/audience、MCP App 网络权限 |
| MCP_OAUTH_ISSUER | 必填 | 否 | Auth0 HTTPS 租户 origin；校验发行者，读取其 /.well-known/jwks.json |
| MCP_OAUTH_SUBJECT | 必填 | 隐私标识，非密钥 | 唯一允许用户的精确 Auth0 User ID |
| MCP_OAUTH_CLIENT_ID | 必填 | 否 | 预注册 ChatGPT OAuth 应用 Client ID，校验 azp |
| NETEASE_COOKIE | 一起听启用时必填 | **是** | Ash 小号会话，必须有非空 MUSIC_U |
| NETEASE_INVITER_UID | 一起听启用时必填 | 非密钥，账号标识 | 你的主号 UID，限制邀请及聊天室消息来源 |
| TOGETHER_ENABLED | 可选 | 否 | 默认启用；false 明确禁用 Worker，不能借此跳过 OAuth |
| NODE_ENV | 可选 | 否 | 生产设 production；不影响是否鉴权 |
| PORT | 可选 | 否 | 默认 8787，托管平台可能注入 |
| BRIDGE_INGEST_TOKEN | 可选 | **是** | 留空关闭 /events；启用须独立随机秘密，至少 32 字符 |
| BRIDGE_UNIX_SOCKET | 可选 | 否 | 本地 socket；相同 OAuth 检查，权限 0600 |
| TOGETHER_POLL_INTERVAL_MS | 可选 | 否 | 默认 4000，房间/邀请轮询 |
| TOGETHER_HEARTBEAT_INTERVAL_MS | 可选 | 否 | 默认 10000，房间心跳 |
| TOGETHER_PLAYBACK_RECONCILE_INTERVAL_MS | 可选 | 否 | 默认 30000，播放状态校准 |
| TOGETHER_PLAYBACK_CONTROL_TIMEOUT_MS | 可选 | 否 | 默认 8000，控制/队列确认等待 |
| TOGETHER_PLAYBACK_DIAGNOSTICS | 可选 | 否 | 默认关闭；仅白名单协议字段诊断，不含聊天正文 |

不要复用 one-earbud 的口令、数据目录、部署服务或 OAuth 应用。OAuth 登录密码、Client Secret、验证码不属于本服务的环境变量；不要放入仓库或聊天。

Cookie 只在可信设备本地取得，然后由你直接填入服务器秘密配置。没有要求你发给聊天的步骤。本阶段没有扫码登录 UI 或自动 Cookie 刷新；过期后由你安全更新环境变量并重启。

## 4. 房间绑定规则

- 主号与 Ash 小号必须不同。
- 只检查 NETEASE_INVITER_UID 对应的私信，不遍历其他联系人。
- 邀请实际发送者和邀请 URL 的 inviterId 必须同时匹配主号。缺少发送者身份时拒绝。
- 仅处理服务启动/主动退出之后的新邀请，且邀请不超过 5 分钟。应先启动 Bridge，再发送邀请。
- 接受邀请后，重新读取网易云房间状态确认是该房间，才建立绑定与 NIM 连接。
- 服务器启动时如果小号已在未知房间，不会接管，也不会擅自结束它。用网易云官方客户端退出该旧房间，再由主号重新邀请。
- 绑定包括 roomId、chatRoomId 和每次入房重新生成的 bindingId。bindingId 是防止串房的标识，不是访问凭据。
- 仅主号的普通文字进入聊天事件队列，过滤小号回声、第三人和重复消息。
- 回复必须携带 Listener 返回的精确 eventId；不再省略或自动纠正旧 ID。
- 主动发送普通消息必须携带当前 bindingId。发消息/播放控制前再次检查网易云房间状态；旧绑定一律拒绝。
- 退出只有在权威房间状态确认离开后才返回成功。

这会有意改变上游“自动接管已在房间的小号”和“纠正过时回复 ID”的行为，原因是没有持久化时不能证明旧房间与旧回复仍属于当前会话。本阶段不通过默认信任降低安全要求。

## 5. 最小部署准备与命令

本机验收可使用 Windows x64、Node 22 和临时 HTTPS 隧道，步骤见配套教程；真实 NIM 连接仍需人工验收。未来服务器准备 Linux x86_64、Node 22、可访问网易云和 Auth0 的网络，以及公开 HTTPS 地址。Docker 使用仓库 Debian/glibc 的 node:22-slim，不用 Alpine。正常安装需要下载 node-nim 对应平台的原生 SDK，不能把 Windows node_modules 复制到 Linux。

仅当你开始部署时执行：

```sh
npm ci
npm test
npm run build
# 配置通过平台环境变量或 systemd 注入后：
npm start
# 若本地使用权限受限的 .env 文件：
node --env-file=.env dist/src/server.js
```

反向代理需支持 MCP 请求至少 45 秒，以及可选 SSE 流；代理访问日志不要记录 Authorization、Cookie、请求正文或完整查询串。不要使用会把这些字段完整上传的请求调试/异常追踪配置。

当前仍是单实例、单活跃 Listener、内存队列；进程重启会丢失未处理消息和房间绑定。本阶段不加数据库，也不保证无人值守或 iOS 锁屏后的持续响应。

## 6. 最小真实验收：逐项确认

### A. 先验鉴权

- 未登录访问 /mcp 与 /mcp/music：应为 401，包含 WWW-Authenticate。
- 元数据可公开读取，但不包含 Cookie/Token。
- 在 ChatGPT 完成 OAuth 后，能列出工具并调用 netease_together_status。
- 不要复制 Bearer Token 到聊天做排错；只报告成功/失败、HTTP 状态和经过脱敏的错误码。

### B. 验登录与入房

1. 服务器填好 Ash 小号 Cookie 和主号 UID，启动 Bridge。
2. 调用 netease_together_status：enabled=true，accountId 是 Ash 小号，phase 最终为 waiting_invite；bound=false。
3. 主号 iPhone 创建一起听，通过网易云私信发邀请给 Ash 小号。
4. 再读状态：roomId 对应本次房间，bound=true，realtimeConnected=true。
5. 若 lastError 为 unbound_room：在官方客户端退出小号旧房间，然后重新邀请；不要解除白名单。
6. 用另一账号发邀请，确认不会入房。不要为测试在配置里放宽 UID。

### C. 验读取与消息

1. 播放一首有普通歌词的歌曲，调用 netease_together_now，核对歌曲、播放/暂停、进度、当前附近歌词和 observedAt。进度是校准后的估计，不承诺逐字无延迟。
2. 显式开始 Long-wait：cove_bridge_wait。不要同时启动 Widget。
3. 主号在网易云房间发一句不含敏感信息的测试文字。
4. wait 返回 source=netease.chatroom 和 eventId，调用 cove_bridge_wait_ack。
5. 调用 cove_bridge_reply，带该 eventId 和一条普通测试回复。手机应只收到一次。
6. 单独测试普通发言：先读 netease_together_status，取 binding.bindingId；再调用 netease_together_send_message，传 text 与 bindingId。
7. 检查应用日志不出现聊天正文、Cookie、Token 或验证码。

### D. 可选验现有点歌控制

搜歌用 netease_search_songs；新歌曲先 netease_together_enqueue_next，再 netease_together_goto。下一首和插歌仅支持 ORDER_LOOP。暂停/继续/切歌需匹配实时回执；接口返回 confirmed 后仍要人工核对手机是否播放，版权可播放性是另一层。本阶段保留这些已有能力，没有扩展账号歌单功能。

### E. 验退出与过时操作

调用 netease_together_leave，应返回 ended=true（或已退出的 no-op）。随后 now.inRoom=false、binding=null。使用旧 bindingId 或旧 eventId 发消息必须失败。服务重启后，先清理旧一起听房间再发新邀请；不要期待内存消息恢复。

以上真实验收本轮未执行：需要你未来在自己的可信配置界面完成登录与部署。本轮自动测试只用 mock/fixture、运行时生成的测试签名密钥和本机 HTTP 回环。

## 7. 仍然存在的边界

- 不保证永久后台监听，Long-wait 依赖运行中的模型回合。
- 未持久化队列、回复日志、去重记录和绑定；没有租约恢复或多 Listener 所有权。
- 普通主动 send 不是幂等工具；超时后先在手机确认是否已收到，避免盲目重试。
- 网易云非官方接口、Cookie、NIM 原生 SDK、版权与地区限制仍需真实环境验证。
- JWT 是离线验签，身份平台撤销会话不一定立即使已签发访问令牌失效；紧急停用时停止服务或更改唯一允许的用户/客户端配置后重启，平时使用短令牌。
- 退出后已显示在 ChatGPT 历史中的文字不会被自动删除。
