/**
 * 全屏翻页时钟
 *
 * 两种模式：
 *   - 计时中：大卡片显示剩余 MM:SS，换位的数字做翻页动画
 *   - 空闲时：显示当前时间 HH:MM，每分钟走字（当床头钟/桌面钟用）
 *
 * 设计约束（为什么这么实现）：
 *   1. 只有 transform/opacity/filter 动画——每秒翻一页的页面最怕重排掉帧
 *   2. 只给"变化的那一位"加动画节点，动画结束立刻移除 DOM；
 *      冒号和秒数静默更新，不翻——整屏每秒都翻会闹
 *   3. prefers-reduced-motion 时直接换字不播动画
 *   4. 进入全屏申请 wakeLock：这屏幕就是拿来看时间的，必须常亮，
 *      与专注计时的 wakeLock 是同一把锁，退出即还
 */
(function (global) {
  'use strict';

  var el = {};
  var root = null;
  var open = false;
  var chromeTimer = null;
  var clockTimer = null;      // 空闲模式的分钟刷新
  var lastChars = [];         // 每个卡片当前显示的字符

  function pad(n) { return n < 10 ? '0' + n : '' + n; }

  // ============================================
  // 卡片渲染
  // ============================================
  /** 构建 count 张卡片的骨架。冒号位置传 -1 表示该位置是冒号不建卡片 */
  function buildStack(spec) {
    // spec 形如 ['m','m',':','s','s']
    el.flipStack.innerHTML = '';
    lastChars = [];
    spec.forEach(function (kind) {
      if (kind === ':') {
        var colon = document.createElement('div');
        colon.className = 'flip-card flip-colon';
        colon.innerHTML = '<div class="flip-digit">:</div>';
        el.flipStack.appendChild(colon);
        lastChars.push(':');
        return;
      }
      var card = document.createElement('div');
      card.className = 'flip-card';
      card.innerHTML =
        '<div class="flip-half top"><div class="flip-digit">0</div></div>'
      + '<div class="flip-half bottom"><div class="flip-digit">0</div></div>';
      el.flipStack.appendChild(card);
      lastChars.push('0');
    });
  }

  /** 把目标字符串铺到各卡片上；与现值不同的位翻页 */
  function setDigits(text) {
    var cards = el.flipStack.querySelectorAll('.flip-card:not(.flip-colon)');
    var ci = 0;
    for (var i = 0; i < text.length && ci < cards.length; i++) {
      if (lastChars[i] === ':') continue;
      var ch = text[i];
      flipCard(cards[ci], ch);
      lastChars[i] = ch;
      ci++;
    }
  }

  /**
   * 单卡翻到新字符。
   * 结构 trick：上下两半各自放整字符、用溢出裁出半张，
   * 所以"下半"永远显示新字的下半即可成立；
   * 动画只克隆上半张做翻转盖板。
   */
  function flipCard(card, ch) {
    var halves = card.querySelectorAll('.flip-half .flip-digit');
    if (!halves.length) return;
    if (halves[0].textContent === ch) return;

    var reduce = global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce || !open) {
      halves[0].textContent = ch;
      halves[1].textContent = ch;
      return;
    }

    // 先更新下层（静止的）两个字面为新值
    halves[0].textContent = ch;
    halves[1].textContent = ch;

    // 克隆旧字的上半张作为翻落盖板
    var oldCh = ch;   // 简化：显示与新字同字盖板翻落（视觉上读作"翻到了这个数"）
    var animHalf = document.createElement('div');
    animHalf.className = 'flip-half top top-new';
    animHalf.style.transformOrigin = 'bottom center';
    animHalf.innerHTML = '<div class="flip-digit">' + oldCh + '</div>';
    card.appendChild(animHalf);

    // 防止连续换位堆积动画节点
    var stale = card.querySelectorAll('.flip-half.top-new:not(:last-child)');
    for (var k = 0; k < stale.length; k++) stale[k].remove();

    animHalf.addEventListener('animationend', function () {
      animHalf.remove();
    });
    // 兜底清理：动画事件在某些 WebView 上偶发丢失
    global.setTimeout(function () { animHalf.remove(); }, 450);
  }

  // ============================================
  // 模式
  // ============================================
  function fmtRemain(sec) {
    sec = Math.max(0, Math.ceil(sec));
    var m = Math.floor(sec / 60), s = sec % 60;
    return pad(m) + ':' + pad(s);
  }

  function renderTimer(snap) {
    var txt = fmtRemain(snap.remainSec);
    var need = txt.replace(':', '').length;
    if (el.flipStack.dataset.mode !== 'timer' ||
        el.flipStack.children.length !== need + 1) {
      el.flipStack.dataset.mode = 'timer';
      buildStack(['d', 'd', ':', 'd', 'd']);
    }
    setDigits(txt);

    var label = snap.isFocus ? '专注' : (snap.phase === 'longBreak' ? '长休息' : '短休息');
    if (el.flipSub.textContent !== label) el.flipSub.textContent = label;
  }

  function renderClock() {
    var d = new Date();
    var txt = pad(d.getHours()) + ':' + pad(d.getMinutes());
    if (el.flipStack.dataset.mode !== 'clock' ||
        el.flipStack.children.length !== 5) {
      el.flipStack.dataset.mode = 'clock';
      buildStack(['d', 'd', ':', 'd', 'd']);
    }
    setDigits(txt);
    el.flipSub.textContent = '';
    var wd = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()];
    el.flipDate.textContent = d.getMonth() + 1 + ' 月 ' + d.getDate() + ' 日 · 周' + wd;
  }

  // ============================================
  // 开关
  // ============================================
  function showChrome() {
    root.classList.add('show-chrome');
    if (chromeTimer) global.clearTimeout(chromeTimer);
    chromeTimer = global.setTimeout(function () {
      root.classList.remove('show-chrome');
    }, 3000);
  }

  var api = {
    isOpen: function () { return open; },

    enter: function () {
      if (open) return;
      open = true;
      el.flipclock.hidden = false;
      global.requestAnimationFrame(function () {
        root.classList.add('open');
      });
      renderClock();          // 先按当前状态画一次
      showChrome();
      el.flipExit.focus();

      // 全屏时钟本身就是要常亮的场景
      var Native = global.PomodoroNative;
      if (Native) Native.acquireWakeLock();

      if (Native) Native.hideStatusBar(true);

      // 分钟跳字驱动（时钟模式）；计时模式下 tick 由外部喂
      clockTimer = global.setInterval(function () {
        if (!global.PomodoroTimer.get().running) renderClock();
      }, 5000);
    },

    leave: function () {
      if (!open) return;
      open = false;
      root.classList.remove('open', 'show-chrome');
      if (clockTimer) { global.clearInterval(clockTimer); clockTimer = null; }
      global.setTimeout(function () { if (!open) el.flipclock.hidden = true; }, 1100);
      var Native = global.PomodoroNative;
      if (Native) {
        Native.hideStatusBar(false);
        // wakeLock 归还给计时器逻辑管理：不在专注中就释放
        var s = global.PomodoroTimer.get();
        if (!(s.running && s.isFocus)) Native.releaseWakeLock();
      }
    },

    toggle: function () { open ? api.leave() : api.enter(); },

    /**
     * 主循环喂帧：计时中的每一拍调它。
     * 不在计时态就自己看表。
     */
    feed: function (snap) {
      if (!open) return;
      if (snap.running || snap.elapsedMs > 0) renderTimer(snap);
      else renderClock();
    },

    bind: function () {
      el.flipclock = document.getElementById('flipclock');
      if (!el.flipclock) return;
      root = el.flipclock;
      ['flipStack', 'flipSub', 'flipDate', 'flipExit'].forEach(function (id) {
        el[id] = document.getElementById(id);
      });
      root.hidden = true;

      // 点屏幕任意处唤起退出钮
      root.addEventListener('click', showChrome);
      el.flipExit.addEventListener('click', function (e) {
        e.stopPropagation();
        api.leave();
      });
    }
  };

  global.PomodoroFlip = api;
})(window);
