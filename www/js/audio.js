/**
 * 提示音：WebAudio 振荡器实时合成，零音频文件
 *
 * 两个关键点：
 *   1. 节奏是「两短一长」，最后一声明显拖长，听感上有"结束了"的收束感。
 *   2. WebView 的自动播放策略要求 AudioContext 必须在用户手势里创建 / resume。
 *      所以点"开始"那一次手势里要调 unlock()，先播一个极短的静音，
 *      否则 25 分钟后阶段结束时的提示音根本不会响。
 *
 * 音色用三角波 + 指数衰减包络，接近木质敲击，比正弦波清晰但不刺耳。
 */
(function (global) {
  'use strict';

  var ctx = null;
  var unlocked = false;

  function ensureCtx() {
    if (ctx) return ctx;
    var AC = global.AudioContext || global.webkitAudioContext;
    if (!AC) return null;
    try { ctx = new AC(); } catch (e) { return null; }
    return ctx;
  }

  /**
   * 敲一下
   * @param {number} freq 频率 Hz
   * @param {number} delay 延迟秒数
   * @param {number} dur 时长秒数
   * @param {number} peak 峰值增益
   */
  function ping(freq, delay, dur, peak) {
    var c = ensureCtx();
    if (!c) return;

    var t0 = c.currentTime + delay;
    var osc = c.createOscillator();
    var gain = c.createGain();

    osc.type = 'triangle';
    osc.frequency.setValueAtTime(freq, t0);

    // 快起慢落。从 0 直接跳到峰值会有 click 爆音，所以从极小值指数上升
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(peak, t0 + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

    osc.connect(gain);
    gain.connect(c.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  var API = {
    /** 供 noise.js 共用同一个 context（一个页面只该有一个） */
    ctx: function () { return ensureCtx(); },

    /**
     * 必须在用户手势内调用一次。播一个 20ms 的极低音量音，
     * 目的只是让 AudioContext 进入 running 状态。
     */
    unlock: function () {
      var c = ensureCtx();
      if (!c) return false;
      if (c.state === 'suspended' && c.resume) c.resume().catch(function () {});
      if (!unlocked) {
        unlocked = true;
        // 近乎无声，用户听不见，但足以解锁音频管道
        ping(440, 0, 0.02, 0.0008);
      }
      return true;
    },

    isUnlocked: function () { return unlocked; },

    /** 两短一长。专注结束用较高音高，收束在上行 */
    focusEnd: function () {
      ping(784, 0.00, 0.16, 0.20);   // 短
      ping(784, 0.20, 0.16, 0.20);   // 短
      ping(1047, 0.42, 0.85, 0.24);  // 长
    },

    /** 两短一长。休息结束音高下行，催促回到专注 */
    restEnd: function () {
      ping(660, 0.00, 0.16, 0.20);   // 短
      ping(660, 0.20, 0.16, 0.20);   // 短
      ping(495, 0.42, 0.85, 0.24);   // 长
    },

    /** 设置里打开声音时的试听 */
    preview: function () { API.focusEnd(); }
  };

  global.PomodoroAudio = API;
})(window);
