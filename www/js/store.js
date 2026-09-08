/**
 * 持久化层：所有 localStorage 读写集中在这里
 *
 * 分五个 key，各自独立，互不影响：
 *   pomodoro_settings  设置（时长、开关、每日目标）
 *   pomodoro_records   按日期汇总：完成数 / 专注分钟 / 各任务番茄数
 *   pomodoro_sessions  每次专注的明细流水（带起止时间戳，供时段分析）
 *   pomodoro_tasks     任务列表
 *   pomodoro_state     当前计时状态（刷新后恢复到暂停态）
 *
 * 拆开而不是塞一个大对象的原因：设置和历史的生命周期完全不同，
 * 单个 key 写坏会连带丢掉全部数据。
 *
 * records 是 sessions 的汇总视图。两份都存看似冗余，但 records 让
 * "今日/本周"这类高频查询是 O(1)，而 sessions 保留了原始时间戳，
 * 时段热图、效率分析这些都得靠它。sessions 有条数上限，records 永久留。
 */
(function (global) {
  'use strict';

  var K = {
    settings: 'pomodoro_settings',
    records: 'pomodoro_records',
    sessions: 'pomodoro_sessions',
    tasks: 'pomodoro_tasks',
    state: 'pomodoro_state'
  };

  // sessions 只保留最近这么多条。按每天 16 个番茄算够存 4 个月，
  // 足够所有图表用，也不会让 localStorage 无限膨胀。
  var MAX_SESSIONS = 2000;

  var DEFAULT_SETTINGS = {
    focusMin: 25,
    shortMin: 5,
    longMin: 15,
    roundsBeforeLong: 4,
    sound: true,
    vibrate: true,
    notify: true,
    dailyGoal: 8,        // 每日目标番茄数
    autoExport: true,    // 每次完成后自动写一份数据到外部存储，供 agent 读取
    noise: 'off',        // 白噪音：off | rain | cafe
    fgs: true            // 前台常驻通知（防后台被杀）
  };

  // 合法区间，防止脏数据或手滑调出离谱的值
  var LIMITS = {
    focusMin: [1, 90], shortMin: [1, 30], longMin: [1, 60], dailyGoal: [1, 30]
  };

  var NOISE_KINDS = { off: 1, rain: 1, cafe: 1 };

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  function readRaw(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }

  function writeRaw(key, value) {
    // 隐私模式 / 存储配额满时会抛，静默失败，不能让 app 崩
    try { localStorage.setItem(key, value); return true; } catch (e) { return false; }
  }

  function readJSON(key, fallback) {
    var raw = readRaw(key);
    if (!raw) return fallback;
    try {
      var v = JSON.parse(raw);
      return (v && typeof v === 'object') ? v : fallback;
    } catch (e) {
      return fallback;   // 坏 JSON 当作没有，不抛
    }
  }

  function writeJSON(key, value) {
    try { return writeRaw(key, JSON.stringify(value)); } catch (e) { return false; }
  }

  /** 本地日期 YYYY-MM-DD。用本地时区而非 UTC，否则跨日判断会错一整天 */
  function dayKey(d) {
    d = d || new Date();
    var m = d.getMonth() + 1;
    var day = d.getDate();
    return d.getFullYear() + '-' + (m < 10 ? '0' + m : m) + '-' + (day < 10 ? '0' + day : day);
  }

  function parseDayKey(key) {
    var p = String(key).split('-');
    return new Date(+p[0], +p[1] - 1, +p[2]);
  }

  function shiftDays(d, n) {
    var x = new Date(d.getTime());
    x.setDate(x.getDate() + n);
    return x;
  }

  var Store = {
    KEYS: K,
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    LIMITS: LIMITS,
    dayKey: dayKey,
    parseDayKey: parseDayKey,
    shiftDays: shiftDays,
    clamp: clamp,

    // ---------- 设置 ----------
    loadSettings: function () {
      var raw = readJSON(K.settings, null);
      var s = {};
      Object.keys(DEFAULT_SETTINGS).forEach(function (k) {
        var v = raw ? raw[k] : undefined;
        s[k] = (typeof v === typeof DEFAULT_SETTINGS[k]) ? v : DEFAULT_SETTINGS[k];
      });
      Object.keys(LIMITS).forEach(function (k) {
        var n = Math.round(Number(s[k]));
        s[k] = isFinite(n) ? clamp(n, LIMITS[k][0], LIMITS[k][1]) : DEFAULT_SETTINGS[k];
      });
      var r = Math.round(Number(s.roundsBeforeLong));
      s.roundsBeforeLong = isFinite(r) ? clamp(r, 2, 8) : 4;
      if (!NOISE_KINDS[s.noise]) s.noise = 'off';
      s.fgs = !!s.fgs;
      return s;
    },

    saveSettings: function (s) { return writeJSON(K.settings, s); },

    // ---------- 历史记录 ----------
    /** { "2026-08-26": { count, minutes, tasks: { 任务名: N } } } */
    loadRecords: function () {
      var r = readJSON(K.records, {});
      var out = {};
      Object.keys(r).forEach(function (day) {
        var e = r[day];
        if (!e || typeof e !== 'object') return;
        out[day] = {
          count: Math.max(0, e.count | 0),
          minutes: Math.max(0, Math.round(Number(e.minutes) || 0)),
          interrupts: Math.max(0, e.interrupts | 0),
          tasks: (e.tasks && typeof e.tasks === 'object') ? e.tasks : {}
        };
      });
      return out;
    },

    saveRecords: function (r) { return writeJSON(K.records, r); },

    // ---------- 专注流水 ----------
    /**
     * 每条 = 一次完成的专注
     * { at: 结束时间戳, day: "2026-08-26", hour: 0-23, min: 时长分钟, task: 任务名, taskId }
     */
    loadSessions: function () {
      var s = readJSON(K.sessions, null);
      if (!s || !Array.isArray(s.list)) return [];
      return s.list.filter(function (x) {
        return x && typeof x === 'object' && isFinite(Number(x.at)) && Number(x.at) > 0;
      }).map(function (x) {
        var at = Number(x.at);
        var d = new Date(at);
        return {
          at: at,
          // day/hour 落盘时就算好，读的时候不用再造 Date（图表要遍历上千条）
          day: (typeof x.day === 'string' && x.day) ? x.day : dayKey(d),
          hour: isFinite(Number(x.hour)) ? clamp(Number(x.hour) | 0, 0, 23) : d.getHours(),
          min: Math.max(0, Math.round(Number(x.min) || 0)),
          task: typeof x.task === 'string' ? x.task : '自由专注',
          taskId: typeof x.taskId === 'string' ? x.taskId : null,
          interrupts: Math.max(0, x.interrupts | 0)
        };
      });
    },

    saveSessions: function (list) {
      // 只留最近 MAX_SESSIONS 条，老的丢掉（汇总仍在 records 里）
      var trimmed = list.slice(-MAX_SESSIONS);
      return writeJSON(K.sessions, { list: trimmed });
    },

    /**
     * 记一个完成的番茄。只有走完全程才应该调用。
     * 同时写汇总（records）和流水（sessions）。
     * @param {number} minutes 本次专注时长
     * @param {string} taskName 任务名，无任务时传"自由专注"
     * @param {string} taskId   可选，关联的任务 id
     * @param {number} pauses   可选，这次专注里暂停了几次（中断次数）
     */
    addCompletion: function (minutes, taskName, taskId, pauses) {
      var now = new Date();
      var day = dayKey(now);
      var mins = Math.max(0, Math.round(minutes));
      var ints = Math.max(0, pauses | 0);
      var name = taskName || '自由专注';

      var recs = Store.loadRecords();
      var e = recs[day] || { count: 0, minutes: 0, tasks: {}, interrupts: 0 };
      e.count += 1;
      e.minutes += mins;
      e.tasks[name] = (e.tasks[name] | 0) + 1;
      e.interrupts = (e.interrupts | 0) + ints;
      recs[day] = e;
      Store.saveRecords(recs);

      var sessions = Store.loadSessions();
      sessions.push({
        at: now.getTime(), day: day, hour: now.getHours(),
        min: mins, task: name, taskId: taskId || null,
        interrupts: ints
      });
      Store.saveSessions(sessions);

      return e;
    },

    todayRecord: function () {
      var recs = Store.loadRecords();
      return recs[dayKey()] || { count: 0, minutes: 0, tasks: {} };
    },

    /**
     * 连续天数：从今天往前数连续有完成记录的天数。
     * 今天还没开始不该把 streak 归零，所以今天为空时从昨天起算。
     */
    streak: function () {
      var recs = Store.loadRecords();
      var today = new Date();
      var cursor = today;
      if (!recs[dayKey(today)] || recs[dayKey(today)].count <= 0) {
        cursor = shiftDays(today, -1);
        if (!recs[dayKey(cursor)] || recs[dayKey(cursor)].count <= 0) return 0;
      }
      var n = 0;
      var guard = 0;
      while (guard++ < 3650) {
        var e = recs[dayKey(cursor)];
        if (e && e.count > 0) { n++; cursor = shiftDays(cursor, -1); } else break;
      }
      return n;
    },

    /** 本周 7 天（周一起）的完成数，返回 [{day, label, count, minutes, isToday}] */
    weekSeries: function () {
      var recs = Store.loadRecords();
      var now = new Date();
      // getDay() 周日是 0，换算成周一为一周起点
      var offsetToMonday = (now.getDay() + 6) % 7;
      return Store.weeksFrom(recs, now, -offsetToMonday, 7, true);
    },

    /**
     * 从某日起点取 n 天序列。weekSeries 和上周对比共用这一个实现。
     * offsetDays 相对今天的偏移（负 = 过去），n 天数，withMeta 是否带标签/今天标记
     */
    weeksFrom: function (recs, from, offsetDays, n, withMeta) {
      recs = recs || Store.loadRecords();
      var labels = ['一', '二', '三', '四', '五', '六', '日'];
      var todayKey = dayKey(new Date());
      var base = shiftDays(from, offsetDays);
      var out = [];
      for (var i = 0; i < (n || 7); i++) {
        var d = shiftDays(base, i);
        var k = dayKey(d);
        var e = recs[k];
        var row = {
          day: k,
          count: e ? e.count : 0,
          minutes: e ? e.minutes : 0,
          interrupts: e ? (e.interrupts | 0) : 0
        };
        if (withMeta) {
          row.label = labels[(d.getDay() + 6) % 7];
          row.isToday = k === todayKey;
          row.isFuture = Store.parseDayKey(k) > from && k !== todayKey;
        }
        out.push(row);
      }
      return out;
    },

    // ---------- 图表数据 ----------
    /**
     * 最近 N 天的趋势，用于折线图。
     * @returns [{day, label, count, minutes, goalMet}]
     */
    daySeries: function (days) {
      days = clamp(days || 30, 2, 120);
      var recs = Store.loadRecords();
      var goal = Store.loadSettings().dailyGoal;
      var now = new Date();
      var out = [];
      for (var i = days - 1; i >= 0; i--) {
        var d = shiftDays(now, -i);
        var k = dayKey(d);
        var e = recs[k];
        var c = e ? e.count : 0;
        out.push({
          day: k,
          label: (d.getMonth() + 1) + '/' + d.getDate(),
          count: c,
          minutes: e ? e.minutes : 0,
          goalMet: c >= goal,
          isToday: i === 0
        });
      }
      return out;
    },

    /**
     * 24 小时时段分布，用于热图 —— 看出自己在几点最能专注。
     * @param {number} days 只统计最近多少天，默认 30
     * @returns [{hour, count, minutes}] 长度 24
     */
    hourHistogram: function (days) {
      days = clamp(days || 30, 1, 120);
      var cutoff = shiftDays(new Date(), -(days - 1));
      var cutoffKey = dayKey(cutoff);
      var buckets = [];
      for (var h = 0; h < 24; h++) buckets.push({ hour: h, count: 0, minutes: 0 });

      Store.loadSessions().forEach(function (s) {
        // 字符串日期可直接比较，YYYY-MM-DD 是字典序友好的
        if (s.day < cutoffKey) return;
        var b = buckets[s.hour];
        if (!b) return;
        b.count++;
        b.minutes += s.min;
      });
      return buckets;
    },

    /**
     * 星期分布（0 = 周一 … 6 = 周日），用于"哪天最能专注"柱状图。
     * @returns [{label, count, minutes}] 固定 7 项
     */
    weekdayHistogram: function (days) {
      days = clamp(days || 30, 1, 120);
      var cutoffKey = dayKey(shiftDays(new Date(), -(days - 1)));
      var labels = ['一', '二', '三', '四', '五', '六', '日'];
      var buckets = [];
      for (var i = 0; i < 7; i++) buckets.push({ label: labels[i], count: 0, minutes: 0 });

      Store.loadSessions().forEach(function (s) {
        if (s.day < cutoffKey) return;
        var d = parseDayKey(s.day);
        var b = buckets[(d.getDay() + 6) % 7];
        if (!b) return;
        b.count++;
        b.minutes += s.min;
      });
      return buckets;
    },

    /**
     * 每个任务累计专注分钟（全量流水），taskId → minutes。
     * 任务详情里"已专注多久"用，按标题聚合会重名，必须按 id。
     */
    taskMinutesById: function () {
      var map = {};
      Store.loadSessions().forEach(function (s) {
        if (!s.taskId) return;
        map[s.taskId] = (map[s.taskId] | 0) + s.min;
      });
      return map;
    },

    /**
     * 最近的专注记录（新的在前），给统计页"最近记录"列表。
     * 每条都显示——不管有没有关联任务——统计才"活着"。
     */
    recentSessions: function (n) {
      var list = Store.loadSessions();
      var out = [];
      for (var i = list.length - 1; i >= 0 && out.length < (n || 8); i--) {
        var s = list[i];
        out.push({
          at: s.at,
          hour: s.hour,
          min: s.min,
          task: s.task,
          taskId: s.taskId,
          interrupts: s.interrupts
        });
      }
      return out;
    },

    /**
     * 任务耗时占比，用于横向条形图。
     * @returns [{task, count, minutes, share}] 按番茄数降序
     */
    taskBreakdown: function (days) {
      days = clamp(days || 30, 1, 120);
      var cutoffKey = dayKey(shiftDays(new Date(), -(days - 1)));
      var map = {};
      var total = 0;

      Store.loadSessions().forEach(function (s) {
        if (s.day < cutoffKey) return;
        if (!map[s.task]) map[s.task] = { task: s.task, count: 0, minutes: 0 };
        map[s.task].count++;
        map[s.task].minutes += s.min;
        total++;
      });

      var arr = Object.keys(map).map(function (k) { return map[k]; });
      arr.forEach(function (x) { x.share = total > 0 ? x.count / total : 0; });
      arr.sort(function (a, b) { return b.count - a.count; });
      return arr;
    },

    /**
     * 汇总洞察，给"时间管理"面板用。
     * 这些数字是给人看的结论，不是原始数据。
     */
    insights: function () {
      var settings = Store.loadSettings();
      var recs = Store.loadRecords();
      var sessions = Store.loadSessions();
      var today = Store.todayRecord();
      var days = Object.keys(recs).filter(function (k) { return recs[k].count > 0; });

      var totalCount = 0, totalMin = 0;
      days.forEach(function (k) { totalCount += recs[k].count; totalMin += recs[k].minutes; });

      // 最佳时段：番茄数最多的那个小时
      var hist = Store.hourHistogram(30);
      var best = null;
      hist.forEach(function (b) { if (!best || b.count > best.count) best = b; });

      // 最近 7 天日均
      var last7 = Store.daySeries(7);
      var sum7 = 0;
      last7.forEach(function (d) { sum7 += d.count; });

      // 目标达成天数（有记录的天里）
      var metDays = days.filter(function (k) { return recs[k].count >= settings.dailyGoal; }).length;

      // 中断：今日 + 累计平均
      var todayInts = today.interrupts | 0;
      var totalInts = 0;
      days.forEach(function (k) { totalInts += (recs[k].interrupts | 0); });

      // 本周 vs 上周（同为完整 7 天窗口，上周从周一起算）
      var now = new Date();
      var offMon = (now.getDay() + 6) % 7;
      var thisWeek = Store.weeksFrom(recs, now, -offMon, 7);
      var lastWeek = Store.weeksFrom(recs, shiftDays(now, -7), -offMon, 7);
      function sum(arr) { return arr.reduce(function (a, r) { return a + r.count; }, 0); }
      var thisW = sum(thisWeek), lastW = sum(lastWeek);
      var wowDelta = thisW - lastW;
      var wowPct = lastW > 0 ? Math.round((wowDelta / lastW) * 100) : null;

      return {
        todayCount: today.count,
        todayMinutes: today.minutes,
        todayInterrupts: todayInts,
        dailyGoal: settings.dailyGoal,
        goalProgress: settings.dailyGoal > 0
          ? clamp(today.count / settings.dailyGoal, 0, 1) : 0,
        goalMet: today.count >= settings.dailyGoal,
        streak: Store.streak(),
        activeDays: days.length,
        totalCount: totalCount,
        totalMinutes: totalMin,
        totalInterrupts: totalInts,
        avgPerActiveDay: days.length > 0
          ? Math.round((totalCount / days.length) * 10) / 10 : 0,
        avgLast7: Math.round((sum7 / 7) * 10) / 10,
        bestHour: (best && best.count > 0) ? best.hour : null,
        bestHourCount: best ? best.count : 0,
        goalMetDays: metDays,
        goalMetRate: days.length > 0 ? Math.round((metDays / days.length) * 100) : 0,
        sessionCount: sessions.length,
        thisWeekCount: thisW,
        lastWeekCount: lastW,
        wowDelta: wowDelta,
        wowPct: wowPct
      };
    },

    // ---------- 任务 ----------
    loadTasks: function () {
      var t = readJSON(K.tasks, null);
      if (!t || !Array.isArray(t.list)) return { list: [], activeId: null };
      var PRIOS = { high: 1, normal: 1, low: 1 };
      var list = t.list.filter(function (x) {
        return x && typeof x === 'object' && typeof x.title === 'string';
      }).map(function (x) {
        var est = Math.round(Number(x.estimate));
        var fmin = Math.round(Number(x.focusMin) || 0);
        return {
          id: String(x.id || (Date.now() + '' + Math.random())),
          title: String(x.title).slice(0, 60),
          done: !!x.done,
          pomodoros: Math.max(0, x.pomodoros | 0),
          // 预估番茄数，0 表示没估
          estimate: isFinite(est) ? clamp(est, 0, 40) : 0,
          // 本任务专注时长（分钟），0 表示跟随全局设置
          focusMin: isFinite(fmin) ? clamp(fmin, 0, 90) : 0,
          priority: PRIOS[x.priority] ? x.priority : 'normal',
          archived: !!x.archived,
          createdAt: isFinite(Number(x.createdAt)) ? Number(x.createdAt) : Date.now()
        };
      });
      var activeId = (typeof t.activeId === 'string') ? t.activeId : null;
      // 指向已删除任务的 activeId 要清掉
      if (activeId && !list.some(function (x) { return x.id === activeId; })) activeId = null;
      return { list: list, activeId: activeId };
    },

    saveTasks: function (t) { return writeJSON(K.tasks, t); },

    // ---------- 备份恢复 ----------
    /**
     * 校验一份导出数据是否可用于导入。
     * @returns {string|null} 错误原因；null 表示合法
     */
    validateImport: function (dump) {
      if (!dump || typeof dump !== 'object') return '文件不是有效的 JSON 对象';
      if (!dump.records || typeof dump.records !== 'object') return '缺少 records 字段';
      var dayKeys = Object.keys(dump.records);
      var badDay = dayKeys.some(function (k) { return !/^\d{4}-\d{2}-\d{2}$/.test(k); });
      if (badDay) return 'records 的日期格式不正确';
      if (dayKeys.length === 0 && !(dump.sessions && dump.sessions.length)) {
        return '备份里没有任何记录，无需恢复';
      }
      if (dump.schema != null && Number(dump.schema) > 2) return '备份来自更新版本的应用，请先升级 app';
      return null;
    },

    /** 导入前的快照 key，出问题可手动回滚 */
    BACKUP_KEY: 'pomodoro_backup_preimport',

    /**
     * 用备份数据覆盖当前数据。
     * 覆盖前把现有五项数据整体留底到 pomodoro_backup_preimport，
     * 导入动作本身不可撤销，这是唯一的后悔药。
     * @returns {{importedDays:number, importedSessions:number}} 摘要
     */
    importAll: function (dump) {
      var err = Store.validateImport(dump);
      if (err) throw new Error(err);

      // 留底
      writeJSON(Store.BACKUP_KEY, {
        at: Date.now(),
        records: Store.loadRecords(),
        sessions: Store.loadSessions(),
        tasks: Store.loadTasks(),
        state: Store.loadState()
      });

      // records：逐日清洗
      var cleanRecs = {};
      Object.keys(dump.records).forEach(function (day) {
        var e = dump.records[day];
        if (!e || typeof e !== 'object') return;
        var t = e.tasks && typeof e.tasks === 'object' ? e.tasks : {};
        var ct = {};
        Object.keys(t).forEach(function (n) { ct[String(n)] = Math.max(0, t[n] | 0); });
        cleanRecs[day] = {
          count: Math.max(0, e.count | 0),
          minutes: Math.max(0, Math.round(Number(e.minutes) || 0)),
          interrupts: Math.max(0, e.interrupts | 0),
          tasks: ct
        };
      });

      // sessions：只做存在性过滤，格式化交给 loadSessions 的统一管道
      var rawSess = Array.isArray(dump.sessions)
        ? dump.sessions.filter(function (s) {
            return s && typeof s === 'object' && isFinite(Number(s.at)) && Number(s.at) > 0;
          })
        : [];

      // tasks
      var cleanTasks = dump.tasks && typeof dump.tasks === 'object' && Array.isArray(dump.tasks.list)
        ? dump.tasks : { list: [], activeId: null };

      Store.saveRecords(cleanRecs);
      Store.saveSessions(rawSess);          // 读出时会经过 loadSessions 清洗
      Store.saveTasks(cleanTasks);

      return {
        importedDays: Object.keys(cleanRecs).length,
        importedSessions: Math.min(rawSess.length, MAX_SESSIONS)
      };
    },

    // ---------- 计时状态 ----------
    loadState: function () { return readJSON(K.state, null); },
    saveState: function (s) { return writeJSON(K.state, s); },

    /**
     * 导出全部数据。这份结构同时用于两个地方：
     *   1. 用户手动下载的 JSON
     *   2. 自动写到外部存储供 agent 读取的快照
     *
     * 刻意做成自描述的：带 schema 版本、字段说明、以及算好的 summary，
     * agent 拿到文件不用理解 app 内部逻辑就能直接用。
     */
    exportAll: function () {
      var settings = Store.loadSettings();
      var records = Store.loadRecords();
      var sessions = Store.loadSessions();
      var tasks = Store.loadTasks();

      return {
        app: 'pomodoro',
        appName: '番茄钟',
        schema: 2,
        exportedAt: new Date().toISOString(),
        exportedAtMs: Date.now(),
        timezoneOffsetMin: new Date().getTimezoneOffset(),

        // 给 agent 的字段说明，省得它猜
        _readme: {
          records: '按日期汇总。key 是本地日期 YYYY-MM-DD，value.count 完成番茄数，value.minutes 专注分钟，value.tasks 各任务番茄数',
          sessions: '每次完成专注的流水。at 是结束时刻的毫秒时间戳，hour 是本地小时 0-23，min 是该次时长分钟，task 是任务名',
          tasks: 'list 是任务数组，estimate 是预估番茄数（0 表示未估），pomodoros 是已投入番茄数，priority 为 high/normal/low',
          summary: '已算好的汇总指标，可直接使用',
          note: 'sessions 只保留最近 ' + MAX_SESSIONS + ' 条，records 是全量汇总不会丢'
        },

        settings: settings,
        records: records,
        sessions: sessions,
        tasks: tasks,
        summary: Store.insights(),
        charts: {
          last30Days: Store.daySeries(30),
          hourHistogram: Store.hourHistogram(30),
          taskBreakdown: Store.taskBreakdown(30),
          thisWeek: Store.weekSeries()
        }
      };
    },

    /** 导出成人类可读的 Markdown，agent 和人都好读 */
    exportMarkdown: function () {
      var s = Store.insights();
      var days = Store.daySeries(14);
      var hist = Store.hourHistogram(30);
      var tasks = Store.taskBreakdown(30);
      var t = Store.loadTasks();

      function pad(str, n) {
        str = String(str);
        while (str.length < n) str += ' ';
        return str;
      }

      var L = [];
      L.push('# 番茄钟数据报告');
      L.push('');
      L.push('生成时间：' + new Date().toLocaleString('zh-CN'));
      L.push('');
      L.push('## 总览');
      L.push('');
      L.push('- 今日完成：' + s.todayCount + ' 个番茄（' + s.todayMinutes + ' 分钟），目标 '
             + s.dailyGoal + ' 个' + (s.goalMet ? ' — 已达成' : ''));
      L.push('- 今日中断：' + s.todayInterrupts + ' 次（专注中被暂停）');
      L.push('- 连续天数：' + s.streak + ' 天');
      if (s.wowPct !== null) {
        var trend = s.wowDelta === 0 ? '持平'
          : (s.wowDelta > 0 ? '+' : '') + s.wowDelta + '（' + (s.wowPct > 0 ? '+' : '') + s.wowPct + '%）';
        L.push('- 本周 vs 上周：本周 ' + s.thisWeekCount + ' 个，上周 ' + s.lastWeekCount
               + ' 个，变化 ' + trend);
      } else {
        L.push('- 本周 vs 上周：本周 ' + s.thisWeekCount + ' 个，上周暂无数据');
      }
      L.push('- 累计：' + s.totalCount + ' 个番茄 / ' + s.totalMinutes + ' 分钟 / '
             + s.activeDays + ' 个活跃日，累计中断 ' + s.totalInterrupts + ' 次');
      L.push('- 活跃日均：' + s.avgPerActiveDay + ' 个，近 7 日均：' + s.avgLast7 + ' 个');
      L.push('- 目标达成率：' + s.goalMetRate + '%（' + s.goalMetDays + '/' + s.activeDays + ' 天）');
      if (s.bestHour !== null) {
        L.push('- 最高效时段：' + s.bestHour + ':00–' + (s.bestHour + 1) + ':00'
               + '（近 30 天在此完成 ' + s.bestHourCount + ' 个）');
      }
      L.push('');

      L.push('## 近 14 天');
      L.push('');
      L.push('| 日期 | 番茄 | 分钟 | 达标 |');
      L.push('|---|---|---|---|');
      days.forEach(function (d) {
        L.push('| ' + d.label + ' | ' + d.count + ' | ' + d.minutes + ' | '
               + (d.goalMet ? '是' : '') + ' |');
      });
      L.push('');

      L.push('## 时段分布（近 30 天）');
      L.push('');
      var maxH = 1;
      hist.forEach(function (b) { if (b.count > maxH) maxH = b.count; });
      hist.forEach(function (b) {
        if (b.count === 0) return;
        var barLen = Math.round((b.count / maxH) * 20);
        var bar = '';
        for (var i = 0; i < barLen; i++) bar += '█';
        L.push('`' + pad(b.hour + ':00', 6) + '` ' + bar + ' ' + b.count);
      });
      L.push('');

      if (tasks.length) {
        L.push('## 任务耗时占比（近 30 天）');
        L.push('');
        L.push('| 任务 | 番茄 | 分钟 | 占比 |');
        L.push('|---|---|---|---|');
        tasks.forEach(function (x) {
          L.push('| ' + x.task + ' | ' + x.count + ' | ' + x.minutes + ' | '
                 + Math.round(x.share * 100) + '% |');
        });
        L.push('');
      }

      var active = t.list.filter(function (x) { return !x.archived; });
      if (active.length) {
        L.push('## 当前任务');
        L.push('');
        L.push('| 任务 | 状态 | 已投入 | 预估 | 优先级 |');
        L.push('|---|---|---|---|---|');
        active.forEach(function (x) {
          L.push('| ' + x.title + ' | ' + (x.done ? '已完成' : '进行中') + ' | '
                 + x.pomodoros + ' | ' + (x.estimate || '-') + ' | ' + x.priority + ' |');
        });
        L.push('');
      }

      return L.join('\n');
    }
  };

  global.PomodoroStore = Store;
})(window);
