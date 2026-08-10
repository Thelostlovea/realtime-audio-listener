# audio-listener-signaling

实时音频监听 H5 应用的 **WebRTC 信令服务器**。

这是一个单向音频监听应用：**B 手机**采集环境声（sender / 采集端），**A 手机**实时收听（listener / 监听端）。
本服务器为轻量 WebSocket 信令服务，**只负责房间配对与 WebRTC 连接信息（SDP / ICE）交换，不传输音频流本身**——音频走浏览器之间的 WebRTC P2P 通道。

## 技术栈

- Node.js + [`ws`](https://www.npmjs.com/package/ws)（WebSocket 实现）
- 无需任何持久化存储，房间状态保存在内存中

## 信令协议

所有消息均为 JSON，每条消息包含 `type` 字段。

### 客户端 -> 服务器

| type | 字段 | 说明 |
| ---- | ---- | ---- |
| `create` | `roomId` | 创建房间，把自己注册为监听端(listener) |
| `join` | `roomId` | 加入房间，把自己注册为采集端(sender) |
| `offer` | `roomId`, `sdp` | SDP offer，转发给房间内另一方 |
| `answer` | `roomId`, `sdp` | SDP answer，转发 |
| `candidate` | `roomId`, `candidate` | ICE 候选，转发 |
| `leave` | `roomId` | 离开房间 |

### 服务器 -> 客户端

| type | 字段 | 说明 |
| ---- | ---- | ---- |
| `created` | `roomId` | 房间创建成功 |
| `joined` | `roomId` | 加入成功 |
| `peer-joined` | — | 对方已加入，可开始 WebRTC 协商 |
| `peer-left` | — | 对方已离开 |
| `offer` | `sdp` | 收到对方 offer |
| `answer` | `sdp` | 收到对方 answer |
| `candidate` | `candidate` | 收到 ICE 候选 |
| `error` | `message` | 错误 |

> 房间号校验：必须是 **4 位数字字符串**（如 `"1234"`）。

## 典型连接流程

```
A(监听端 listener)            信令服务器              B(采集端 sender)
      |                           |                         |
      |--- create {roomId} ------>|                         |
      |<-- created {roomId} ------|                         |
      |                           |                         |
      |                           |<--- join {roomId} ------|
      |<-- peer-joined ------------|                         |
      |                           |--- joined {roomId} ---->|
      |                           |                         |
      |--- offer {roomId,sdp} --->|--- offer {sdp} -------->|
      |                           |                         |
      |<-- answer {sdp} ----------|<-- answer {roomId,sdp} -|
      |                           |                         |
      |<-- candidate {candidate} -|<-- candidate {roomId,c} |
      |--- candidate {roomId,c} ->|--- candidate {c} ------>|
      |                           |                         |
      |================ WebRTC P2P 音频通道建立 =============|
```

## 本地运行

前置条件：已安装 Node.js（建议 v18+）。

```bash
cd server
npm install
npm start
```

启动后默认监听 `ws://localhost:8080`。可通过环境变量修改端口：

```bash
PORT=3000 npm start
```

启动成功会打印：

```
[信令服务器] 已启动，监听端口 8080
[信令服务器] 协议：WebSocket(JSON)，单向音频监听（listener 收听 / sender 采集）
```

## 部署到 Render（免费套餐）

Render 提供免费的 Web Service，适合部署本信令服务器。

1. **推送代码到 GitHub**：将整个 `server` 目录（包含 `server.js`、`package.json`）提交到 GitHub 仓库。

2. **创建 Web Service**：
   - 登录 [Render 控制台](https://dashboard.render.com/)
   - 点击 **New** -> **Web Service**
   - 选择 **Connect a repository**，连接你的 GitHub 仓库

3. **配置服务**：
   - **Name**：随意，如 `audio-listener-signaling`
   - **Runtime**：Node
   - **Build Command**：**留空**（无需构建步骤，`npm install` Render 会自动执行）
   - **Start Command**：`npm start`
   - **Instance Type**：Free

4. **环境变量**：无需手动设置 `PORT`，Render 会自动注入 `PORT` 环境变量，代码中已通过 `process.env.PORT` 读取。

5. **部署完成**：Render 会分配一个公网地址，形如：

   ```
   https://audio-listener-signaling.onrender.com
   ```

   前端 H5 使用该地址建立 WebSocket 连接：

   ```js
   // 注意：H5 页面若是 https，WebSocket 必须用 wss
   const ws = new WebSocket('wss://audio-listener-signaling.onrender.com')
   ```

> 提示：Render 免费套餐服务会在 15 分钟无流量后休眠，首次请求会有冷启动延迟（约 30~60 秒）。生产环境建议升级付费套餐。

## 目录结构

```
server/
├── server.js       # 信令服务器主程序
├── package.json    # 依赖与启动脚本
└── README.md       # 说明文档
```
