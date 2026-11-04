# 2026-11-05 真实 custom 消息采样结论

本次在已入房的 Windows Bridge 上，为现有 NIM `receiveMsg` 回调增加了一个临时只读观察器，没有重启或替换业务回调。记录的是字段名称、层级、类型、少量协议枚举，以及测试标记是否出现；没有保存原始正文、账号标识、IP、设备 ID、Cookie 或 Token 的值。采样结束后观察器已关闭，临时调试端口也已关闭。采样脚本和结构快照只在被 Git 忽略的本机 `dist/` 中。

## 实际采到的结构

测试标记为 `COVE_CUSTOM_PROBE_C1`。共采到 3 条主号来源的 `msg_type_=100` 包和 1 条包含标记的 `msg_type_=0` 文字消息。

两条 custom 包的主要路径如下。尖括号表示类型或替换值，不是真实值：

```text
msg_type_ = 100
msg_body_ = ""
JSON.parse(msg_attach_)
  .msgType = 120
  .content.type = 20009
  .content.content
    .serverSeq: <number>
    .cantShowInSongPlay: <boolean>
    .ignoreUserIds: null
    .onlyCanSeeUserIds: null
    .roomId: <string>
    .distance: <number>
    .unopenedUserIds: <number[]>
    .copywriting: null
JSON.parse(msg_setting_.ext_).serverExt
  = 上述 .content 对象的对应结构
```

这些字段属于房间状态信息，没有测试标记，也没有可提取的用户聊天正文。另一条 custom 包具有相同 `msgType=120` 包装，内部 `content.type=20000`，包含 `commandType`、`playStatus`、歌曲 ID、进度和序号等播放协议字段，应继续由现有播放解码分支处理。

真正的测试文字及颜文字位于另一条消息：

```text
msg_type_ = 0
msg_body_ = ""
msg_attach_ = <包含 COVE_CUSTOM_PROBE_C1 的普通文字及颜文字>
msg_setting_.ext_ = <发送者资料、clientExt、clientInfo 等元数据的 JSON>
```

标记只出现在 `msg_attach_`，不在 `ext` 或 custom 状态包中。`clientInfo` 还出现反作弊 Token、IP 和设备字段，因此不能把完整 `ext` 当作聊天正文转发，或将其原值写日志。

## 最终修复范围

原解码器对这些无正文状态包返回 `text=null` 是正确行为。问题是后续状态包会覆盖 `lastChatMessage`，让实时摘要看起来像刚发的文字没有正文；文字事件仍然保存在队列中。

最终只调整摘要缓存：无可读正文的事件不再擦除上一条可读消息。回调和协议元数据日志仍照常处理这些事件；主号过滤、去重、队列、ACK、原房间回复、入房及播放控制保持原有逻辑。

此前尚未提交的递归猜测解析和 custom 消息统一放行已经撤回。不能由本次样本推出所有 `msg_type_=100` 都是聊天，也不能推出它们都不是聊天；未来若采到另一种真正携带用户正文的 custom 格式，应依据其明确结构再增加支持。

回归样本见 `test/chatroomMessageFixtures.ts`，字段形状来自本次采样，标识和元数据值均为合成替代值。测试覆盖状态包识别、颜文字原样保留、摘要不被覆盖，以及真实字段形状经 `receiveMsg → owner filter/dedupe → wait → ACK → reply` 的离线闭环。

## 修复后的真实验收：通过

2026-11-05（Asia/Shanghai），安全结束旧房间后重启本机 Bridge，加载最终修复；主号重新邀请 Ash 小号建立了新的房间绑定。此次验证不使用临时采样观察器。

1. 主号发送带颜文字的普通文字，实时状态读取到完整正文，实际消息类型为 `msgType=0`。
2. 在该文字之后，元数据日志确认又收到两条主号来源的 `custom / msgType=100 / textLength=0` 事件。再次读取实时状态，`lastChatMessage` 的原文和 messageId 均未变化，未被覆盖为 `text=null`。
3. MCP `cove_bridge_wait` 取到相同正文，使用返回的精确 eventId 完成 ACK 和 routed reply，发送结果为 `completed=true / sentCount=1`；用户在 iPhone 网易云聊天室确认回复正常出现。

三项真实验收均通过，本次“无正文状态包覆盖聊天摘要”问题已修复。自动测试为 108 项通过、0 失败、0 跳过；构建、类型检查和 `git diff --check` 均通过。上述结论仅覆盖本次问题，不表示已支持所有未知 custom 消息格式。
