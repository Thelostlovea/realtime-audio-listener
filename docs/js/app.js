/* global Vue, SignalingClient, WebRTCHandler */
/* eslint-disable no-new */

(function () {
  'use strict';

  // ====== 部署配置 ======
  // 使用 ntfy.sh 免费公共信令服务，无需自建后端服务器
  // 信令通道通过 WebSocket 订阅 + HTTP POST 发布实现

  new Vue({
    el: '#app',
    data: {
      // 角色与连接状态
      role: null,              // null | 'listen' | 'send'
      roomId: null,            // 已确认的房间号
      roomIdInput: '',         // 输入中的房间号
      connected: false,        // WebRTC 是否建立
      statusMsg: '',
      volume: 1,
      isAudioPlaying: false,

      // 白噪音播放器伪装界面
      ambiencePlaying: false,
      currentSound: { id: 'rain', name: '雨声', emoji: '🌧️' },
      sounds: [
        { id: 'rain', name: '雨声', emoji: '🌧️' },
        { id: 'ocean', name: '海浪', emoji: '🌊' },
        { id: 'forest', name: '森林', emoji: '🌲' },
        { id: 'fire', name: '篝火', emoji: '🔥' },
        { id: 'wind', name: '微风', emoji: '🍃' }
      ],

      // 内部对象（非响应式用途）
      signaling: null,
      webrtc: null,
      keepAliveAudio: null,
      audioLevelTimer: null
    },

    mounted: function () {
      // 解析 URL 参数，支持 ?role=listen&room=1234 直接进入
      var params = new URLSearchParams(location.search);
      var r = params.get('role');
      var room = params.get('room');
      if (r === 'listen' || r === 'send') {
        this.role = r;
      }
      if (room) {
        this.roomIdInput = room;
      }
      this.setupKeepAlive();
      this.setupMediaSession();
    },

    beforeDestroy: function () {
      this.cleanup();
    },

    methods: {
      // ===== 角色选择 =====
      selectRole: function (r) {
        this.role = r;
      },

      exitRole: function () {
        this.cleanup();
        this.role = null;
        this.roomId = null;
        this.roomIdInput = '';
        this.connected = false;
        this.statusMsg = '';
      },

      // ===== 观看端（A 手机）：创建房间，等待对方 =====
      connectAsListener: function () {
        if (this.roomIdInput.length !== 4) return;
        var self = this;
        this.roomId = this.roomIdInput;
        this.setStatus('正在连接服务器…');

        this.webrtc = new WebRTCHandler();
        this.signaling = new SignalingClient();
        this.signaling.roomId = this.roomId;
        this._bindSignalingListener();

        this.signaling.connect();
      },

      _bindSignalingListener: function () {
        var self = this;

        this.signaling.onOpen = function () {
          self.setStatus('已连接服务器，创建房间…');
          self.signaling.create(self.roomId);
        };

        this.signaling.onCreated = function () {
          self.setStatus('房间 ' + self.roomId + ' 已创建，等待推送端加入…');
        };

        // 推送端加入，开始连接
        this.signaling.onPeerJoined = function () {
          self.setStatus('推送端已加入，正在建立连接…');
          self._startListenerNegotiation();
        };

        this.signaling.onAnswer = function (sdp) {
          if (self.webrtc) {
            self.webrtc.handleAnswer(sdp).catch(function (e) {
              self.setStatus('连接失败：' + (e.message || e));
            });
          }
        };

        this.signaling.onCandidate = function (candidate) {
          if (self.webrtc) self.webrtc.addCandidate(candidate);
        };

        this.signaling.onPeerLeft = function () {
          self.setStatus('连接已断开');
          self.connected = false;
          self.isAudioPlaying = false;
        };

        this.signaling.onError = function (msg) {
          self.setStatus(msg);
        };

        this.signaling.onSignalingError = function (msg) {
          self.setStatus('服务器：' + msg);
        };

        this.signaling.onClose = function () {
          if (self.connected) {
            self.setStatus('连接已断开');
            self.connected = false;
          }
        };
      },

      _startListenerNegotiation: function () {
        var self = this;
        var pc = this.webrtc.createPeer();

        // 连接超时检测
        this._connectTimer = setTimeout(function () {
          if (!self.connected) {
            self.setStatus('连接超时，请检查网络后重试');
            console.warn('[App] 连接超时 - 30秒内未建立连接');
          }
        }, 30000);

        // ICE 候选 → 发给对方
        this.webrtc.onIceCandidate = function (candidate) {
          self.signaling.sendCandidate(candidate);
        };

        // 收到远端流 → 播放
        this.webrtc.onRemoteStream = function (stream) {
          clearTimeout(self._connectTimer);
          var audioEl = self.$refs.remoteAudio;
          self.webrtc.bindRemoteToAudio(audioEl, stream);
          self.isAudioPlaying = true;
          self.connected = true;
          self.setStatus('');
          self.webrtc.startAudioAnalysis(stream, function (level) {
            self.isAudioPlaying = level > 4;
          });
        };

        // 连接状态
        this.webrtc.onStateChange = function (state) {
          console.log('[App] 连接状态变化:', state);
          if (state === 'connected') {
            clearTimeout(self._connectTimer);
            self.connected = true;
          } else if (state === 'failed') {
            clearTimeout(self._connectTimer);
            self.setStatus('连接失败，请重试');
          } else if (state === 'disconnected') {
            self.setStatus('连接中断');
          }
        };

        // 创建 offer 发给推送端
        this.webrtc.createOffer().then(function (sdp) {
          self.setStatus('正在等待推送端响应…');
          self.signaling.sendOffer(sdp);
        }).catch(function (e) {
          self.setStatus('建立连接失败：' + (e.message || e));
        });
      },

      // ===== 推送端（B 手机）：加入房间，开始推送 =====
      connectAsSender: function () {
        if (this.roomIdInput.length !== 4) return;
        var self = this;
        this.roomId = this.roomIdInput;
        this.setStatus('正在初始化…');

        this.webrtc = new WebRTCHandler();

        // 先获取权限（用户点击触发，权限更易通过）
        this.webrtc.startLocalStream().then(function () {
          self.setStatus('初始化完成，连接服务器…');
          self.signaling = new SignalingClient();
          self.signaling.roomId = self.roomId;
          self._bindSignalingSender();
          self.signaling.connect();
        }).catch(function (err) {
          self.setStatus('权限被拒绝：' + (err.message || err));
        });
      },

      _bindSignalingSender: function () {
        var self = this;

        this.signaling.onOpen = function () {
          self.setStatus('加入房间 ' + self.roomId + '…');
          self.signaling.join(self.roomId);
        };

        this.signaling.onJoined = function () {
          self.setStatus('已加入房间，等待观看端…');
        };

        // 收到观看端的连接请求 → 开始推送
        this.signaling.onOffer = function (sdp) {
          self.setStatus('观看端已连接，正在传输…');
          var pc = self.webrtc.createPeer();

          self.webrtc.onIceCandidate = function (candidate) {
            self.signaling.sendCandidate(candidate);
          };

          self.webrtc.onStateChange = function (state) {
            if (state === 'connected') {
              self.connected = true;
              self.setStatus('');
            } else if (state === 'failed' || state === 'disconnected') {
              self.setStatus('传输异常：' + state);
              self.connected = false;
            }
          };

          self.webrtc.handleOffer(sdp).then(function (answerSdp) {
            self.signaling.sendAnswer(answerSdp);
            self.connected = true;
          }).catch(function (e) {
            self.setStatus('建立连接失败：' + (e.message || e));
          });
        };

        this.signaling.onCandidate = function (candidate) {
          if (self.webrtc) self.webrtc.addCandidate(candidate);
        };

        this.signaling.onPeerLeft = function () {
          self.setStatus('观看端已离开');
          self.connected = false;
        };

        this.signaling.onError = function (msg) {
          self.setStatus(msg);
        };

        this.signaling.onSignalingError = function (msg) {
          self.setStatus('服务器：' + msg);
        };
      },

      // ===== 断开 =====
      disconnect: function () {
        this.cleanup();
        this.connected = false;
        this.isAudioPlaying = false;
        this.roomId = null;
        this.setStatus('已断开');
      },

      // ===== 音量 =====
      setVolume: function () {
        if (this.$refs.remoteAudio) {
          this.$refs.remoteAudio.volume = parseFloat(this.volume);
        }
      },

      // ===== 白噪音伪装界面交互（纯视觉） =====
      toggleAmbience: function () {
        this.ambiencePlaying = !this.ambiencePlaying;
      },

      switchSound: function (s) {
        this.currentSound = s;
      },

      // ===== 后台保活 =====
      setupKeepAlive: function () {
        // 持续播放一段静音音频，防止页面被系统挂起
        try {
          var silent = document.createElement('audio');
          silent.loop = true;
          silent.setAttribute('playsinline', '');
          // 极短的静音 wav
          silent.src = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=';
          this.keepAliveAudio = silent;
        } catch (e) {}
      },

      playKeepAlive: function () {
        if (this.keepAliveAudio) {
          var p = this.keepAliveAudio.play();
          if (p && p.catch) p.catch(function () {});
        }
      },

      setupMediaSession: function () {
        // 声明媒体会话，系统视为正在播放媒体，提升后台优先级
        if ('mediaSession' in navigator) {
          navigator.mediaSession.metadata = new MediaMetadata({
            title: '视频号推送中',
            artist: '视频号推送',
            album: '视频号推送'
          });
          navigator.mediaSession.setActionHandler('play', function () {});
          navigator.mediaSession.setActionHandler('pause', function () {});
        }
      },

      // ===== 工具方法 =====
      setStatus: function (msg) {
        this.statusMsg = msg || '';
      },

      cleanup: function () {
        if (this.signaling) {
          this.signaling.close();
          this.signaling = null;
        }
        if (this.webrtc) {
          this.webrtc.close();
          this.webrtc = null;
        }
        this.playKeepAlive(); // 触发一次保活
      }
    }
  });
})();
