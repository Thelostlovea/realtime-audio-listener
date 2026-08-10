(function (global) {
  'use strict';

  /**
   * WebRTC 处理器
   * 封装 RTCPeerConnection，管理本地麦克风采集与远端音频接收
   *
   * 角色：
   *   listener（监听端 A）：createOffer → 收 answer → 收 candidate → 播放远端音频
   *   sender（采集端 B）：  获取麦克风 → 收 offer → createAnswer（附加音频轨道）→ 发 candidate
   */
  function WebRTCHandler(options) {
    options = options || {};
    // ICE 服务器：免费 STUN + 免费 TURN 兜底
    this.iceServers = options.iceServers || [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' },
      // 免费 TURN（OpenRelay），对称型 NAT 时兜底中继
      { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
      { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
      { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' }
    ];
    this.pc = null;
    this.localStream = null;

    // 事件回调
    this.onIceCandidate = null;
    this.onRemoteStream = null;
    this.onStateChange = null;
    this.onAudioLevel = null;
  }

  WebRTCHandler.prototype.createPeer = function () {
    var self = this;
    this.pc = new RTCPeerConnection({ iceServers: this.iceServers });

    // ICE 候选生成
    this.pc.onicecandidate = function (event) {
      if (event.candidate && self.onIceCandidate) {
        self.onIceCandidate(event.candidate);
      }
    };

    // 连接状态变化
    this.pc.onconnectionstatechange = function () {
      if (self.onStateChange) self.onStateChange(self.pc.connectionState);
    };

    // 接收远端音频流（监听端）
    this.pc.ontrack = function (event) {
      if (self.onRemoteStream) self.onRemoteStream(event.streams[0]);
    };

    return this.pc;
  };

  // 监听端：创建 offer（表达接收音频意愿）
  WebRTCHandler.prototype.createOffer = function () {
    var self = this;
    return this.pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: false })
      .then(function (offer) {
        return self.pc.setLocalDescription(offer);
      })
      .then(function () {
        return self.pc.localDescription;
      });
  };

  // 采集端：处理 offer，附加麦克风，生成 answer
  WebRTCHandler.prototype.handleOffer = function (sdp) {
    var self = this;
    return this.pc.setRemoteDescription({ type: 'offer', sdp: sdp })
      .then(function () {
        // 附加本地麦克风音频轨道
        if (self.localStream) {
          self.localStream.getTracks().forEach(function (track) {
            self.pc.addTrack(track, self.localStream);
          });
        }
        return self.pc.createAnswer();
      })
      .then(function (answer) {
        return self.pc.setLocalDescription(answer);
      })
      .then(function () {
        return self.pc.localDescription;
      });
  };

  // 监听端：处理 answer
  WebRTCHandler.prototype.handleAnswer = function (sdp) {
    return this.pc.setRemoteDescription({ type: 'answer', sdp: sdp });
  };

  WebRTCHandler.prototype.addCandidate = function (candidate) {
    var self = this;
    if (!candidate) return Promise.resolve();
    return this.pc.addIceCandidate(candidate).catch(function () {
      // 候选到达过早时静默忽略，稍后会重试
    });
  };

  // 采集端：获取麦克风
  WebRTCHandler.prototype.startLocalStream = function () {
    var self = this;
    return navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      },
      video: false
    }).then(function (stream) {
      self.localStream = stream;
      return stream;
    });
  };

  WebRTCHandler.prototype.stopLocalStream = function () {
    if (this.localStream) {
      this.localStream.getTracks().forEach(function (t) { t.stop(); });
      this.localStream = null;
    }
  };

  // 监听端：将远端流绑定到 audio 元素播放
  WebRTCHandler.prototype.bindRemoteToAudio = function (audioEl, stream) {
    if (audioEl.srcObject !== stream) {
      audioEl.srcObject = stream;
    }
    var p = audioEl.play();
    if (p && p.catch) {
      p.catch(function () {
        // 自动播放被拦截，需用户交互后再次播放
      });
    }
  };

  // 监听端：监听远端音频音量（用于可视化）
  WebRTCHandler.prototype.startAudioAnalysis = function (stream, onLevel) {
    var self = this;
    try {
      var AudioCtx = window.AudioContext || window.webkitAudioContext;
      this._audioCtx = new AudioCtx();
      var source = this._audioCtx.createMediaStreamSource(stream);
      this._analyser = this._audioCtx.createAnalyser();
      this._analyser.fftSize = 256;
      source.connect(this._analyser);
      var data = new Uint8Array(this._analyser.frequencyBinCount);

      function tick() {
        if (!self._analyser) return;
        self._analyser.getByteFrequencyData(data);
        var sum = 0;
        for (var i = 0; i < data.length; i++) sum += data[i];
        var avg = sum / data.length;
        if (onLevel) onLevel(avg);
        self._rafId = requestAnimationFrame(tick);
      }
      tick();
    } catch (e) {
      // 不支持分析时静默
    }
  };

  WebRTCHandler.prototype.stopAudioAnalysis = function () {
    if (this._rafId) cancelAnimationFrame(this._rafId);
    this._rafId = null;
    if (this._audioCtx) {
      try { this._audioCtx.close(); } catch (e) {}
      this._audioCtx = null;
    }
    this._analyser = null;
  };

  WebRTCHandler.prototype.close = function () {
    this.stopAudioAnalysis();
    this.stopLocalStream();
    if (this.pc) {
      try { this.pc.close(); } catch (e) {}
      this.pc = null;
    }
  };

  global.WebRTCHandler = WebRTCHandler;
})(window);
