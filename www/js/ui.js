/**
 * UI 层：渲染 + 交互 + 原生能力编排
 *
 * 分工：
 *   timer.js   只管时间与状态，不碰 DOM
 *   store.js   只管 localStorage
 *   native.js  只管 Capacitor 插件
 *   本文件     把状态画出来，把用户操作翻译成调用
 *
 * 通知调度策略（安卓核心）：
 *   开始 → 立刻按预计结束时间 schedule 一条原生通知
 *   暂停 / 重置 / 跳过 / 阶段结束 → 按 id cancel
 * 这样即使 App 被冻结在后台，系统也会准时弹通知。
 */
(function (global) {
  'use strict';

  var T = global.PomodoroTimer;
  var Store = global.PomodoroStore;
  var Sound = global.PomodoroAudio;
  var Native = global.PomodoroNative;
  var Charts = global.PomodoroCharts;
  var DataLink = global.PomodoroDataLink;
  var Flip = global.PomodoroFlip;
  var Noise = global.PomodoroNoise;

  var PHASE_TEXT = { focus: '专注', short: '短休息', long: '长休息' };

  var el = {};
  var circumference = 0;
  var lastPhase = null;
  var pressTimer = null;
  var repeatTimer = null;
  var chartBuilt = false;
  var askedNotifyPermission = false;

  var tasks = { list: [], activeId: null };
  var archiveOpen = false;

  // ============================================
  // 小工具
  // ============================================
  function fmt(ms) {
    var total = Math.max(0, Math.ceil(ms / 1000));
    var m = Math.floor(total / 60);
    var s = total % 60;
    return (m < 10 ? '0' + m : m) + ':' + (s < 10 ? '0' + s : s);
  }

  function activeTask() {
    if (!tasks.activeId) return null;
    for (var i = 0; i < tasks.list.length; i++) {
      if (tasks.list[i].id === tasks.activeId) return tasks.list[i];
    }
    return null;
  }

  function activeTaskName() {
    var t = activeTask();
    return t ? t.title : '自由专注';
  }

  var toastTimer = null;
  function toast(msg, ms) {
    el.toast.textContent = msg;
    el.toast.hidden = false;
    global.requestAnimationFrame(function () { el.toast.classList.add('show'); });
    if (toastTimer) global.clearTimeout(toastTimer);
    toastTimer = global.setTimeout(function () {
      el.toast.classList.remove('show');
      global.setTimeout(function () { el.toast.hidden = true; }, 300);
    }, ms || 1800);
  }

  /** 带变化感知的数字写入：变了才写，并给一个轻微的 bump 动画 */
  function setNum(node, v) {
    var str = String(v);
    if (node.textContent === str) return;
    node.textContent = str;
    node.classList.remove('bump');
    void node.offsetWidth;      // 强制回流，让同一个动画能重新触发
    node.classList.add('bump');
  }

  // ============================================
  // 通知调度
  // ============================================
  // 权限申请是否正在进行中。
  // LocalNotifications.schedule() 自己也会触发系统权限弹窗，
  // 如果它和显式的 requestPermissions() 同时发起，会叠出两个弹窗，
  // 而且第一个 promise 会因为被第二个顶掉而立刻以"拒绝"返回。
  // 所以申请期间必须挡住所有调度，等结果出来再补一次。
  var permissionPending = false;

  function scheduleEndNotification(snap) {
    if (!snap.settings.notify) return;
    if (!snap.running || !snap.endsAt) return;
    // 加时态没有"到点"可言，不再调度
    if (snap.overtime) return;
    if (permissionPending) return;
    // 明确被拒后不再尝试调度，免得每次开始都弹一次系统弹窗
    if (Native.notifyPermissionState() === 'denied') return;

    var isFocus = snap.isFocus;
    var id = isFocus ? Native.NOTIF_ID.focus : Native.NOTIF_ID.rest;
    var title = isFocus ? '专注结束' : '休息结束';
    var body = isFocus ? '休息一下吧' : '回到专注，继续下一个番茄';

    // 先取消同 id 的旧调度，避免改时长后残留一条错误时间的通知
    Native.cancel(id).then(function () {
      Native.scheduleAt(id, snap.endsAt, title, body);
    });
  }

  function cancelEndNotifications() {
    Native.cancelAll();
  }

  // ============================================
  // 渲染：主界面
  // ============================================
  function renderMain(s) {
    // 加时正计时：表盘显示 "+MM:SS"，超出部分也在计入专注
    if (s.overtime) {
      el.timeDisplay.textContent = '+' + fmt(s.overtimeMs);
      el.phaseLabel.textContent = '加时专注';
      el.timeDisplay.classList.add('overtime');
    } else {
      el.timeDisplay.textContent = fmt(s.remainMs);
      el.phaseLabel.textContent = PHASE_TEXT[s.phase] || '专注';
      el.timeDisplay.classList.remove('overtime');
    }

    // 进度环只动 stroke-dashoffset
    el.dialFill.style.strokeDashoffset = String(circumference * (1 - s.progress));

    el.startBtn.textContent = s.running ? '暂停' : (s.elapsedMs > 0 ? '继续' : '开始');

    if (s.running) {
      el.hintLabel.textContent = s.overtime ? '超出时间也在计入'
                              : (s.isFocus ? '保持专注' : '放松一下');
    } else if (s.elapsedMs > 0) {
      el.hintLabel.textContent = s.overtime ? '加时已暂停' : '已暂停';
    } else {
      el.hintLabel.textContent = s.isFocus ? '准备开始' : '该休息了';
    }

    el.resetBtn.disabled = (!s.running && s.elapsedMs === 0);

    // 休息态整体换低饱和青灰，与专注的陶土橙区分
    document.body.classList.toggle('is-rest', s.isRest);

    // 轮次点
    if (el.roundDots.children.length !== s.roundsBeforeLong) {
      var html = '';
      for (var j = 0; j < s.roundsBeforeLong; j++) html += '<i></i>';
      el.roundDots.innerHTML = html;
    }
    for (var i = 0; i < el.roundDots.children.length; i++) {
      var dot = el.roundDots.children[i];
      dot.className = i < s.doneInRound ? 'done'
                    : (i === s.doneInRound && s.isFocus) ? 'current'
                    : '';
    }

    el.activeTaskLabel.textContent = activeTaskName();

    var rec = Store.todayRecord();
    setNum(el.todayCount, rec.count);

    // 设置回显
    el.focusMin.textContent = String(s.settings.focusMin);
    el.shortMin.textContent = String(s.settings.shortMin);
    el.longMin.textContent = String(s.settings.longMin);
    el.soundToggle.checked = s.settings.sound;
    el.vibrateToggle.checked = s.settings.vibrate;
    el.notifyToggle.checked = s.settings.notify;
    el.noiseSelect.value = s.settings.noise;
    el.fgsToggle.checked = s.settings.fgs;

    // 防息屏：只在专注进行中持有；全屏翻页时钟打开时无条件常亮
    if ((s.running && s.isFocus) || (Flip && Flip.isOpen())) Native.acquireWakeLock();
    else Native.releaseWakeLock();

    // 白噪音只伴随专注进行
    if (Noise) {
      if (s.running && s.isFocus && s.settings.noise !== 'off') Noise.start(s.settings.noise);
      else Noise.stop();
    }

    // 阶段变化播报给读屏
    if (s.phase !== lastPhase) {
      lastPhase = s.phase;
      el.srStatus.textContent = PHASE_TEXT[s.phase] + '阶段，' + fmt(s.remainMs);
      document.title = PHASE_TEXT[s.phase] + ' · 番茄钟';
    }

    // 全屏时钟跟着吃同一份快照（未打开时内部直接返回）
    if (Flip) Flip.feed(s);
  }

  /**
   * 把当前任务的专注时长同步给计时器。
   * 任务设了 focusMin 就覆盖全局，没设（0）就跟随全局。
   * 值没变时 setFocusOverride 内部直接返回，不会造成事件循环。
   */
  function applyFocusOverride() {
    var t = activeTask();
    var want = (t && t.focusMin > 0) ? t.focusMin : 0;
    if (T.getFocusOverride() !== want) T.setFocusOverride(want);
  }

  function onChange(s) {
    applyFocusOverride();
    renderMain(s);
    // 状态变化时同步通知调度
    if (s.running) scheduleEndNotification(s);
    else cancelEndNotifications();

    // 前台常驻服务生命周期：开跑时拉起，暂停/结束时收起
    if (Native.fgsAvailable && Native.fgsAvailable()) {
      if (s.settings.fgs && s.running) {
        if (!fgsUp) { Native.fgsStart(); fgsUp = true; }
        Native.fgsUpdate(s);
      } else if (fgsUp) {
        Native.fgsStop();
        fgsUp = false;
      }
    }
  }

  var fgsUp = false;

  // ============================================
  // 渲染：统计
  // ============================================
  // 图表切换器状态：默认 30 天趋势。范围对五种图统一生效。
  var currentChart = 'trend';
  var chartRange = 30;
  var CHART_RANGE_MAX = 90;

  function renderStats() {
    var rec = Store.todayRecord();
    var ins = Store.insights();

    setNum(el.statToday, rec.count);
    setNum(el.statMinutes, rec.minutes);
    setNum(el.statStreak, ins.streak);

    // 今日目标环
    el.goalRingBox.innerHTML = Charts.goalRing(ins.goalProgress, ins.todayCount, ins.dailyGoal);
    if (ins.goalMet) {
      el.goalTitle.textContent = '目标已达成';
      el.goalDesc.textContent = '今天完成 ' + ins.todayCount + ' 个，超出目标 '
                              + (ins.todayCount - ins.dailyGoal) + ' 个';
    } else {
      el.goalTitle.textContent = '今日目标';
      var left = ins.dailyGoal - ins.todayCount;
      el.goalDesc.textContent = ins.todayCount === 0
        ? ('还没开始，目标 ' + ins.dailyGoal + ' 个')
        : ('还差 ' + left + ' 个');
    }
    el.goalStreak.textContent = ins.streak > 0 ? ('已连续专注 ' + ins.streak + ' 天') : '';

    // 本周柱状图
    renderWeekChart();
    // 图表切换器 + 最近记录
    renderMainChart();
    renderRecent();
    renderInsights(ins);
  }

  /** 图表切换器当前选中的那张图 */
  function renderMainChart() {
    var box = el.mainChart;
    var note = el.chartNote;
    var d = chartRange;

    if (currentChart === 'trend') {
      box.innerHTML = Charts.trendLine(Store.daySeries(d), T.getSettings().dailyGoal);
      note.textContent = '每天的完成数，虚线是每日目标';
    } else if (currentChart === 'donut') {
      box.innerHTML = Charts.donut(Store.taskBreakdown(d));
      note.textContent = d + ' 天里各任务占的比重';
    } else if (currentChart === 'rank') {
      box.innerHTML = Charts.taskBars(Store.taskBreakdown(d), 8);
      note.textContent = d + ' 天里完成任务数最多的排在前面';
    } else if (currentChart === 'hours') {
      box.innerHTML = Charts.hourHeatmap(Store.hourHistogram(d));
      note.textContent = '一天里哪个时段最能专注';
    } else {
      box.innerHTML = Charts.weekdayBars(Store.weekdayHistogram(d));
      note.textContent = '周几效率最高，一目了然';
    }
  }

  function bindChartTabs() {
    function onPick(e) {
      var chip = e.target.closest('[data-chart],[data-range]');
      if (!chip) return;

      if (chip.hasAttribute('data-chart')) {
        currentChart = chip.getAttribute('data-chart');
        var chips = el.chartTabs.querySelectorAll('.chip');
        for (var i = 0; i < chips.length; i++) {
          var on = chips[i] === chip;
          chips[i].classList.toggle('active', on);
          chips[i].setAttribute('aria-selected', on ? 'true' : 'false');
        }
      } else {
        chartRange = Store.clamp(parseInt(chip.getAttribute('data-range'), 10) || 30, 7, CHART_RANGE_MAX);
        var ranges = el.rangeTabs.querySelectorAll('.chip');
        for (var k = 0; k < ranges.length; k++) {
          var on2 = ranges[k] === chip;
          ranges[k].classList.toggle('active', on2);
          ranges[k].setAttribute('aria-selected', on2 ? 'true' : 'false');
        }
      }
      renderMainChart();
      pressFeedback();
    }
    el.chartTabs.addEventListener('click', onPick);
    el.rangeTabs.addEventListener('click', onPick);
  }

  /** 最近记录：每一条完成的专注都可见，统计页才"活着" */
  function renderRecent() {
    var list = Store.recentSessions(8);
    if (!list.length) {
      el.recentList.innerHTML = '<li class="empty-tip">完成的番茄会出现在这里</li>';
      return;
    }
    el.recentList.innerHTML = list.map(function (s) {
      var t = new Date(s.at);
      var hh = t.getHours() < 10 ? '0' + t.getHours() : String(t.getHours());
      var mm = t.getMinutes() < 10 ? '0' + t.getMinutes() : String(t.getMinutes());
      return '<li><span class="detail-time">' + hh + ':' + mm + '</span>'
           + '<span class="detail-name"></span>'
           + '<b>' + s.min + ' 分</b></li>';
    }).join('');
    // 任务名走 textContent，防注入
    var names = el.recentList.querySelectorAll('.detail-name');
    for (var i = 0; i < names.length; i++) names[i].textContent = list[i].task;
  }

  /** 文字洞察：把数字翻成结论 */
  function renderInsights(ins) {
    var items = [];

    if (ins.bestHour !== null) {
      items.push('你在 <b>' + ins.bestHour + ':00–' + (ins.bestHour + 1)
               + ':00</b> 最能专注，近 30 天在这个时段完成了 ' + ins.bestHourCount + ' 个番茄');
    }
    if (ins.activeDays > 0) {
      items.push('累计 <b>' + ins.totalCount + '</b> 个番茄，'
               + Math.round(ins.totalMinutes / 60 * 10) / 10 + ' 小时，跨 '
               + ins.activeDays + ' 个活跃日');
      items.push('活跃日均 <b>' + ins.avgPerActiveDay + '</b> 个，近 7 天日均 '
               + ins.avgLast7 + ' 个');
      items.push('目标达成率 <b>' + ins.goalMetRate + '%</b>（'
               + ins.goalMetDays + '/' + ins.activeDays + ' 天）');
    }
    if (!items.length) items.push('完成第一个番茄后这里会出现分析');

    el.insightList.innerHTML = items.map(function (t) {
      return '<li>' + t + '</li>';
    }).join('');
  }

  function renderWeekChart() {

    // 本周柱状图：7 根细柱，只动 transform: scaleY
    var series = Store.weekSeries();
    var max = 1;
    series.forEach(function (d) { if (d.count > max) max = d.count; });

    if (!chartBuilt || el.weekChart.children.length !== 7) {
      el.weekChart.innerHTML = series.map(function (d) {
        return '<div class="bar-col">'
             + '<div class="bar-track"><div class="bar-fill"></div></div>'
             + '<span class="bar-label">' + d.label + '</span>'
             + '</div>';
      }).join('');
      chartBuilt = true;
    }

    for (var i = 0; i < 7; i++) {
      var col = el.weekChart.children[i];
      var d = series[i];
      var fill = col.querySelector('.bar-fill');
      fill.style.transform = 'scaleY(' + (d.count / max) + ')';
      col.classList.toggle('is-today', d.isToday);
      col.classList.toggle('is-empty', d.count === 0);
      col.setAttribute('title', d.label + '：' + d.count + ' 个番茄');
    }
    el.weekChart.setAttribute('aria-label',
      '本周番茄：' + series.map(function (d) { return d.label + d.count + '个'; }).join('，'));
  }

  // ============================================
  // 渲染：任务列表
  // ============================================
  var PRIO_LABEL = { high: '高', normal: '', low: '低' };

  /** 未归档任务，按 优先级 → 未完成优先 → 创建时间 排序 */
  function sortedActive() {
    var order = { high: 0, normal: 1, low: 2 };
    return tasks.list.filter(function (t) { return !t.archived; })
      .slice()
      .sort(function (a, b) {
        if (a.done !== b.done) return a.done ? 1 : -1;
        var d = order[a.priority] - order[b.priority];
        if (d !== 0) return d;
        return a.createdAt - b.createdAt;
      });
  }

  // 当前展开编辑器的任务 id（一次只展开一个）
  var expandedTaskId = null;

  function taskItemHTML(t) {
    var isActive = (t.id === tasks.activeId);
    var cls = 'task-item'
            + (t.done ? ' done' : '')
            + (isActive ? ' active' : '')
            + (t.priority === 'high' ? ' prio-high' : '')
            + (t.priority === 'low' ? ' prio-low' : '');

    var meta = [];
    if (t.pomodoros > 0 || t.estimate > 0) {
      meta.push(t.pomodoros + (t.estimate > 0 ? ' / ' + t.estimate : ''));
    }
    if (t.focusMin > 0) meta.push(t.focusMin + ' 分');
    if (PRIO_LABEL[t.priority]) meta.push(PRIO_LABEL[t.priority]);

    var editing = (expandedTaskId === t.id);

    return '<li class="' + cls + (editing ? ' editing' : '') + '" data-id="' + Charts.escapeText(t.id) + '">'
      + '<div class="task-row">'
      + '<button class="task-check" data-act="toggle" aria-label="标记完成">'
      +   '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 13l4 4L19 7"/></svg>'
      + '</button>'
      + '<button class="task-main" data-act="edit" aria-label="编辑任务">'
      +   '<span class="task-title"></span>'
      +   Charts.taskProgress(t)
      + '</button>'
      + '<span class="task-count">' + Charts.escapeText(meta.join(' · ')) + '</span>'
      + (t.archived
          ? '<button class="task-focus" data-act="unarchive" aria-label="取消归档">'
            + '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7"/></svg>'
            + '</button>'
          : '<button class="task-focus" data-act="focus" aria-label="为此任务专注">'
            + '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a9 9 0 1 1-9 9"/>'
            + '<path d="M12 8v4l3 2"/></svg>'
            + '</button>'
            + '<button class="task-archive" data-act="archive" aria-label="归档任务">'
            + '<svg viewBox="0 0 24 24" aria-hidden="true">'
            + '<path d="M3 7h18v4H3zM5 11v9h14v-9M9 15h6"/></svg>'
            + '</button>')
      + '<button class="task-del" data-act="del" aria-label="删除任务">'
      +   '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>'
      + '</button>'
      + '</div>'
      + (editing ? taskEditorHTML(t) : '')
      + '</li>';
  }

  /** 行内编辑器：改名 / 专注时长 / 预估 / 优先级，改动即存 */
  function taskEditorHTML(t) {
    return '<div class="task-editor">'
      + '<input type="text" class="edit-title" maxlength="60" aria-label="任务名称"'
      + ' autocomplete="off">'
      + '<div class="edit-grid">'
      +   '<label class="opt">时长'
      +     '<span class="stepper stepper-sm">'
      +       '<button type="button" data-act="dur-" aria-label="减少专注时长">−</button>'
      +       '<output class="edit-dur">' + t.focusMin + '</output>'
      +       '<button type="button" data-act="dur+" aria-label="增加专注时长">+</button>'
      +     '</span>'
      +   '</label>'
      +   '<label class="opt">预估'
      +     '<span class="stepper stepper-sm">'
      +       '<button type="button" data-act="est-" aria-label="减少预估">−</button>'
      +       '<output class="edit-est">' + t.estimate + '</output>'
      +       '<button type="button" data-act="est+" aria-label="增加预估">+</button>'
      +     '</span>'
      +   '</label>'
      +   '<label class="opt">优先级'
      +     '<select class="edit-prio" aria-label="优先级">'
      +       '<option value="high">高</option>'
      +       '<option value="normal">普通</option>'
      +       '<option value="low">低</option>'
      +     '</select>'
      +   '</label>'
      + '</div>'
      + '<p class="edit-minutes"></p>'
      + '</div>';
  }

  /** 展开的编辑器填值：标题/优先级/累计分钟走 DOM 属性，防注入 */
  function fillEditors(container, arr) {
    var minutesMap = Store.taskMinutesById();
    var items = container.querySelectorAll('.task-item.editing');
    for (var i = 0; i < items.length; i++) {
      var id = items[i].getAttribute('data-id');
      var t = null;
      for (var k = 0; k < arr.length; k++) if (arr[k].id === id) t = arr[k];
      if (!t) continue;

      var input = items[i].querySelector('.edit-title');
      if (input) input.value = t.title;

      var sel = items[i].querySelector('.edit-prio');
      if (sel) sel.value = t.priority;

      var mins = items[i].querySelector('.edit-minutes');
      if (mins) {
        var m = minutesMap[t.id] | 0;
        mins.textContent = t.focusMin > 0
          ? ('此任务每次专注 ' + t.focusMin + ' 分钟')
          : '时长 0 = 跟随全局设置';
        if (m > 0) mins.textContent += ' · 累计已专注 ' + m + ' 分钟';
      }
    }
  }

  /** 标题一律用 textContent 写入，防止任务名里的 < > 被当成 HTML */
  function fillTitles(container, arr) {
    var nodes = container.querySelectorAll('.task-title');
    for (var i = 0; i < nodes.length && i < arr.length; i++) {
      nodes[i].textContent = arr[i].title;
    }
  }

  function renderTasks() {
    var active = sortedActive();
    var archived = tasks.list.filter(function (t) { return t.archived; });

    el.taskEmptyTip.hidden = active.length > 0;
    el.taskList.innerHTML = active.map(taskItemHTML).join('');
    fillTitles(el.taskList, active);
    fillEditors(el.taskList, active);

    el.archiveHead.hidden = archived.length === 0;
    el.archiveCount.textContent = archived.length ? '(' + archived.length + ')' : '';
    if (archiveOpen && archived.length) {
      el.archiveList.hidden = false;
      el.archiveList.innerHTML = archived.map(taskItemHTML).join('');
      fillTitles(el.archiveList, archived);
      fillEditors(el.archiveList, archived);
      el.toggleArchive.textContent = '收起';
    } else {
      el.archiveList.hidden = true;
      el.archiveList.innerHTML = '';
      el.toggleArchive.textContent = '展开';
    }

    el.activeTaskLabel.textContent = activeTaskName();
  }

  function saveTasks() { Store.saveTasks(tasks); }

  // ============================================
  // 阶段结束 / 加时开始
  // ============================================
  function onPhaseEnd(info) {
    var s = T.get();
    var wasFocus = (info.finished === 'focus');

    // 到点了，之前调度的通知已经由系统弹出（或即将弹出），取消残留
    cancelEndNotifications();
    // 阶段结束白噪音必定停：休息/下一轮开始时按设置重新拉起
    Noise.stop();

    if (info.counted && wasFocus) {
      // 加时结算或自然完成都走这里；info.focusMin 含加时的真实时长
      var t = activeTask();
      Store.addCompletion(info.focusMin, activeTaskName(), t ? t.id : null,
                          focusPauses);
      if (t) { t.pomodoros++; saveTasks(); renderTasks(); }
      renderStats();
      // 数据变了就同步一份给 agent（外链埋坑关闭时是空操作）
      DataLink.autoSync();
    }
    focusPauses = 0;

    // 提示音分工：加时开始已响过"专注铃"，这里只在休息结束时响"回归铃"，
    // 结算时用户刚按过按钮（有按压震动），不叠加铃声
    if (!wasFocus && s.settings.sound) Sound.restEnd();
    if (!wasFocus && s.settings.vibrate) Native.notificationVibrate();

    // App 在后台时（FGS 让进程活着、JS 只是被节流不冻结），
    // 休息结束要补一条即时通知，光有声音不够。
    if (global.document && document.hidden && !wasFocus && s.settings.notify) {
      Native.postImmediate(8804, '休息结束', '回到专注，继续下一个番茄');
    }

    el.srStatus.textContent = (wasFocus ? '专注完成，' : '休息结束，')
                            + '进入' + (PHASE_TEXT[info.next] || '');
  }

  /**
   * 加时开始：专注倒计时走完的瞬间。
   * 铃照响、通知照发（用户得知道到点了），但计时不停车，
   * 转成 "+MM:SS" 正计时，超出的部分计入专注，直到暂停或开始休息。
   */
  function onOvertimeStart(s) {
    cancelEndNotifications();     // 备用闹钟此刻正好到期，撤掉残留
    Noise.stop();                 // 白噪音按加时态重新拉起

    if (s.settings.sound) Sound.focusEnd();
    if (s.settings.vibrate) Native.notificationVibrate();

    // 后台时补一条"到点了"的卡片；上面的闹钟通知本身也带「开始下一阶段」
    if (global.document && document.hidden && s.settings.notify) {
      Native.postImmediate(8803, '专注时间到', '已进入加时专注，点按开始休息');
    }

    if (!document.hidden) toast('已进入加时专注，超出时间也在计入', 2600);
    el.srStatus.textContent = '专注时间到，已进入加时正计时';
  }

  /** 本次专注内的暂停计数，advance 时清零 */
  var focusPauses = 0;

  // ============================================
  // 主控件
  // ============================================
  function bindFlipButton() {
    el.flipBtn.addEventListener('click', function () {
      unlockAudioIfEnabled();
      pressFeedback();
      if (Flip) Flip.enter();
    });
  }

  function pressFeedback() {
    if (T.getSettings().vibrate) Native.impact('MEDIUM');
  }

  /**
   * 在用户手势内解锁 WebAudio。
   * 声音关掉时没必要解锁——设置里重新打开声音也是一次用户手势，
   * 那个 change 处理器里会自己解锁。
   */
  function unlockAudioIfEnabled() {
    if (T.getSettings().sound) Sound.unlock();
  }

  function bindControls() {
    el.startBtn.addEventListener('click', function () {
      var snap = T.get();
      var willStart = !snap.running;

      // 专注进行中按下 = 暂停，记一次中断。
      // 加时态的暂停是"结算"，不算中断。
      if (!willStart && snap.running && snap.isFocus && !snap.overtime) focusPauses++;

      // 开始新一轮时清掉上一阶段的「XX结束」通知卡片
      if (willStart) Native.cancelEndCards();

      // 必须在这次用户手势里解锁音频，否则结束音在 WebView 里不会响
      unlockAudioIfEnabled();
      pressFeedback();

      if (willStart && !askedNotifyPermission && T.getSettings().notify) {
        askedNotifyPermission = true;
        // 先挡住调度，等权限结果出来再补，避免和系统弹窗打架
        permissionPending = true;
        // 权限申请必须在手势内发起；拒绝也要继续计时，不能卡死
        Native.requestNotifyPermission().then(function (ok) {
          permissionPending = false;
          if (!ok) {
            toast('已拒绝通知权限，无法在后台提醒', 2600);
            el.notifyNote.textContent = '通知权限被拒绝，App 在后台时无法提醒，但计时不受影响。';
          }
          // 权限结果出来后再调度一次，确保拿到权限的情况下不漏
          var snap = T.get();
          if (snap.running) scheduleEndNotification(snap);
        });
      }

      T.toggle();
    });

    el.resetBtn.addEventListener('click', function () {
      pressFeedback();
      cancelEndNotifications();
      T.reset();
    });

    el.skipBtn.addEventListener('click', function () {
      unlockAudioIfEnabled();
      pressFeedback();
      cancelEndNotifications();
      T.skip();
    });
  }

  // ============================================
  // 设置面板
  // ============================================
  var sheetOpen = false;
  var panelOpen = false;

  function openSheet(which) {
    var sheet = which === 'panel' ? el.panel : el.sheet;
    var backdrop = which === 'panel' ? el.panelBackdrop : el.sheetBackdrop;
    var closeBtn = which === 'panel' ? el.panelClose : el.sheetClose;

    if (which === 'panel') { panelOpen = true; renderStats(); renderTasks(); }
    else sheetOpen = true;

    sheet.hidden = false;
    backdrop.hidden = false;
    global.requestAnimationFrame(function () {
      sheet.classList.add('open');
      backdrop.classList.add('open');
    });
    closeBtn.focus();
  }

  function closeSheet(which) {
    var sheet = which === 'panel' ? el.panel : el.sheet;
    var backdrop = which === 'panel' ? el.panelBackdrop : el.sheetBackdrop;
    var trigger = which === 'panel' ? el.panelBtn : el.settingsBtn;

    if (which === 'panel') panelOpen = false; else sheetOpen = false;

    sheet.classList.remove('open');
    backdrop.classList.remove('open');
    global.setTimeout(function () {
      var stillClosed = (which === 'panel') ? !panelOpen : !sheetOpen;
      if (stillClosed) { sheet.hidden = true; backdrop.hidden = true; }
    }, 400);
    trigger.focus();
  }

  function anySheetOpen() { return sheetOpen || panelOpen; }

  function closeTopSheet() {
    // 统计面板层级更高，先关它
    if (panelOpen) { closeSheet('panel'); return true; }
    if (sheetOpen) { closeSheet('settings'); return true; }
    return false;
  }

  // 走 settings 的步进器目标
  var SETTING_OF = {
    focusMin: 'focusMin', shortMin: 'shortMin', longMin: 'longMin', dailyGoal: 'dailyGoal'
  };

  function stepSetting(target, delta) {
    // 新任务的预估/时长不进 settings，只是表单上的临时值
    if (target === 'newEstimate' || target === 'newFocusMin') {
      var cur = parseInt(el[target].textContent, 10) || 0;
      var hi = (target === 'newEstimate') ? 40 : 90;
      var next = Store.clamp(cur + delta, 0, hi);
      el[target].textContent = String(next);
      if (T.getSettings().vibrate) Native.impact('LIGHT');
      return;
    }

    var key = SETTING_OF[target];
    if (!key) return;
    T.setSetting(key, T.getSettings()[key] + delta);
    if (T.getSettings().vibrate) Native.impact('LIGHT');

    // 改目标要立刻反映到目标环和洞察上
    if (key === 'dailyGoal') {
      el.dailyGoal.textContent = String(T.getSettings().dailyGoal);
      if (currentTab === 'stats') renderStats();
    }
  }

  function bindStepper(btn) {
    var target = btn.getAttribute('data-target');
    var delta = parseInt(btn.getAttribute('data-step'), 10);

    function begin(e) {
      e.preventDefault();
      stepSetting(target, delta);
      pressTimer = global.setTimeout(function () {
        repeatTimer = global.setInterval(function () { stepSetting(target, delta); }, 90);
      }, 450);
    }

    function end() {
      if (pressTimer) { global.clearTimeout(pressTimer); pressTimer = null; }
      if (repeatTimer) { global.clearInterval(repeatTimer); repeatTimer = null; }
    }

    btn.addEventListener('pointerdown', begin);
    btn.addEventListener('pointerup', end);
    btn.addEventListener('pointercancel', end);
    btn.addEventListener('pointerleave', end);
  }

  function bindSettings() {
    el.settingsBtn.addEventListener('click', function () {
      pressFeedback();
      openSheet('settings');
    });
    el.sheetClose.addEventListener('click', function () { closeSheet('settings'); });
    el.sheetBackdrop.addEventListener('click', function () { closeSheet('settings'); });

    el.soundToggle.addEventListener('change', function () {
      T.setSetting('sound', this.checked);
      if (this.checked) { Sound.unlock(); Sound.preview(); }
    });

    el.vibrateToggle.addEventListener('change', function () {
      T.setSetting('vibrate', this.checked);
      if (this.checked) Native.notificationVibrate();
    });

    el.notifyToggle.addEventListener('change', function () {
      T.setSetting('notify', this.checked);
      if (this.checked) {
        Native.requestNotifyPermission().then(function (ok) {
          if (!ok) toast('通知权限被拒绝，无法在后台提醒', 2400);
          var snap = T.get();
          if (snap.running) scheduleEndNotification(snap);
        });
      } else {
        cancelEndNotifications();
      }
    });

    // 白噪音：选择即生效；只影响专注进行中的段落
    el.noiseSelect.addEventListener('change', function () {
      T.setSetting('noise', this.value);
      if (this.value !== 'off') {
        unlockAudioIfEnabled();
        // 立即试听两秒，确认选择的质感
        Noise.start(this.value);
        global.setTimeout(function () {
          var snap = T.get();
          if (!(snap.running && snap.isFocus && T.getSettings().noise === Noise.current())) {
            Noise.stop();
          }
        }, 2500);
      }
      toast(({ rain: '雨声', cafe: '咖啡馆' })[this.value] || '已关闭白噪音', 1400);
    });

    // 前台常驻通知（防后台被杀）
    el.fgsToggle.addEventListener('change', function () {
      T.setSetting('fgs', this.checked);
      if (!Native.fgsAvailable || !Native.fgsAvailable()) {
        toast('该环境不支持常驻服务，装到手机上生效', 2400);
      } else if (this.checked) {
        Native.fgsStart();
      } else {
        Native.fgsStop();
      }
    });

    var steppers = el.sheet.querySelectorAll('.stepper button');
    for (var i = 0; i < steppers.length; i++) bindStepper(steppers[i]);
  }

  // ============================================
  // 统计与任务面板
  // ============================================
  function bindPanel() {
    el.panelBtn.addEventListener('click', function () {
      pressFeedback();
      openSheet('panel');
    });
    el.panelClose.addEventListener('click', function () { closeSheet('panel'); });
    el.panelBackdrop.addEventListener('click', function () { closeSheet('panel'); });

    // 分页切换
    el.tabStats.addEventListener('click', function () { switchTab('stats'); });
    el.tabTasks.addEventListener('click', function () { switchTab('tasks'); });
    el.tabData.addEventListener('click', function () { switchTab('data'); });

    el.taskAddForm.addEventListener('submit', function (e) {
      e.preventDefault();
      var title = el.taskInput.value.trim();
      if (!title) return;
      tasks.list.push({
        id: String(Date.now()) + Math.floor(Math.random() * 1000),
        title: title.slice(0, 60),
        done: false,
        pomodoros: 0,
        estimate: parseInt(el.newEstimate.textContent, 10) || 0,
        focusMin: parseInt(el.newFocusMin.textContent, 10) || 0,
        priority: el.newPriority.value || 'normal',
        archived: false,
        createdAt: Date.now()
      });
      el.taskInput.value = '';
      el.newEstimate.textContent = '0';
      el.newFocusMin.textContent = '0';
      el.newPriority.value = 'normal';
      saveTasks();
      renderTasks();
      pressFeedback();
      DataLink.autoSync();
    });

    // 事件委托，列表重渲染后不用重新绑定。归档列表共用同一套逻辑。
    function onTaskClick(e) {
      var btn = e.target.closest('[data-act]');
      if (!btn) return;
      var li = btn.closest('.task-item');
      if (!li) return;
      var id = li.getAttribute('data-id');
      var act = btn.getAttribute('data-act');

      var idx = -1;
      for (var i = 0; i < tasks.list.length; i++) if (tasks.list[i].id === id) idx = i;
      if (idx < 0) return;
      var t = tasks.list[idx];

      if (act === 'toggle') {
        t.done = !t.done;
      } else if (act === 'del') {
        if (tasks.activeId === id) tasks.activeId = null;
        if (expandedTaskId === id) expandedTaskId = null;
        tasks.list.splice(idx, 1);
        toast('已删除任务', 1400);
      } else if (act === 'focus') {
        // 再点一次取消选中，回到自由专注
        tasks.activeId = (tasks.activeId === id) ? null : id;
        toast(tasks.activeId ? ('专注：' + t.title) : '已切回自由专注', 1500);
      } else if (act === 'archive') {
        t.archived = true;
        if (tasks.activeId === id) tasks.activeId = null;
        toast('已归档', 1200);
      } else if (act === 'unarchive') {
        t.archived = false;
        toast('已取消归档', 1200);
      } else if (act === 'edit') {
        // 点标题展开/收起编辑器；同时只展开一个
        expandedTaskId = (expandedTaskId === id) ? null : id;
        renderTasks();
        pressFeedback();
        return;
      } else if (act === 'dur-' || act === 'dur+') {
        // 编辑器步进：就地更新数字，不重渲染（避免输入框失焦）
        t.focusMin = Store.clamp(t.focusMin + (act === 'dur+' ? 5 : -5), 0, 90);
        var durOut = li.querySelector('.edit-dur');
        if (durOut) durOut.textContent = String(t.focusMin);
        fillEditors(li.parentElement, tasks.list.filter(function (x) { return x.id === id; }));
        saveTasks();
        applyFocusOverride();
        pressFeedback();
        DataLink.autoSync();
        return;
      } else if (act === 'est-' || act === 'est+') {
        t.estimate = Store.clamp(t.estimate + (act === 'est+' ? 1 : -1), 0, 40);
        var estOut = li.querySelector('.edit-est');
        if (estOut) estOut.textContent = String(t.estimate);
        saveTasks();
        pressFeedback();
        DataLink.autoSync();
        return;
      } else {
        return;
      }

      // 任务增删/选中变化后，专注时长覆盖跟着当前任务走
      applyFocusOverride();
      saveTasks();
      renderTasks();
      pressFeedback();
      DataLink.autoSync();
    }
    el.taskList.addEventListener('click', onTaskClick);
    el.archiveList.addEventListener('click', onTaskClick);

    // 编辑器里的输入框 / 优先级下拉：change 时保存，再重渲染回显
    function onTaskChange(e) {
      var li = e.target.closest('.task-item');
      if (!li) return;
      var id = li.getAttribute('data-id');
      var t = null;
      for (var i = 0; i < tasks.list.length; i++) if (tasks.list[i].id === id) t = tasks.list[i];
      if (!t) return;

      if (e.target.classList.contains('edit-title')) {
        var v = e.target.value.trim();
        if (v) {
          t.title = v.slice(0, 60);
          saveTasks();
          DataLink.autoSync();
        }
        renderTasks();
      } else if (e.target.classList.contains('edit-prio')) {
        t.priority = e.target.value;
        saveTasks();
        renderTasks();
        DataLink.autoSync();
      }
    }
    el.taskList.addEventListener('change', onTaskChange);
    el.archiveList.addEventListener('change', onTaskChange);

    el.toggleArchive.addEventListener('click', function () {
      archiveOpen = !archiveOpen;
      renderTasks();
      pressFeedback();
    });

    // 新任务的预估/时长步进器
    var addSteppers = el.panel.querySelectorAll('.stepper-sm button, #goalStepper button');
    for (var k = 0; k < addSteppers.length; k++) bindStepper(addSteppers[k]);

    // 图表切换器
    bindChartTabs();

    el.exportBtn.addEventListener('click', function () {
      pressFeedback();
      download('pomodoro-' + Store.dayKey() + '.json',
               JSON.stringify(Store.exportAll(), null, 2), 'application/json');
    });

    el.exportMdBtn.addEventListener('click', function () {
      pressFeedback();
      download('pomodoro-report-' + Store.dayKey() + '.md',
               Store.exportMarkdown(), 'text/markdown');
    });

    // 恢复备份：选文件 → 校验 → 覆盖导入
    el.importBtn.addEventListener('click', function () {
      pressFeedback();
      el.importFile.click();
    });

    el.importFile.addEventListener('change', function () {
      var file = this.files && this.files[0];
      this.value = '';              // 允许再次选择同一文件
      if (!file) return;

      var reader = new FileReader();
      reader.onload = function () {
        var dump;
        try { dump = JSON.parse(String(reader.result)); }
        catch (e) { toast('文件不是合法 JSON', 2400); return; }

        var err = Store.validateImport(dump);
        if (err) { toast('无法导入：' + err, 3200); return; }

        try {
          var r = Store.importAll(dump);
          tasks = Store.loadTasks();
          T.init();                 // 状态层也按新数据重置
          renderTasks();
          renderStats();
          DataLink.autoSync();
          toast('已恢复 ' + r.importedDays + ' 天记录（原数据已留底）', 3200);
        } catch (e2) {
          toast('导入失败：' + (e2 && e2.message ? e2.message : '未知错误'), 3200);
        }
      };
      reader.onerror = function () { toast('读取文件失败', 2400); };
      reader.readAsText(file, 'utf-8');
    });
  }

  var currentTab = 'stats';
  function switchTab(name) {
    currentTab = name;
    var map = {
      stats: [el.tabStats, el.pageStats],
      tasks: [el.tabTasks, el.pageTasks],
      data: [el.tabData, el.pageData]
    };
    Object.keys(map).forEach(function (k) {
      var on = (k === name);
      map[k][0].classList.toggle('active', on);
      map[k][0].setAttribute('aria-selected', on ? 'true' : 'false');
      map[k][1].hidden = !on;
    });
    if (name === 'stats') renderStats();
    if (name === 'tasks') renderTasks();
    pressFeedback();
  }

  /** 下载文件：Blob + a[download]，Capacitor WebView 下同样有效 */
  function download(filename, content, mime) {
    try {
      var blob = new Blob([content], { type: mime });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      // 立刻 revoke 在部分 WebView 里会打断下载，延后释放
      global.setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
      toast('已导出 ' + filename, 1800);
    } catch (e) {
      toast('导出失败：' + (e && e.message ? e.message : '未知错误'), 2400);
    }
  }

  // ============================================
  // 键盘
  // ============================================
  function bindKeyboard() {
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && anySheetOpen()) { closeTopSheet(); return; }
      if ((e.key === ' ' || e.code === 'Space') && !anySheetOpen()) {
        // 焦点在按钮 / 输入框上时交给它们自己处理
        var ae = document.activeElement;
        if (ae && (ae.tagName === 'BUTTON' || ae.tagName === 'INPUT')) return;
        e.preventDefault();
        unlockAudioIfEnabled();
        T.toggle();
      }
    });
  }

  // ============================================
  // 原生初始化
  // ============================================
  function initNative() {
    Native.applyStatusBar();

    // 冷启动先静默查一次权限状态。
    // 已经授权过的话就不用在点"开始"时再申请，也不会重复弹窗。
    Native.checkNotifyPermission().then(function (state) {
      if (state === 'granted') {
        askedNotifyPermission = true;
      } else if (state === 'denied') {
        askedNotifyPermission = true;
        el.notifyNote.textContent = '通知权限被拒绝，App 在后台时无法提醒，但计时不受影响。';
      }
    });

    // 官方建议：用户可在系统设置关闭"闹钟和提醒"，关闭会让已排的精确闹钟失效。
    // 启动时检查一次，被关就明确告知（仅提示，不阻塞使用）。
    Native.checkExactAlarmSetting().then(function (state) {
      if (state === 'disabled') {
        el.notifyNote.textContent = '系统已关闭「闹钟和提醒」权限，到点提醒不可用；'
                                   + '计时不受影响。可在系统设置 → 应用 → 番茄钟中重新开启。';
      }
    });

    // 后台回前台：重新校准
    Native.onAppStateChange(function (isActive) {
      if (isActive) {
        T.resync();
        renderStats();
      } else {
        // 进后台前确保通知已按最新结束时间调度
        var s = T.get();
        if (s.running) scheduleEndNotification(s);
      }
    });

    // 网页环境下切标签页也校准（桌面预览用）
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) { T.resync(); renderStats(); }
    });

    bindBackButton();
    bindDarkModeSync();

    // 常驻通知上的按钮事件（原生转发回来）
    Native.onFgsAction(function (act) {
      if (act === 'toggle') {
        var s = T.get();
        // 通知栏按钮不算"用户手势在页面内"，音频解锁不能指望它，但功能照常
        if (s.running && s.isFocus && !s.overtime) focusPauses++;
        T.toggle();
        if (T.getSettings().vibrate) Native.impact('LIGHT');
      } else if (act === 'stop') {
        Noise.stop();
        cancelEndNotifications();
        T.reset();
      } else if (act === 'continueNext') {
        // 到点提醒上的「开始下一阶段」：进 app 即续跑，不用再找按钮。
        // 加时态下它的意思是"结算加时、开始休息"。
        T.resync();
        if (T.get().overtime) {
          T.skip();
        } else {
          cancelEndNotifications();
          Sound.unlock();
          T.start();
          if (T.getSettings().vibrate) Native.impact('LIGHT');
          toast('已开始' + (PHASE_TEXT[T.get().phase] || ''), 1600);
        }
      }
    });
  }

  /** Back 键：有弹层先关弹层，主界面时双击退出 */
  var lastBackAt = 0;
  function bindBackButton() {
    Native.onBackButton(function () {
      // 全屏时钟最顶层：先退它，其他交互暂停
      if (Flip && Flip.isOpen()) { Flip.leave(); return; }
      if (closeTopSheet()) return;

      var now = Date.now();
      if (now - lastBackAt < 2000) {
        Native.exitApp();
      } else {
        lastBackAt = now;
        toast('再按一次退出', 2000);
      }
    });
  }

  /**
   * 跟随系统深色模式同步状态栏。
   * 配色本身锁定为暖米白浅色主题（不改成暗色），
   * 深色模式下只把状态栏图标切成浅色以保证可读，页面背景保持不变，
   * 这样也不会出现切换时的刺眼闪白。
   */
  function bindDarkModeSync() {
    if (!global.matchMedia) return;
    var mq = global.matchMedia('(prefers-color-scheme: dark)');

    function apply() {
      var SB = (global.Capacitor && global.Capacitor.Plugins)
             ? global.Capacitor.Plugins.StatusBar : null;
      if (!SB) return;
      // 背景始终是暖米白，所以图标始终该是深色（Style.Light）。
      // 深色模式下重新下发一次，防止系统覆盖成浅色图标导致看不清。
      if (SB.setStyle) SB.setStyle({ style: 'LIGHT' }).catch(function () {});
      if (SB.setBackgroundColor) SB.setBackgroundColor({ color: '#f0eee6' }).catch(function () {});
    }

    apply();
    if (mq.addEventListener) mq.addEventListener('change', apply);
    else if (mq.addListener) mq.addListener(apply);
  }

  // ============================================
  // 启动
  // ============================================
  function boot() {
    [
      'srStatus', 'roundDots', 'settingsBtn', 'phaseLabel', 'timeDisplay', 'hintLabel',
      'activeTaskLabel', 'dialFill', 'startBtn', 'resetBtn', 'skipBtn', 'todayCount',
      'panelBtn', 'sheet', 'sheetBackdrop', 'sheetClose',
      'focusMin', 'shortMin', 'longMin',
      'soundToggle', 'vibrateToggle', 'notifyToggle', 'notifyNote',
      'panel', 'panelBackdrop', 'panelClose',
      'tabStats', 'tabTasks', 'tabData', 'pageStats', 'pageTasks', 'pageData',
      'goalRingBox', 'goalTitle', 'goalDesc', 'goalStreak',
      'statToday', 'statMinutes', 'statStreak', 'weekChart',
      'chartTabs', 'rangeTabs', 'mainChart', 'chartNote', 'recentList',
      'insightList',
      'taskAddForm', 'taskInput', 'taskList', 'taskEmptyTip',
      'newEstimate', 'newFocusMin', 'newPriority',
      'archiveHead', 'archiveCount', 'toggleArchive', 'archiveList',
      'exportBtn', 'exportMdBtn',
      'importBtn', 'importFile',
      'noiseSelect', 'fgsToggle', 'dailyGoal', 'flipBtn', 'toast'
    ].forEach(function (id) { el[id] = document.getElementById(id); });

    // 翻页时钟先绑好（它自带 DOM 查找）
    if (Flip) Flip.bind();

    // 按实际半径算周长，改 SVG 尺寸不用同步改 JS
    var r = parseFloat(el.dialFill.getAttribute('r')) || 110;
    circumference = 2 * Math.PI * r;
    el.dialFill.style.strokeDasharray = String(circumference);
    el.dialFill.style.strokeDashoffset = String(circumference);

    tasks = Store.loadTasks();

    T.on('tick', renderMain);
    T.on('change', onChange);
    T.on('phaseEnd', onPhaseEnd);
    T.on('overtimeStart', onOvertimeStart);

    bindControls();
    bindFlipButton();
    bindSettings();
    bindPanel();
    bindKeyboard();

    renderTasks();
    onChange(T.init());

    // 原生桥与权限检查不挡首帧：等界面画完再碰（启动卡顿优化）
    global.setTimeout(initNative, 120);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(window);
