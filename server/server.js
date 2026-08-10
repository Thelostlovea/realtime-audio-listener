/**
 * 实时音频监听 H5 应用 —— WebRTC 信令服务器
 *
 * 单向音频监听场景：B 手机采集环境声（sender / 采集端），A 手机实时收听（listener / 监听端）。
 * 本服务器为轻量 WebSocket 信令服务，只负责房间配对与 WebRTC 连接信息交换，
 * 不传输音频流本身（音频走浏览器之间的 WebRTC P2P 通道）。
 *
 * 启动：npm start （端口取自环境变量 process.env.PORT，默认 8080）
 */

const http = require('http');
const WebSocket = require('ws');

// 服务端口（Render 等平台通过环境变量注入端口，必须读取 process.env.PORT）
const PORT = process.env.PORT || 8080;

// 房间表：roomId -> { listener: ws | null, sender: ws | null }
const rooms = new Map();

// ==================== 工具函数 ====================

/**
 * 向某个客户端发送 JSON 消息（仅在连接处于打开状态时发送）
 * @param {WebSocket} ws 目标连接
 * @param {object} obj 消息对象
 */
function send(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

/**
 * 发送错误消息
 * @param {WebSocket} ws 目标连接
 * @param {string} message 错误描述
 */
function sendError(ws, message) {
  send(ws, { type: 'error', message });
}

/**
 * 校验房间号：必须是 4 位数字字符串
 * @param {any} roomId
 * @returns {boolean}
 */
function isValidRoomId(roomId) {
  return typeof roomId === 'string' && /^\d{4}$/.test(roomId);
}

/**
 * 在房间内找到"另一方"（不是发送方 ws 的那个人）
 * @param {{listener:WebSocket|null, sender:WebSocket|null}} room
 * @param {WebSocket} ws 发送方
 * @returns {WebSocket|null}
 */
function getPeer(room, ws) {
  if (room.listener && room.listener !== ws) return room.listener;
  if (room.sender && room.sender !== ws) return room.sender;
  return null;
}

/**
 * 将某个 ws 从房间中移除：
 *   1. 清掉自己占据的角色（listener 或 sender）
 *   2. 通知另一方 peer-left
 *   3. 房间空了（listener 与 sender 均为空）则删除房间
 *
 * @param {string} roomId 房间号
 * @param {WebSocket} ws 要移除的连接
 */
function removePeer(roomId, ws) {
  const room = rooms.get(roomId);
  if (!room) return;

  let peer = null;
  if (room.listener === ws) {
    room.listener = null;
    peer = room.sender; // 另一方是采集端
  } else if (room.sender === ws) {
    room.sender = null;
    peer = room.listener; // 另一方是监听端
  } else {
    // 该 ws 不属于此房间，无需处理
    return;
  }

  // 通知对方自己已离开
  if (peer) {
    send(peer, { type: 'peer-left' });
  }

  // 房间空了就删除
  if (!room.listener && !room.sender) {
    rooms.delete(roomId);
  }
}

// ==================== 消息处理 ====================

/**
 * 处理 create：创建房间，把自己注册为监听端(listener)
 *   - 房间号非法 -> 报错
 *   - 房间已存在且监听端已占 -> 报错
 *   - 否则 rooms.set(roomId, {listener: ws, sender: null})，回复 created
 */
function handleCreate(ws, roomId) {
  if (!isValidRoomId(roomId)) {
    return sendError(ws, '房间号必须是 4 位数字');
  }
  const exist = rooms.get(roomId);
  if (exist && exist.listener) {
    return sendError(ws, '房间已存在，监听端已被占用');
  }
  // 若房间残留了旧的采集端（监听端此前已离开），通知其离开
  if (exist && exist.sender) {
    send(exist.sender, { type: 'peer-left' });
  }
  rooms.set(roomId, { listener: ws, sender: null });
  ws.__roomId = roomId; // 记录所属房间，断开连接时用于清理
  ws.__role = 'listener';
  send(ws, { type: 'created', roomId });
}

/**
 * 处理 join：加入房间，把自己注册为采集端(sender)
 *   - 房间号非法 / 房间不存在 / 监听端未就绪 / 采集端已被占 -> 报错
 *   - 设置 rooms.get(roomId).sender = ws；通知 listener 发送 peer-joined；回复 joined
 */
function handleJoin(ws, roomId) {
  if (!isValidRoomId(roomId)) {
    return sendError(ws, '房间号必须是 4 位数字');
  }
  const room = rooms.get(roomId);
  if (!room) {
    return sendError(ws, '房间不存在');
  }
  if (!room.listener) {
    return sendError(ws, '监听端尚未就绪，请稍后再试');
  }
  if (room.sender) {
    return sendError(ws, '房间已被其他采集端占用');
  }
  room.sender = ws;
  ws.__roomId = roomId;
  ws.__role = 'sender';
  // 通知监听端：对方已加入，可开始 WebRTC 协商
  send(room.listener, { type: 'peer-joined' });
  send(ws, { type: 'joined', roomId });
}

/**
 * 转发 offer / answer / candidate 给房间内另一方
 * 转发时去掉 roomId，只保留 type + (sdp | candidate)
 *
 * @param {WebSocket} ws 发送方
 * @param {string} roomId 房间号
 * @param {string} type 消息类型 'offer' | 'answer' | 'candidate'
 * @param {object} payload { sdp } | { candidate }
 */
function forward(ws, roomId, type, payload) {
  if (!isValidRoomId(roomId)) {
    return sendError(ws, '房间号必须是 4 位数字');
  }
  const room = rooms.get(roomId);
  if (!room) {
    return sendError(ws, '房间不存在');
  }
  // 确认发送方确实属于该房间，防止越权转发
  if (room.listener !== ws && room.sender !== ws) {
    return sendError(ws, '你不在此房间中');
  }
  const peer = getPeer(room, ws);
  if (!peer) {
    return sendError(ws, '对方尚未加入，无法转发');
  }
  send(peer, Object.assign({ type }, payload));
}

/**
 * 处理 leave：主动离开房间
 * 优先使用服务端记录的房间号(ws.__roomId)进行清理，保证清理正确
 */
function handleLeave(ws, roomId) {
  const targetRoomId = ws.__roomId || roomId;
  if (targetRoomId) {
    removePeer(targetRoomId, ws);
  }
  ws.__roomId = null;
  ws.__role = null;
}

// ==================== HTTP + WebSocket 服务 ====================

// 创建 HTTP 服务器，处理健康检查请求
const server = http.createServer((req, res) => {
  if (req.method === 'GET' && (req.url === '/' || req.url === '/health')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      service: 'audio-listener-signaling',
      rooms: rooms.size,
      uptime: process.uptime()
    }));
  } else {
    res.writeHead(404);
    res.end('Not Found');
  }
});

// 将 WebSocket 服务器附加到 HTTP 服务器
const wss = new WebSocket.Server({ server });

server.listen(PORT, () => {
  console.log(`[信令服务器] 已启动，监听端口 ${PORT}`);
  console.log('[信令服务器] 协议：HTTP + WebSocket(JSON)，单向音频监听（listener 收听 / sender 采集）');
});

wss.on('connection', (ws) => {
  ws.__roomId = null;
  ws.__role = null;
  console.log('[连接] 新客户端已连接');

  ws.on('message', (raw) => {
    let msg;
    // JSON 解析错误处理
    try {
      msg = JSON.parse(raw.toString());
    } catch (e) {
      return sendError(ws, '消息格式错误，需为合法 JSON');
    }

    // 防御：消息体不是对象或缺少 type
    if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') {
      return sendError(ws, '消息缺少 type 字段');
    }

    const { type, roomId } = msg;

    switch (type) {
      case 'create':
        handleCreate(ws, roomId);
        break;
      case 'join':
        handleJoin(ws, roomId);
        break;
      case 'offer':
        forward(ws, roomId, 'offer', { sdp: msg.sdp });
        break;
      case 'answer':
        forward(ws, roomId, 'answer', { sdp: msg.sdp });
        break;
      case 'candidate':
        forward(ws, roomId, 'candidate', { candidate: msg.candidate });
        break;
      case 'leave':
        handleLeave(ws, roomId);
        break;
      default:
        sendError(ws, `未知的消息类型: ${type}`);
    }
  });

  // 连接关闭：清理该 ws 所属房间，通知对方 peer-left，房间空了则删除
  ws.on('close', () => {
    console.log('[断开] 客户端已断开');
    if (ws.__roomId) {
      removePeer(ws.__roomId, ws);
    }
  });

  // 连接异常：记录日志，避免进程崩溃
  ws.on('error', (err) => {
    console.error('[错误] 连接异常:', err.message);
  });
});
