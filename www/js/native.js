/**
 * 原生能力桥接：通知 / 震动 / 状态栏 / Back 键 / 防息屏
 *
 * 全部走 Capacitor 插件，不用网页 Notification API。
 * 关键设计：通知在专注【开始】那一刻就按结束时间调度出去，
 * 而不是等结束时再发。因为 App 退到后台 / 锁屏后 WebView 的 JS 会被冻结，
 * 「等结束时再发」那行代码根本不会执行；交给系统 AlarmManager 才准时。
 *
 * 所有方法都做能力检测，在普通浏览器里调用只会静默降级，方便桌面预览。
 */
(function (global) {
  'use strict';

  var Cap = global.Capacitor || null;

  function plugin(name) {
    return (Cap && Cap.Plugins && Cap.Plugins[name]) ? Cap.Plugins[name] : null;
  }

  var isNative = !!(Cap && Cap.isNativePlatform && Cap.isNativePlatform());

  // 固定的通知 id，方便按 id 取消。不同阶段用不同 id，避免互相覆盖。
  var NOTIF_ID = { focus: 8801, rest: 8802 };

  var notifPermission = 'unknown';   // unknown | granted | denied
  var fgsActive = false;             // 常驻服务是否应处于运行中

  var Native = {
    isNative: isNative,
    NOTIF_ID: NOTIF_ID,

    // ============================================
    // 通知
    // ============================================
    /**
     * 申请通知权限。必须在用户手势里调用（首次点"开始"时），
     * 否则安卓 13+ 的系统弹窗不会出现。
     * @returns {Promise<boolean>} 是否拿到权限
     */
    requestNotifyPermission: function () {
      var LN = plugin('LocalNotifications');
      if (!LN || !LN.requestPermissions) {
        notifPermission = 'denied';
        return Promise.resolve(false);
      }
      return LN.requestPermissions()
        .then(function (res) {
          var ok = !!(res && res.display === 'granted');
          notifPermission = ok ? 'granted' : 'denied';
          return ok;
        })
        .catch(function () { notifPermission = 'denied'; return false; });
    },

    notifyPermissionState: function () { return notifPermission; },

    /**
     * 检查系统设置里"闹钟和提醒"（精确闹钟）是否被用户关掉。
     * 官方文档：关掉后 app 重启会删除所有已排的精确闹钟。
     * 持有 USE_EXACT_ALARM 的闹钟类应用通常恒为 enabled，
     * 但部分 ROM 允许用户单独关闭——这是唯一的感知手段。
     * @returns {Promise<'enabled'|'disabled'|'unknown'>}
     */
    checkExactAlarmSetting: function () {
      var LN = plugin('LocalNotifications');
      if (!LN || !LN.checkExactNotificationSetting) return Promise.resolve('unknown');
      return LN.checkExactNotificationSetting()
        .then(function (res) {
          return (res && res.value) ? res.value : (res && res.enabled === true ? 'enabled' : 'unknown');
        })
        .catch(function () { return 'unknown'; });
    },

    /**
     * 查询当前权限状态，不弹窗。
     * 冷启动时用它同步一次，避免已经授权过还把状态当 unknown。
     */
    checkNotifyPermission: function () {
      var LN = plugin('LocalNotifications');
      if (!LN || !LN.checkPermissions) return Promise.resolve(notifPermission);
      return LN.checkPermissions()
        .then(function (res) {
          if (res && res.display === 'granted') notifPermission = 'granted';
          else if (res && res.display === 'denied') notifPermission = 'denied';
          return notifPermission;
        })
        .catch(function () { return notifPermission; });
    },

    /**
     * 按绝对时间调度一条到点提醒。
     *
     * 主路径用 LocalNotifications 插件：它的精确闹钟+通知链路在真机上
     * 完整验证过（锁屏到点、息屏唤醒、通知内容），是可靠性的基准。
     * 自研 PomodoroFgs.scheduleAlert 能多一个「开始下一阶段」按钮，
     * 但验证不充分，只在 FGS 常驻服务已实际运行时作为增强启用——
     * 服务在跑本身就是插件桥健康的证据。
     */
    scheduleAt: function (id, atMs, title, body) {
      // 已经过去的时间点没意义
      if (!(atMs > Date.now() + 500)) return Promise.resolve(false);

      var FG = plugin('PomodoroFgs');
      if (Native.fgsActive() && FG && FG.scheduleAlert) {
        return FG.scheduleAlert({ id: id, atMs: atMs, title: title, body: body })
          .then(function (ok) {
            if (ok === false) return Native._scheduleLN(id, atMs, title, body);
            return true;
          }).catch(function () { return Native._scheduleLN(id, atMs, title, body); });
      }
      return Native._scheduleLN(id, atMs, title, body);
    },

    /** LocalNotifications 主路径（真机验证基准） */
    _scheduleLN: function (id, atMs, title, body) {
      var LN = plugin('LocalNotifications');
      if (!LN || !LN.schedule) return Promise.resolve(false);
      return LN.schedule({
        notifications: [{
          id: id,
          title: title,
          body: body,
          smallIcon: 'ic_stat_icon',
          schedule: { at: new Date(atMs), allowWhileIdle: true }
        }]
      }).then(function () { return true; }).catch(function () { return false; });
    },

    cancel: function (id) {
      var done = [];
      // 两条通道各自幂等取消，id 命名空间一致
      var FG = plugin('PomodoroFgs');
      if (FG && FG.cancelAlert) done.push(FG.cancelAlert({ id: id }).catch(function () {}));
      var LN = plugin('LocalNotifications');
      if (LN && LN.cancel) done.push(LN.cancel({ notifications: [{ id: id }] }).catch(function () {}));
      return Promise.all(done);
    },

    cancelAll: function () {
      // 只撤"备用闹钟"族（8801/8802）。
      // 8803/8804 是阶段结束时补发给用户看的即时通知，
      // 不能在这里撤——phaseEnd 的时序是先 postImmediate 再触发
      // onChange 的 else 分支，宽泛的 cancelAll 会把刚发的通知秒删（实测）。
      return Promise.all([Native.cancel(NOTIF_ID.focus), Native.cancel(NOTIF_ID.rest)]);
    },

    /** 新一轮开始时清掉上一阶段的"XX结束"通知卡片 */
    cancelEndCards: function () {
      return Promise.all([Native.cancel(8803), Native.cancel(8804)]);
    },

    /**
     * 立即发一条通知（不经过闹钟调度）。
     * 用途：FGS 保活时 app 在后台、JS 被节流不冻结，阶段结束由 JS 补发。
     * 优先走自研插件（同一 alerts 渠道），不可用回退 LocalNotifications。
     */
    postImmediate: function (id, title, body) {
      var FG = plugin('PomodoroFgs');
      if (FG && FG.postNow) {
        return FG.postNow({ id: id, title: title, body: body }).catch(function () {});
      }
      var LN = plugin('LocalNotifications');
      if (!LN || !LN.schedule) return Promise.resolve(false);
      return LN.schedule({
        notifications: [{ id: id, title: title, body: body, smallIcon: 'ic_stat_icon' }]
      }).catch(function () {});
    },

    // ============================================
    // 震动
    // ============================================
    /** 按钮按压反馈 */
    impact: function (style) {
      var H = plugin('Haptics');
      if (H && H.impact) {
        H.impact({ style: style || 'MEDIUM' }).catch(function () {});
        return;
      }
      if (global.navigator && global.navigator.vibrate) global.navigator.vibrate(35);
    },

    /** 阶段结束的通知式震动 */
    notificationVibrate: function () {
      var H = plugin('Haptics');
      if (H && H.notification) {
        H.notification({ type: 'SUCCESS' }).catch(function () {
          if (H.impact) H.impact({ style: 'HEAVY' }).catch(function () {});
        });
        return;
      }
      if (global.navigator && global.navigator.vibrate) global.navigator.vibrate([90, 70, 90]);
    },

    // ============================================
    // 状态栏
    // ============================================
    /**
     * 配色锁定为暖米白浅底，所以图标必须是深色。
     * Capacitor 的 Style.Light 表示"浅色背景 + 深色图标"。
     */
    applyStatusBar: function () {
      var SB = plugin('StatusBar');
      if (!SB) return;
      if (SB.setStyle) SB.setStyle({ style: 'LIGHT' }).catch(function () {});
      if (SB.setBackgroundColor) SB.setBackgroundColor({ color: '#f0eee6' }).catch(function () {});
      if (SB.setOverlaysWebView) SB.setOverlaysWebView({ overlay: false }).catch(function () {});
    },

    // ============================================
    // 防息屏
    // ============================================
    _wakeLock: null,

    /** 专注进行中保持亮屏。不支持或被拒都静默降级，绝不抛错。 */
    acquireWakeLock: function () {
      try {
        if (!global.navigator || !global.navigator.wakeLock) return;
        if (Native._wakeLock) return;
        global.navigator.wakeLock.request('screen').then(function (lock) {
          Native._wakeLock = lock;
          lock.addEventListener('release', function () { Native._wakeLock = null; });
        }).catch(function () { /* 静默 */ });
      } catch (e) { /* 静默 */ }
    },

    releaseWakeLock: function () {
      try {
        if (Native._wakeLock && Native._wakeLock.release) {
          Native._wakeLock.release().catch(function () {});
        }
      } catch (e) { /* 静默 */ }
      Native._wakeLock = null;
    },

    hasWakeLock: function () { return !!Native._wakeLock; },

    // ============================================
    // 沉浸式：隐藏状态栏（翻页时钟用）
    // ============================================
    hideStatusBar: function (hide) {
      var SB = plugin('StatusBar');
      if (!SB) return;
      if (hide && SB.hide) SB.hide().catch(function () {});
      if (!hide && SB.show) {
        SB.show().catch(function () {});
        Native.applyStatusBar();
      }
    },

    // ============================================
    // App 生命周期 / Back 键
    // ============================================
    onAppStateChange: function (fn) {
      var App = plugin('App');
      if (App && App.addListener) {
        App.addListener('appStateChange', function (st) { fn(!!(st && st.isActive)); });
      }
    },

    /** @param {function} handler 返回 true 表示已消费该次返回 */
    onBackButton: function (handler) {
      var App = plugin('App');
      if (App && App.addListener) {
        App.addListener('backButton', function () { handler(); });
      }
    },

    exitApp: function () {
      var App = plugin('App');
      if (App && App.exitApp) App.exitApp();
    },

    // ============================================
    // 前台常驻服务（自写原生插件 PomodoroFgs）
    // fgsActive 由 JS 侧跟踪：start/stop 成功调用后置位
    // 目的：专注时进程带前台优先级，系统不会因省电杀掉它，
    // 通知栏同时显示实时倒计时。浏览器/老插件缺失时全部静默降级。
    // ============================================
    fgsAvailable: function () {
      var P = plugin('PomodoroFgs');
      return !!(P && P.start);
    },

    /**
     * 启动常驻通知。totalSec 给通知栏一个初始口径；
     * 后续每秒由 updateFgs 推送真实剩余。
     */
    fgsStart: function () {
      var P = plugin('PomodoroFgs');
      if (!P || !P.start) return false;
      var s = 0;
      try { s = global.PomodoroTimer.get().remainSec; } catch (e) {}
      P.start({ title: '番茄钟', remainSec: s }).catch(function () {});
      fgsActive = true;
      return true;
    },

    fgsUpdate: function (snap) {
      var P = plugin('PomodoroFgs');
      if (!P || !P.update) return;
      // 负数秒 = 加时正计时，服务端按 "+MM:SS" 渲染
      P.update({
        remainSec: snap.overtime ? -Math.ceil(snap.overtimeMs / 1000) : snap.remainSec,
        paused: !snap.running,
        isFocus: snap.isFocus
      }).catch(function () {});
    },

    fgsStop: function () {
      var P = plugin('PomodoroFgs');
      if (P && P.stop) P.stop().catch(function () {});
      fgsActive = false;
    },

    fgsActive: function () { return fgsActive; },

    /** 监听常驻通知上的按钮（暂停/继续/结束） */
    onFgsAction: function (fn) {
      var P = plugin('PomodoroFgs');
      if (P && P.addListener) {
        P.addListener('fgsAction', fn);
      }
    }
  };

  global.PomodoroNative = Native;
})(window);
