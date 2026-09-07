/**
 * 番茄钟核心状态机
 *
 * 状态：idle / running / paused / break / longBreak
 *   idle       未开始（专注阶段起点）
 *   running    专注进行中
 *   paused     暂停（专注或休息都可能）
 *   break      短休息进行中
 *   longBreak  长休息进行中
 *
 * 计时一律用时间戳差值，绝不用 setInterval 累减：
 *   startAt 记录本阶段（或本次恢复）的起点，
 *   remaining = duration - elapsedBefore - (Date.now() - startAt)
 * 安卓 App 退到后台时 WebView 的 JS 会被冻结，定时器可能几分钟才跑一次，
 * 累减法会严重走慢；靠时间戳差值，回到前台立刻就能校准。
 *
 * elapsedBefore 存"本阶段之前已累计跑过的毫秒"，暂停时把这一段固化进去，
 * 恢复时重置 startAt。这样 pause→resume 不会重算总时长。
 */
(function (global) {
  'use strict';

  var Store = global.PomodoroStore;

  var TICK_MS = 250;

  var STATE = {
    IDLE: 'idle',
    RUNNING: 'running',
    PAUSED: 'paused',
    BREAK: 'break',
    LONG_BREAK: 'longBreak'
  };

  // 阶段与状态是两个维度：休息也能暂停，所以单独记 phase
  var PHASE = { FOCUS: 'focus', SHORT: 'short', LONG: 'long' };

  var PHASE_STATE = {};
  PHASE_STATE[PHASE.FOCUS] = STATE.RUNNING;
  PHASE_STATE[PHASE.SHORT] = STATE.BREAK;
  PHASE_STATE[PHASE.LONG] = STATE.LONG_BREAK;

  // ---- 运行时 ----
  var settings = Store.loadSettings();
  var phase = PHASE.FOCUS;
  var state = STATE.IDLE;
  var startAt = 0;          // 本次运行段的起点时间戳
  var elapsedBefore = 0;    // 本阶段此前已累计的毫秒（暂停固化）
  var doneInRound = 0;      // 本轮已完成的专注数
  // 每任务专注时长覆盖（分钟）。0 = 跟随全局 focusMin。
  // 由 UI 依据当前选中任务维护；持久化到 state，杀进程恢复后依然生效。
  var focusOverride = 0;
  var tickHandle = null;
  var lastEmittedSec = -1;
  var lastPersistAt = 0;

  // 运行中定期落盘的间隔。localStorage 是同步 IO，250ms 写一次太浪费；
  // 5 秒一次把"被系统强杀时丢失的进度"限制在 5 秒内，足够精确。
  var PERSIST_EVERY_MS = 5000;

  var listeners = { tick: [], phaseEnd: [], change: [] };

  // ============================================
  // 工具
  // ============================================
  function effFocusMin() {
    return focusOverride > 0 ? focusOverride : settings.focusMin;
  }

  function phaseDurationMs(p) {
    var min = p === PHASE.FOCUS ? effFocusMin()
            : p === PHASE.SHORT ? settings.shortMin
            : settings.longMin;
    return min * 60 * 1000;
  }

  function isActive() {
    return state === STATE.RUNNING || state === STATE.BREAK || state === STATE.LONG_BREAK;
  }

  function emit(name, payload) {
    var arr = listeners[name];
    if (!arr) return;
    for (var i = 0; i < arr.length; i++) {
      try { arr[i](payload); } catch (e) { /* 单个监听器出错不影响其他 */ }
    }
  }

  /** 当前已跑毫秒 */
  function elapsedMs() {
    return elapsedBefore + (isActive() ? (Date.now() - startAt) : 0);
  }

  function remainingMs() {
    return Math.max(0, phaseDurationMs(phase) - elapsedMs());
  }

  // ============================================
  // 持久化
  // ============================================
  function persist() {
    lastPersistAt = Date.now();
    Store.saveState({
      phase: phase,
      state: state,
      // 存绝对时间戳，恢复时才能算出被冻结/关闭期间过了多久
      startAt: startAt,
      elapsedBefore: elapsedBefore,
      doneInRound: doneInRound,
      focusOverrideMin: focusOverride,
      savedAt: Date.now()
    });
  }

  function restore() {
    var s = Store.loadState();
    if (!s) return;

    if (s.phase === PHASE.FOCUS || s.phase === PHASE.SHORT || s.phase === PHASE.LONG) {
      phase = s.phase;
    }
    doneInRound = Store.clamp(s.doneInRound | 0, 0, settings.roundsBeforeLong);
    focusOverride = Store.clamp(Math.round(Number(s.focusOverrideMin) || 0), 0, 90);

    var before = Math.max(0, Number(s.elapsedBefore) || 0);

    // 刷新 / 冷启动一律恢复到暂停态：
    // 不自动继续跑，避免关掉 app 一整天回来发现番茄"自己跑完了"。
    if (s.state === STATE.RUNNING || s.state === STATE.BREAK || s.state === STATE.LONG_BREAK) {
      // 把关闭前那一段运行时间也算进去，保证剩余时间连续
      var ran = (s.startAt ? Math.max(0, (Number(s.savedAt) || Date.now()) - s.startAt) : 0);
      before += ran;
    }

    elapsedBefore = Math.min(before, phaseDurationMs(phase));
    state = (elapsedBefore > 0) ? STATE.PAUSED : STATE.IDLE;
    startAt = 0;
  }

  // ============================================
  // 阶段推进
  // ============================================
  /**
   * 推进到下一阶段。
   * @param {boolean} count 是否计入完成记录（自然跑完计，手动跳过不计）
   */
  function advance(count) {
    var finished = phase;
    // 记录口径要真实：该番茄实际跑了多久（可能被任务自定义时长覆盖），
    // 而不是设置里的全局值，否则统计里的"专注分钟"会记错。
    var focusMin = (finished === PHASE.FOCUS) ? effFocusMin() : settings.focusMin;

    if (finished === PHASE.FOCUS) {
      doneInRound++;
      phase = (doneInRound >= settings.roundsBeforeLong) ? PHASE.LONG : PHASE.SHORT;
    } else {
      // 长休息结束代表新一轮开始
      if (finished === PHASE.LONG) doneInRound = 0;
      phase = PHASE.FOCUS;
    }

    elapsedBefore = 0;
    startAt = 0;
    lastEmittedSec = -1;

    return { finished: finished, next: phase, counted: !!count, focusMin: focusMin };
  }

  // ============================================
  // 主循环：250ms 一跳，只读时间戳
  // ============================================
  function stopTick() {
    if (tickHandle !== null) { global.clearInterval(tickHandle); tickHandle = null; }
  }

  function startTick() {
    stopTick();
    // setInterval 只用来"定期检查"，剩余时间始终由时间戳算，
    // 所以间隔漂移不会造成计时误差
    tickHandle = global.setInterval(onTick, TICK_MS);
  }

  function onTick() {
    if (!isActive()) { stopTick(); return; }

    if (remainingMs() <= 0) {
      completeCurrentPhase();
      return;
    }

    // 运行中定期刷新落盘的 savedAt。
    // 不刷的话，一旦 App 被系统直接强杀（没走 pause），
    // 恢复时只能拿到 start 那一刻的 savedAt，本次跑过的时间就全丢了。
    if (Date.now() - lastPersistAt >= PERSIST_EVERY_MS) persist();

    var sec = Math.ceil(remainingMs() / 1000);
    if (sec !== lastEmittedSec) {
      lastEmittedSec = sec;
      emit('tick', snapshot());
    }
  }

  /** 当前阶段自然跑完 */
  function completeCurrentPhase() {
    var wasFocus = (phase === PHASE.FOCUS);
    var info = advance(true);

    // 跑完就停下，等用户决定是否进入下一阶段。
    // 不自动开始的理由：休息该不该马上开始由人决定，
    // 而且自动连跑会让后台通知调度变得不可预测。
    state = STATE.IDLE;
    stopTick();
    persist();

    info.wasFocus = wasFocus;
    emit('phaseEnd', info);
    emit('change', snapshot());
  }

  // ============================================
  // 快照
  // ============================================
  function snapshot() {
    var total = phaseDurationMs(phase);
    var remain = remainingMs();
    return {
      phase: phase,
      state: state,
      isFocus: phase === PHASE.FOCUS,
      isRest: phase !== PHASE.FOCUS,
      running: isActive(),
      paused: state === STATE.PAUSED,
      idle: state === STATE.IDLE,
      remainMs: remain,
      remainSec: Math.ceil(remain / 1000),
      totalMs: total,
      elapsedMs: elapsedMs(),
      progress: total > 0 ? Store.clamp(1 - remain / total, 0, 1) : 0,
      doneInRound: doneInRound,
      roundsBeforeLong: settings.roundsBeforeLong,
      settings: Object.assign({}, settings),
      /** 本阶段预计结束的绝对时间戳，用于调度原生通知 */
      endsAt: isActive() ? (Date.now() + remain) : 0
    };
  }

  // ============================================
  // 公开 API
  // ============================================
  var API = {
    STATE: STATE,
    PHASE: PHASE,
    TICK_MS: TICK_MS,

    init: function () {
      restore();
      emit('change', snapshot());
      return snapshot();
    },

    start: function () {
      if (isActive()) return;
      if (remainingMs() <= 0) elapsedBefore = 0;   // 已跑完则从头开始
      startAt = Date.now();
      state = PHASE_STATE[phase];
      lastEmittedSec = -1;
      persist();
      startTick();
      emit('change', snapshot());
    },

    pause: function () {
      if (!isActive()) return;
      // 把已跑的这一段固化进 elapsedBefore，总时长不变
      elapsedBefore = Math.min(elapsedMs(), phaseDurationMs(phase));
      startAt = 0;
      state = STATE.PAUSED;
      stopTick();
      persist();
      emit('change', snapshot());
    },

    toggle: function () { isActive() ? API.pause() : API.start(); },

    /** 重置当前阶段回满，不动完成记录 */
    reset: function () {
      elapsedBefore = 0;
      startAt = 0;
      state = STATE.IDLE;
      lastEmittedSec = -1;
      stopTick();
      persist();
      emit('change', snapshot());
    },

    /** 手动跳过：推进阶段，不计入完成记录 */
    skip: function () {
      var wasActive = isActive();
      stopTick();
      var info = advance(false);
      state = STATE.IDLE;
      persist();
      emit('phaseEnd', info);
      emit('change', snapshot());
      if (wasActive) API.start();
    },

    /**
     * 从后台恢复 / 页面可见时调用。
     * 剩余时间本来就是算出来的，这里只需检查是否已经跑过结束点。
     */
    resync: function () {
      if (isActive()) {
        if (remainingMs() <= 0) { completeCurrentPhase(); return; }
        startTick();
        lastEmittedSec = -1;
      }
      emit('change', snapshot());
    },

    setSetting: function (key, value) {
      if (!(key in settings)) return;

      if (Store.LIMITS[key]) {
        value = Store.clamp(Math.round(Number(value)), Store.LIMITS[key][0], Store.LIMITS[key][1]);
      }
      if (settings[key] === value) return;
      settings[key] = value;
      Store.saveSettings(settings);

      // 改的是当前阶段时长且未在跑：同步刷新显示。
      // 正在跑时不动，等下一阶段生效，避免把已跑的时间抹掉。
      var affects = (key === 'focusMin' && phase === PHASE.FOCUS && focusOverride === 0)
                 || (key === 'shortMin' && phase === PHASE.SHORT)
                 || (key === 'longMin' && phase === PHASE.LONG);
      if (affects && !isActive() && elapsedBefore === 0) lastEmittedSec = -1;

      persist();
      emit('change', snapshot());
    },

    /**
     * 设置专注时长覆盖（分钟），0 = 跟随全局 focusMin。
     * UI 在选中/修改任务时调用；正在跑的阶段不受影响，下一阶段生效，
     * 只有"闲置且没跑过"时立刻反映到表盘。
     */
    setFocusOverride: function (minutes) {
      var v = Store.clamp(Math.round(Number(minutes) || 0), 0, 90);
      if (focusOverride === v) return;
      focusOverride = v;
      persist();
      if (phase === PHASE.FOCUS && !isActive() && elapsedBefore === 0) lastEmittedSec = -1;
      emit('change', snapshot());
    },

    getFocusOverride: function () { return focusOverride; },

    getSettings: function () { return Object.assign({}, settings); },
    get: snapshot,

    on: function (name, fn) {
      if (listeners[name] && typeof fn === 'function') listeners[name].push(fn);
    }
  };

  global.PomodoroTimer = API;
})(window);
