/**
 * 白噪音：WebAudio 全程合成，零音频文件
 *
 * 为什么合成而不是放 mp3：
 *   雨声/咖啡馆的本质就是"有纹理的噪声"，一个滤波噪声源就能做出七成质感，
 *   而一段 30 分钟循环 mp3 要 3~8 MB 还能听出接缝。apk 不增重，也不怕循环点。
 *
 * 三种纹理：
 *   rain  — 粉噪过高通+低通，LFO 微调低通频率模拟雨势起伏
 *   cafe  — 棕噪低通做房间底噪 + 带通卡语频段慢扫，像隔壁桌在聊
 *
 * 与 audio.js 共用同一个 AudioContext（优先借用），解锁是同一次手势。
 * stop 时先淡出再停源——直接停会有"咔"的爆音。
 */
(function (global) {
  'use strict';

  var ctx = null;
  var playing = null;     // { kind, master, sources[], cleanupAt }

  function ownCtx() {
    if (ctx) return ctx;
    var AC = global.AudioContext || global.webkitAudioContext;
    if (!AC) return null;
    try { ctx = new AC(); } catch (e) { return null; }
    return ctx;
  }

  function sharedCtx() {
    var A = global.PomodoroAudio;
    if (A && typeof A.ctx === 'function') return A.ctx();
    return ownCtx();
  }

  /** 随机填满 AudioBuffer */
  function noiseBuffer(c, kind) {
    var sec = 2;
    var buf = c.createBuffer(1, c.sampleRate * sec, c.sampleRate);
    var d = buf.getChannelData(0);
    var last = 0;
    for (var i = 0; i < d.length; i++) {
      var w = Math.random() * 2 - 1;
      if (kind === 'brown') {
        last = (last + 0.02 * w) / 1.02;      // 积分 → 低频能量
        d[i] = last * 3.5;
      } else {
        last = 0.85 * last + 0.15 * w;         // 一阶低通 → 软化的粉噪
        d[i] = last * 1.6;
      }
    }
    return buf;
  }

  function src(c, buf) {
    var s = c.createBufferSource();
    s.buffer = buf;
    s.loop = true;
    s.start();
    return s;
  }

  function lfo(c, hz, depth, param) {
    var o = c.createOscillator();
    o.frequency.value = hz;
    var g = c.createGain();
    g.gain.value = depth;
    o.connect(g); g.connect(param);
    o.start();
    return [o, g];
  }

  function build(kind, c, out) {
    var sources = [];
    var B = noiseBuffer.bind(null, c);

    if (kind === 'cafe') {
      var master = c.createGain(); master.gain.value = 0.24;

      var room = c.createBiquadFilter();
      room.type = 'lowpass'; room.frequency.value = 480;
      var s1 = src(c, B('brown')); s1.connect(room); room.connect(master); sources.push(s1);

      // 语频嗡嗡：带通 + 双 LFO 缓扫
      var voice = c.createBiquadFilter();
      voice.type = 'bandpass'; voice.Q.value = 1.6; voice.frequency.value = 420;
      var vg = c.createGain(); vg.gain.value = 0.3;
      var s2 = src(c, B('pink')); s2.connect(voice); voice.connect(vg); vg.connect(master); sources.push(s2);

      sources.push.apply(sources, lfo(c, 0.05, 140, voice.frequency));
      sources.push.apply(sources, lfo(c, 0.11, 0.07, vg.gain));

      master.connect(out);
      return { master: master, sources: sources };
    }

    // rain（默认）
    var m = c.createGain(); m.gain.value = 0.15;
    var hp = c.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 450;
    var lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 6500; lp.Q.value = 0.4;
    var s = src(c, B('pink')); s.connect(hp); hp.connect(lp); lp.connect(m); m.connect(out); sources.push(s);

    sources.push.apply(sources, lfo(c, 0.07, 900, lp.frequency));

    m.connect(out);
    return { master: m, sources: sources };
  }

  var API = {
    current: function () { return playing ? playing.kind : null; },

    start: function (kind) {
      if (!kind || kind === 'off') { API.stop(); return false; }
      if (playing && playing.kind === kind) return true;

      API.stop();
      var c = sharedCtx();
      if (!c) return false;
      if (c.state === 'suspended' && c.resume) c.resume().catch(function () {});

      var fade = c.createGain();
      fade.gain.value = 0.0001;
      fade.connect(c.destination);

      var built = build(kind, c, fade);

      try {
        fade.gain.cancelScheduledValues(c.currentTime);
        fade.gain.setValueAtTime(0.0001, c.currentTime);
        fade.gain.linearRampToValueAtTime(1, c.currentTime + 1.6);   // 淡入免突兀
      } catch (e) {}

      playing = { kind: kind, fade: fade, sources: built.sources };
      return true;
    },

    stop: function () {
      if (!playing) return;
      var p = playing;
      playing = null;

      var now = sharedCtx() ? sharedCtx().currentTime : 0;
      try {
        p.fade.gain.cancelScheduledValues(now);
        p.fade.gain.setValueAtTime(p.fade.gain.value || 0.0001, now);
        p.fade.gain.linearRampToValueAtTime(0.0001, now + 0.7);
      } catch (e) {}

      // 淡出完成后再停源并拆节点，否则会咔一声
      global.setTimeout(function () {
        p.sources.forEach(function (s) {
          try { s.stop(); } catch (e) {}
          try { s.disconnect(); } catch (e) {}
        });
        try { p.fade.disconnect(); } catch (e) {}
      }, 800);
    }
  };

  global.PomodoroNoise = API;
})(window);
