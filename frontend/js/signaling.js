(function (global) {
  'use strict';

  /**
   * 信令客户端
   * 负责与后端 WebSocket 信令服务器通信，交换房间配对与 WebRTC 协商信息
   */
  function SignalingClient(serverUrl) {
    this.serverUrl = serverUrl;
    this.ws = null;
    this.roomId = null;
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

  SignalingClient.prototype.connect = function () {
    var self = this;
    try {
      this.ws = new WebSocket(this.serverUrl);
    } catch (e) {
      if (this.onError) this.onError('无法连接服务器：' + e.message);
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
      if (self.onError) self.onError('连接发生错误，请检查服务器地址');
    };

    this.ws.onmessage = function (event) {
      var data;
      try {
        data = JSON.parse(event.data);
      } catch (e) {
        return;
      }
      self._handleMessage(data);
    };
  };

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

  SignalingClient.prototype._send = function (data) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  };

  // 监听端：创建房间
  SignalingClient.prototype.create = function (roomId) {
    this.roomId = roomId;
    this._send({ type: 'create', roomId: roomId });
  };

  // 采集端：加入房间
  SignalingClient.prototype.join = function (roomId) {
    this.roomId = roomId;
    this._send({ type: 'join', roomId: roomId });
  };

  SignalingClient.prototype.sendOffer = function (sdp) {
    this._send({ type: 'offer', roomId: this.roomId, sdp: sdp });
  };

  SignalingClient.prototype.sendAnswer = function (sdp) {
    this._send({ type: 'answer', roomId: this.roomId, sdp: sdp });
  };

  SignalingClient.prototype.sendCandidate = function (candidate) {
    this._send({ type: 'candidate', roomId: this.roomId, candidate: candidate });
  };

  SignalingClient.prototype.leave = function () {
    if (this.roomId) {
      this._send({ type: 'leave', roomId: this.roomId });
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
