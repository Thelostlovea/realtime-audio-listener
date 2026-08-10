(function (global) {
  'use strict';

  /**
   * 信令客户端（ntfy.sh 版本）
   * 使用免费的 ntfy.sh 公共服务作为信令通道，无需自建后端服务器
   * 通过 WebSocket 订阅 + HTTP POST 发布实现房间配对与 WebRTC 协商信息交换
   */

  var NTFY_WS_BASE = 'wss://ntfy.sh';
  var NTFY_HTTP_BASE = 'https://ntfy.sh';
  var TOPIC_PREFIX = 'audio-listen-';

  function SignalingClient() {
    this.ws = null;
    this.roomId = null;
    this.peerId = null;
    this.connectTime = 0;
    this.isOpen = false;

    // 事件回调（由 app.js 注入）
    this.onOpen = null;
    this.onClose = null;
    this.onError = null;
    this.onCreated = null;
    this.onJoined = null;
    this.onPeerJoined = null;
    this.onPeerLeft = null;
    this.onOffer = null;
    this.onAnswer = null;
    this.onCandidate = null;
    this.onSignalingError = null;
  }

  /**
   * 连接到 ntfy.sh 信令通道
   * roomId 必须在调用前设置
   */
  SignalingClient.prototype.connect = function () {
    var self = this;
    this.peerId = Math.random().toString(36).substr(2, 9);
    this.connectTime = Math.floor(Date.now() / 1000);

    var topic = TOPIC_PREFIX + this.roomId;
    var wsUrl = NTFY_WS_BASE + '/' + topic + '/ws?since=' + this.connectTime;

    try {
      this.ws = new WebSocket(wsUrl);
    } catch (e) {
      if (this.onError) this.onError('无法连接信令服务：' + e.message);
      return;
    }

    this.ws.onopen = function () {
      self.isOpen = true;
      if (self.onOpen) self.onOpen();
    };

    this.ws.onclose = function () {
      self.isOpen = false;
      if (self.onClose) self.onClose();
    };

    this.ws.onerror = function () {
      if (self.onError) self.onError('信令连接发生错误');
    };

    this.ws.onmessage = function (event) {
      var ntfyMsg;
      try {
        ntfyMsg = JSON.parse(event.data);
      } catch (e) {
        return;
      }

      // 只处理消息事件，忽略 open/keepalive 事件
      if (ntfyMsg.event !== 'message') return;

      var data;
      try {
        data = JSON.parse(ntfyMsg.message);
      } catch (e) {
        return;
      }

      // 跳过自己发送的消息
      if (data.from === self.peerId) return;

      self._handleMessage(data);
    };
  };

  /**
   * 向信令通道发布消息（HTTP POST）
   */
  SignalingClient.prototype._publish = function (data) {
    if (!this.roomId) return;
    var topic = TOPIC_PREFIX + this.roomId;
    data.from = this.peerId;

    try {
      var xhr = new XMLHttpRequest();
      xhr.open('POST', NTFY_HTTP_BASE + '/' + topic, true);
      xhr.setRequestHeader('Content-Type', 'text/plain');
      xhr.send(JSON.stringify(data));
    } catch (e) {
      // 静默失败，不阻断流程
    }
  };

  /**
   * 处理收到的信令消息
   */
  SignalingClient.prototype._handleMessage = function (data) {
    switch (data.type) {
      case 'created':       if (this.onCreated) this.onCreated(data.roomId); break;
      case 'joined':        if (this.onJoined) this.onJoined(data.roomId); break;
      case 'peer-joined':   if (this.onPeerJoined) this.onPeerJoined(); break;
      case 'peer-left':     if (this.onPeerLeft) this.onPeerLeft(); break;
      case 'offer':         if (this.onOffer) this.onOffer(data.sdp); break;
      case 'answer':        if (this.onAnswer) this.onAnswer(data.sdp); break;
      case 'candidate':     if (this.onCandidate) this.onCandidate(data.candidate); break;
      case 'error':         if (this.onSignalingError) this.onSignalingError(data.message); break;
    }
  };

  // ==================== 信令操作 ====================

  /**
   * 监听端：创建房间
   * 订阅 ntfy.sh 主题即自动创建房间，无需额外消息
   */
  SignalingClient.prototype.create = function (roomId) {
    this.roomId = roomId;
    if (this.onCreated) this.onCreated(roomId);
  };

  /**
   * 采集端：加入房间
   * 向信令通道发布 peer-joined 消息，通知监听端
   */
  SignalingClient.prototype.join = function (roomId) {
    this.roomId = roomId;
    this._publish({ type: 'peer-joined' });
    if (this.onJoined) this.onJoined(roomId);
  };

  SignalingClient.prototype.sendOffer = function (sdp) {
    this._publish({ type: 'offer', sdp: sdp });
  };

  SignalingClient.prototype.sendAnswer = function (sdp) {
    this._publish({ type: 'answer', sdp: sdp });
  };

  SignalingClient.prototype.sendCandidate = function (candidate) {
    this._publish({ type: 'candidate', candidate: candidate });
  };

  SignalingClient.prototype.leave = function () {
    if (this.roomId) {
      this._publish({ type: 'peer-left' });
    }
  };

  SignalingClient.prototype.close = function () {
    this.leave();
    if (this.ws) {
      this.ws.onclose = null;
      try { this.ws.close(); } catch (e) {}
      this.ws = null;
    }
    this.isOpen = false;
  };

  global.SignalingClient = SignalingClient;
})(window);
