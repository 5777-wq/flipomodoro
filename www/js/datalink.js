/**
 * 数据外链层：把 app 的数据写到手机共享存储，让外部 agent 能读到
 *
 * 为什么需要这一层：
 *   localStorage 在 WebView 里，落盘位置是 app 私有沙箱
 *   （/data/data/com.fiftyseven.pomodoro/...），非 root 的外部程序读不到。
 *   所以每次数据变化时，往公共 Documents 目录写一份快照。
 *
 * 写三个文件到 Documents/PomodoroData/：
 *   pomodoro-data.json     完整结构化数据（agent 首选，含 summary 和 charts）
 *   pomodoro-report.md     人类可读报告（agent 也能直接理解）
 *   pomodoro-latest.json   极简当前状态（轮询用，体积小）
 *
 * 固定文件名而不是带时间戳：agent 只需记住一个路径，
 * 每次覆盖写入即可拿到最新数据。历史数据本来就在 json 里。
 */
(function (global) {
  'use strict';

  var Store = global.PomodoroStore;

  /**
   * agent 数据外链总开关（埋坑）。
   * 当前版本不在界面露出任何入口，autoSync() 也直接短路，
   * 避免对普通用户产生"悄悄写文件"的隐性行为。
   * 之后要做 agent 联动时，把这里改成 true 并恢复数据页 UI 即可，
   * 本文件的写入、目录回退、readBack 全部保持可用。
   */
  var ENABLED = false;

  var BASE_DIR = 'PomodoroData';
  // 卸载重装后 Documents/PomodoroData 可能属于旧 uid（scoped storage），
  // 新安装写不进去（EACCES）。此时自动换下一个目录名，并在
  // localStorage 里记住，后续直接用。agent 从 latest.json 的 dataFile
  // 字段或 app 的数据页都能看到实际路径。
  var DIR_KEY = 'pomodoro_datadir';
  var dir = null;            // 当前实际使用的目录名
  var triedFallbacks = 0;

  // Documents 是共享目录，文件管理器和 adb pull 都能访问
  var DIRECTORY = 'DOCUMENTS';
  var ENCODING = 'utf8';

  var Cap = global.Capacitor || null;

  function fs() {
    return (Cap && Cap.Plugins && Cap.Plugins.Filesystem) ? Cap.Plugins.Filesystem : null;
  }

  function isNative() {
    return !!(Cap && Cap.isNativePlatform && Cap.isNativePlatform());
  }

  var lastError = null;
  var lastWriteAt = 0;
  var writing = false;
  var pendingAgain = false;

  function currentDir() {
    if (dir === null) {
      // 记住上次成功用的目录；没有就用基础名
      try { dir = localStorage.getItem(DIR_KEY) || BASE_DIR; } catch (e) { dir = BASE_DIR; }
    }
    return dir;
  }

  function file(name) { return currentDir() + '/' + name; }

  function rememberDir(name) {
    dir = name;
    try { localStorage.setItem(DIR_KEY, name); } catch (e) { /* 隐私模式忽略 */ }
  }

  /** EACCES（旧 uid 的目录）→ 换下一个候选目录。最多试 5 个 */
  function isAccessDenied(msg) { return /EACCES|Permission denied/i.test(msg); }

  function bumpDir() {
    triedFallbacks++;
    if (triedFallbacks > 5) return false;
    rememberDir(BASE_DIR + '-' + (triedFallbacks + 1));   // PomodoroData-2, -3...
    return true;
  }

  function ensureDir() {
    var F = fs();
    if (!F || !F.mkdir) return Promise.resolve(false);
    return F.mkdir({ path: currentDir(), directory: DIRECTORY, recursive: true })
      .then(function () { return true; })
      .catch(function (e) {
        // 已存在会抛错，这是正常情况，不算失败
        var msg = (e && e.message) ? String(e.message) : '';
        if (/exist/i.test(msg)) return true;
        lastError = msg || 'mkdir failed';
        return false;
      });
  }

  function writeFile(path, data) {
    var F = fs();
    if (!F || !F.writeFile) return Promise.resolve(false);
    return F.writeFile({
      path: path,
      data: data,
      directory: DIRECTORY,
      encoding: ENCODING,
      recursive: true
    }).then(function () { return true; })
      .catch(function (e) {
        lastError = (e && e.message) ? String(e.message) : 'write failed';
        return false;
      });
  }

  var API = {
    DIR: BASE_DIR,
    FILE_JSON: 'pomodoro-data.json',
    FILE_MD: 'pomodoro-report.md',
    FILE_LATEST: 'pomodoro-latest.json',

    enabled: function () { return ENABLED; },
    /**
     * 仅限自动化测试与将来恢复埋坑时使用，UI 永远不该调它。
     * 存在的意义：让写文件管线（目录回退、三文件、readBack）
     * 在 ENABLED=false 的默认状态下依然有测试覆盖。
     */
    _setEnabled: function (v) { ENABLED = !!v; },
    available: function () { return ENABLED && isNative() && !!fs(); },
    lastError: function () { return lastError; },
    lastWriteAt: function () { return lastWriteAt; },
    currentDir: function () { return currentDir(); },

    /**
     * 把当前数据写出去。
     * @returns {Promise<boolean>} 是否全部写成功
     */
    sync: function () {
      if (!API.available()) return Promise.resolve(false);

      // 同一时刻只允许一次写入，避免快速连续触发时互相覆盖到一半。
      // 期间又来请求就记一个标记，本次写完再补一次。
      if (writing) { pendingAgain = true; return Promise.resolve(false); }
      writing = true;
      lastError = null;

      var dump = Store.exportAll();
      var latest = {
        exportedAt: dump.exportedAt,
        exportedAtMs: dump.exportedAtMs,
        today: {
          date: Store.dayKey(),
          count: dump.summary.todayCount,
          minutes: dump.summary.todayMinutes,
          goal: dump.summary.dailyGoal,
          goalMet: dump.summary.goalMet
        },
        streak: dump.summary.streak,
        totalCount: dump.summary.totalCount,
        totalMinutes: dump.summary.totalMinutes,
        activeTask: (function () {
          var t = dump.tasks;
          if (!t.activeId) return null;
          for (var i = 0; i < t.list.length; i++) {
            if (t.list[i].id === t.activeId) return t.list[i].title;
          }
          return null;
        })(),
        dataFile: 'Documents/' + currentDir() + '/pomodoro-data.json',
        reportFile: 'Documents/' + currentDir() + '/pomodoro-report.md'
      };

      return ensureDir()
        .then(function () {
          return Promise.all([
            writeFile(file('pomodoro-data.json'), JSON.stringify(dump, null, 2)),
            writeFile(file('pomodoro-report.md'), Store.exportMarkdown()),
            writeFile(file('pomodoro-latest.json'), JSON.stringify(latest, null, 2))
          ]);
        })
        .then(function (res) {
          var ok = res.every(Boolean);
          // 全部因权限失败 → 换个目录名再试一次（旧 uid 目录的场景）
          if (!ok && isAccessDenied(lastError || '') && res.every(function (r) { return !r; })) {
            if (bumpDir()) {
              writing = false;
              return API.sync();
            }
          }
          if (ok) lastWriteAt = Date.now();
          writing = false;
          if (pendingAgain) { pendingAgain = false; return API.sync(); }
          return ok;
        })
        .catch(function (e) {
          lastError = (e && e.message) ? String(e.message) : 'sync failed';
          writing = false;
          pendingAgain = false;
          return false;
        });
    },

    /** 只在设置里开了 autoExport 时才自动同步 */
    autoSync: function () {
      if (!Store.loadSettings().autoExport) return Promise.resolve(false);
      return API.sync();
    },

    /** 读回已写出的文件，用于自检"agent 确实能读到" */
    readBack: function () {
      var F = fs();
      if (!F || !F.readFile) return Promise.resolve(null);
      return F.readFile({ path: file('pomodoro-latest.json'), directory: DIRECTORY, encoding: ENCODING })
        .then(function (r) { return r && r.data ? String(r.data) : null; })
        .catch(function () { return null; });
    },

    /** 供 UI 显示的绝对路径提示 */
    hintPath: function () {
      return '手机存储/Documents/' + currentDir() + '/';
    }
  };

  global.PomodoroDataLink = API;
})(window);
