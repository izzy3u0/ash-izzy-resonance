// Shapes observed through the local NIM receiveMsg probe on 2026-11-05 (Asia/Shanghai).
// Account/message/room identifiers and metadata values are synthetic replacements.
// Only protocol discriminators (100, 120, 20009, 0) retain their observed values.
export const capturedProbeText = "COVE_CUSTOM_PROBE_C1 颜文字采样 (｡•̀ᴗ-)✧";

export function capturedRoomStatusMessage(senderId = "12345", messageId = "status-fixture") {
  const envelope = {
    content: {
      serverSeq: 123, cantShowInSongPlay: false, ignoreUserIds: null,
      onlyCanSeeUserIds: null, roomId: "fixture-room", distance: 0,
      unopenedUserIds: [12345], copywriting: null,
    },
    type: 20009, bizType: 0, id: 1,
  };
  return {
    msg_type_: 100, sub_type_: 0, from_id_: senderId, from_nick_: "",
    client_msg_id_: messageId, timetag_: "123456789", msg_body_: "",
    msg_attach_: JSON.stringify({ content: envelope, msgType: 120 }),
    msg_setting_: { ext_: JSON.stringify({ serverExt: envelope, appName: "music", clientExt: {} }) },
  };
}

export function capturedUserTextMessage(senderId = "12345", messageId = "text-fixture") {
  return {
    msg_type_: 0, sub_type_: 0, from_id_: senderId, from_nick_: "",
    client_msg_id_: messageId, timetag_: "123456790", msg_body_: "",
    msg_attach_: capturedProbeText,
    msg_setting_: { ext_: JSON.stringify({
      serverExt: { gender: 0, avatarUrl: "https://example.invalid/avatar", nickname: "fixture", msgId: 1, userId: 12345 },
      appName: "music",
      clientExt: { bizType: "listenTogether", ltType: "FRIEND", roomId: "fixture-room", ignoreUserIds: ["12345"] },
    }) },
  };
}
