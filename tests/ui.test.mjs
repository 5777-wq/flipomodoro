/**
 * UI 层集成回归测试
 *
 * 用 jsdom 加载真实的 index.html + 全部 5 个 js，注入假的 Capacitor 插件，
 * 验证跨模块接线。重点覆盖真机上验过的那些行为，防止回退。
 * 跑法：node tests/ui.test.mjs   （或 npm test）
 */
import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';

const ROOT = path.resolve(import.meta.dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'www/index.html'), 'utf8');
// 顺序必须和 index.html 里一致：store/charts/datalink 是被依赖方
const files = ['store.js', 'charts.js', 'datalink.js', 'audio.js', 'noise.js',
               'flipclock.js', 'native.js', 'timer.js', 'ui.js']
  .map((f) => fs.readFileSync(path.join(ROOT, 'www/js', f), 'utf8'));

let NOW = new Date('2026-08-26T10:00:00').getTime();

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
}

/**
 * @param {object} opts
 *   storage        跨实例共享的 Map（模拟刷新）
 *   notifyGranted  false 表示用户拒绝通知权限
 *   permCheck      checkPermissions 返回的初始状态
 */
function makeApp(opts = {}) {
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;

  const RealDate = w.Date;
  w.Date = class extends RealDate {
    constructor(...a) { super(...(a.length ? a : [NOW])); }
    static now() { return NOW; }
  };

  const store = opts.storage || new Map();
  Object.defineProperty(w, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
  });

  const timers = new Map();
  let seq = 1;
  w.setInterval = (fn, ms) => { const id = seq++; timers.set(id, { fn, ms }); return id; };
  w.clearInterval = (id) => timers.delete(id);
  const realTimeout = w.setTimeout;
  w.setTimeout = (fn) => realTimeout(fn, 0);
  w.requestAnimationFrame = (fn) => realTimeout(() => fn(NOW), 0);

  const audioCalls = [];
  const noiseNodes = { buffers: 0, sources: 0, started: 0 };
  w.AudioContext = class {
    constructor() { this.state = 'running'; this.currentTime = 0; this.destination = {}; }
    resume() { this.state = 'running'; return Promise.resolve(); }
    createBuffer(channels, frames) { noiseNodes.buffers++; return { getChannelData: () => new Float32Array(frames) }; }
    createBufferSource() {
      noiseNodes.sources++;
      return { buffer: null, loop: false, connect() {}, start() { noiseNodes.started++; }, stop() {}, disconnect() {} };
    }
    createBiquadFilter() {
      return { type: '', frequency: { value: 0 }, Q: { value: 0 },
               connect() {}, disconnect() {} };
    }
    createOscillator() {
      return { type: '', frequency: { value: 0, setValueAtTime() {} },
               connect() {}, disconnect() {},
               start(t) { if (t !== undefined) audioCalls.push(t); }, stop() {} };
    }
    createGain() {
      return { gain: { value: 1, setValueAtTime() {}, linearRampToValueAtTime() {},
                       cancelScheduledValues() {}, exponentialRampToValueAtTime() {} },
               connect() {}, disconnect() {} };
    }
  };

  const calls = { schedule: [], cancel: [], impact: [], notification: [],
                  perms: 0, checks: 0, exit: 0, mkdir: 0, writes: [] };
  const listeners = {};
  // 假的文件系统：写入内容留在内存里，测试可以断言真的写了什么
  const fsFiles = new Map();
  w.Capacitor = {
    isNativePlatform: () => opts.native !== false,
    Plugins: {
      Filesystem: opts.noFs ? undefined : {
        mkdir: () => { calls.mkdir++; return Promise.resolve(); },
        writeFile: (o) => {
          if (opts.writeFails) return Promise.reject(new Error('quota exceeded'));
          calls.writes.push(o.path);
          fsFiles.set(o.path, o.data);
          return Promise.resolve();
        },
        readFile: (o) => (fsFiles.has(o.path)
          ? Promise.resolve({ data: fsFiles.get(o.path) })
          : Promise.reject(new Error('not found'))),
      },
      LocalNotifications: {
        checkPermissions: () => {
          calls.checks++;
          return Promise.resolve({ display: opts.permCheck || 'prompt' });
        },
        checkExactNotificationSetting: () => {
          calls.exactCheck = (calls.exactCheck || 0) + 1;
          return Promise.resolve({ value: opts.exactAlarm || 'enabled' });
        },
        requestPermissions: () => {
          calls.perms++;
          return Promise.resolve({ display: opts.notifyGranted === false ? 'denied' : 'granted' });
        },
        schedule: (o) => { calls.schedule.push(o.notifications[0]); return Promise.resolve(); },
        cancel: (o) => { calls.cancel.push(o.notifications[0].id); return Promise.resolve(); },
      },
      Haptics: {
        impact: (o) => { calls.impact.push(o.style); return Promise.resolve(); },
        notification: (o) => { calls.notification.push(o.type); return Promise.resolve(); },
      },
      StatusBar: {
        setStyle: () => Promise.resolve(),
        setBackgroundColor: () => Promise.resolve(),
        setOverlaysWebView: () => Promise.resolve(),
      },
      App: {
        addListener: (ev, fn) => { listeners[ev] = fn; return Promise.resolve(); },
        exitApp: () => { calls.exit++; },
      },
    },
  };

  const wake = { requested: 0, released: 0, held: false };
  w.navigator.wakeLock = {
    request: () => {
      wake.requested++; wake.held = true;
      return Promise.resolve({
        release: () => { wake.released++; wake.held = false; return Promise.resolve(); },
        addEventListener: () => {},
      });
    },
  };

  w.matchMedia = () => ({ matches: false, addEventListener() {}, addListener() {} });
  w.URL.createObjectURL = () => 'blob:fake';
  w.URL.revokeObjectURL = () => {};

  for (const src of files) w.eval(src);

  return { w, calls, listeners, timers, wake, audioCalls, noiseNodes, fsFiles,
           $: (id) => w.document.getElementById(id) };
}

function advance(app, ms, step = 250) {
  let left = ms;
  while (left > 0) {
    const d = Math.min(step, left);
    NOW += d;
    for (const t of [...app.timers.values()]) t.fn();
    left -= d;
  }
}

const flush = () => new Promise((r) => setTimeout(r, 5));

console.log('\n[A] 启动与默认状态');
{
  const app = makeApp();
  await flush();
  check('时间显示 25:00', app.$('timeDisplay').textContent === '25:00');
  check('默认自由专注', app.$('activeTaskLabel').textContent === '自由专注');
  check('重置按钮禁用', app.$('resetBtn').disabled === true);
  check('轮次点 4 个', app.$('roundDots').children.length === 4);
  check('冷启动静默查权限（不弹窗）', app.calls.checks === 1 && app.calls.perms === 0,
        `checks=${app.calls.checks} perms=${app.calls.perms}`);
}

console.log('\n[B] 通知在【开始】时调度，停止时取消');
{
  const app = makeApp();
  await flush();
  app.calls.schedule.length = 0;
  app.$('startBtn').click();
  await flush(); await flush(); await flush();

  check('点开始申请权限', app.calls.perms === 1, app.calls.perms);
  check('调度了通知', app.calls.schedule.length >= 1, app.calls.schedule.length);
  const n = app.calls.schedule[0];
  check('标题「专注结束」', n && n.title === '专注结束', n && n.title);
  check('内容「休息一下吧」', n && n.body === '休息一下吧', n && n.body);
  check('按 25 分钟后调度',
        n && Math.abs(new Date(n.schedule.at).getTime() - (NOW + 25 * 60000)) < 2000);
  check('allowWhileIdle 开启', n && n.schedule.allowWhileIdle === true);
  check('用 ic_stat_icon', n && n.smallIcon === 'ic_stat_icon');

  app.calls.cancel.length = 0;
  app.$('startBtn').click();     // 暂停
  await flush();
  check('暂停时按 id 取消', app.calls.cancel.length >= 1);
  check('取消的是数字 id', typeof app.calls.cancel[0] === 'number');
}

console.log('\n[C] 权限申请期间不重复调度（真机上叠弹窗的回归）');
{
  const app = makeApp();
  await flush();
  app.calls.schedule.length = 0;
  app.$('startBtn').click();
  // 权限 promise 还没 resolve 时不应该有任何 schedule
  check('申请期间零调度', app.calls.schedule.length === 0, app.calls.schedule.length);
  await flush(); await flush(); await flush();
  check('权限落地后才调度一次', app.calls.schedule.length === 1, app.calls.schedule.length);
}

console.log('\n[D] 已授权则不再申请');
{
  const app = makeApp({ permCheck: 'granted' });
  await flush(); await flush();
  app.$('startBtn').click();
  await flush(); await flush();
  check('不重复弹窗', app.calls.perms === 0, app.calls.perms);
  check('仍然正常调度', app.calls.schedule.length >= 1, app.calls.schedule.length);
}

console.log('\n[E] 明确被拒后不再尝试调度');
{
  const app = makeApp({ permCheck: 'denied' });
  await flush(); await flush();
  app.calls.schedule.length = 0;
  app.$('startBtn').click();
  await flush(); await flush();
  check('不再弹窗', app.calls.perms === 0, app.calls.perms);
  check('不做无效调度', app.calls.schedule.length === 0, app.calls.schedule.length);
  check('计时照常', app.w.PomodoroTimer.get().running === true);
}

console.log('\n[F] 完成专注 → 统计 + 任务 +1');
{
  const storage = new Map();
  const app = makeApp({ storage });
  await flush();

  app.$('taskInput').value = '写代码';
  app.$('taskAddForm').dispatchEvent(new app.w.Event('submit', { cancelable: true, bubbles: true }));
  await flush();
  check('任务已添加', app.$('taskList').children.length === 1);

  app.$('taskList').querySelector('[data-act="focus"]').click();
  await flush();
  check('任务选为当前专注', app.$('activeTaskLabel').textContent === '写代码');

  app.w.PomodoroTimer.setSetting('focusMin', 1);
  await flush();
  app.$('startBtn').click();
  await flush();
  advance(app, 61_000);
  await flush(); await flush();

  const rec = app.w.PomodoroStore.todayRecord();
  check('今日完成 +1', rec.count === 1, JSON.stringify(rec));
  check('专注分钟 +1', rec.minutes === 1);
  check('归到任务名下', rec.tasks['写代码'] === 1, JSON.stringify(rec.tasks));
  check('底部计数刷新', app.$('todayCount').textContent === '1');
  check('任务番茄 +1', app.w.PomodoroStore.loadTasks().list[0].pomodoros === 1);
  check('已切短休息', app.w.PomodoroTimer.get().phase === 'short');
  check('结束时震动', app.calls.notification.length >= 1);
  check('结束音三声（两短一长）', app.audioCalls.length >= 3, app.audioCalls.length);

  const app2 = makeApp({ storage });
  await flush();
  check('刷新后统计仍在', app2.$('todayCount').textContent === '1');
  check('刷新后任务番茄仍在', app2.w.PomodoroStore.loadTasks().list[0].pomodoros === 1);
  check('刷新后仍选中任务', app2.$('activeTaskLabel').textContent === '写代码');
}

console.log('\n[G] 拒绝通知权限后照常计时');
{
  const app = makeApp({ notifyGranted: false });
  await flush();
  app.$('startBtn').click();
  await flush(); await flush(); await flush();
  check('权限被拒不影响计时', app.w.PomodoroTimer.get().running === true);
  advance(app, 5_000);
  check('计时正常推进', app.$('timeDisplay').textContent === '24:55',
        app.$('timeDisplay').textContent);
  check('给了提示', app.$('toast').textContent.includes('无法在后台提醒'));
  check('设置页说明更新', app.$('notifyNote').textContent.includes('拒绝'));
}

console.log('\n[H] 声音开关刷新后保持');
{
  const storage = new Map();
  const app = makeApp({ storage });
  await flush();
  app.$('soundToggle').checked = false;
  app.$('soundToggle').dispatchEvent(new app.w.Event('change', { bubbles: true }));
  await flush();
  check('声音已关', app.w.PomodoroTimer.getSettings().sound === false);

  const app2 = makeApp({ storage });
  await flush();
  check('刷新后仍是关', app2.w.PomodoroTimer.getSettings().sound === false);
  check('开关回显为关', app2.$('soundToggle').checked === false);

  app2.w.PomodoroTimer.setSetting('focusMin', 1);
  await flush();
  app2.audioCalls.length = 0;
  app2.$('startBtn').click();
  await flush();
  advance(app2, 61_000);
  await flush();
  check('关声音后不发声', app2.audioCalls.length === 0, app2.audioCalls.length);
}

console.log('\n[I] Back 键行为');
{
  const app = makeApp();
  await flush();
  const back = app.listeners['backButton'];
  check('已注册 backButton', typeof back === 'function');

  app.$('settingsBtn').click();
  await flush();
  check('设置弹层打开', app.$('sheet').classList.contains('open'));
  back();
  await flush();
  check('Back 先关弹层', !app.$('sheet').classList.contains('open'));
  check('关弹层不退出', app.calls.exit === 0);

  back();
  await flush();
  check('主界面首次只提示', app.calls.exit === 0);
  check('提示文案正确', app.$('toast').textContent === '再按一次退出');

  NOW += 500;
  back();
  await flush();
  check('2 秒内再按退出', app.calls.exit === 1);

  const app2 = makeApp();
  await flush();
  const back2 = app2.listeners['backButton'];
  back2(); await flush();
  NOW += 3000;
  back2(); await flush();
  check('超 2 秒不退出（重新计时）', app2.calls.exit === 0);
}

console.log('\n[J] 防息屏 wakeLock');
{
  const app = makeApp();
  await flush();
  check('未开始不持锁', app.wake.requested === 0);
  app.$('startBtn').click();
  await flush(); await flush();
  check('专注中持锁', app.wake.requested >= 1);
  app.$('startBtn').click();
  await flush(); await flush();
  check('暂停后释放', app.wake.released >= 1);

  const app2 = makeApp();
  await flush();
  app2.w.PomodoroTimer.setSetting('focusMin', 1);
  await flush();
  app2.$('startBtn').click();
  await flush();
  advance(app2, 61_000);
  await flush(); await flush();
  app2.$('startBtn').click();     // 开始休息
  await flush(); await flush();
  check('休息阶段不持锁', app2.wake.held === false);
}

console.log('\n[K] 后台恢复校准');
{
  const app = makeApp();
  await flush();
  app.$('startBtn').click();
  await flush();
  advance(app, 10_000);
  check('前台 10 秒后 24:50', app.$('timeDisplay').textContent === '24:50');
  NOW += 60_000;                  // 冻结
  const st = app.listeners['appStateChange'];
  check('已注册 appStateChange', typeof st === 'function');
  st({ isActive: true });
  await flush();
  check('回前台准确扣 60 秒', app.$('timeDisplay').textContent === '23:50',
        app.$('timeDisplay').textContent);
}

console.log('\n[L] 统计面板渲染');
{
  const storage = new Map();
  const seed = makeApp({ storage });
  await flush();
  seed.w.PomodoroStore.saveRecords({
    '2026-08-24': { count: 2, minutes: 50, tasks: { 读书: 2 } },
    '2026-08-25': { count: 3, minutes: 75, tasks: { 写代码: 3 } },
    '2026-08-26': { count: 4, minutes: 100, tasks: { 写代码: 3, 读书: 1 } },
  });
  // 最近记录列表读的是 sessions 流水，一起种进去
  seed.w.PomodoroStore.saveSessions([
    { at: 1756000000000, day: '2026-08-24', hour: 9, min: 25, task: '读书', taskId: null, interrupts: 0 },
    { at: 1756080000000, day: '2026-08-25', hour: 10, min: 25, task: '写代码', taskId: null, interrupts: 1 },
    { at: 1756160000000, day: '2026-08-26', hour: 8, min: 25, task: '写代码', taskId: null, interrupts: 0 },
    { at: 1756164000000, day: '2026-08-26', hour: 9, min: 25, task: '读书', taskId: null, interrupts: 0 },
    { at: 1756170000000, day: '2026-08-26', hour: 10, min: 25, task: '写代码', taskId: null, interrupts: 0 },
  ]);
  const app = makeApp({ storage });
  await flush();
  app.$('panelBtn').click();
  await flush();

  check('今日番茄 4', app.$('statToday').textContent === '4');
  check('专注分钟 100', app.$('statMinutes').textContent === '100');
  check('连续天数 3', app.$('statStreak').textContent === '3');
  check('柱状图 7 根', app.$('weekChart').children.length === 7);

  const scales = [...app.$('weekChart').querySelectorAll('.bar-fill')]
    .map((f) => f.style.transform);
  check('只用 transform: scaleY', scales.every((s) => s.startsWith('scaleY(')), scales.join(' '));
  check('最高柱 scaleY(1)', scales.includes('scaleY(1)'), scales.join(' '));
  check('今天高亮一根',
        [...app.$('weekChart').children].filter((c) => c.classList.contains('is-today')).length === 1);

  const detail = app.$('recentList').textContent;
  check('最近记录含任务名', detail.includes('写代码'));
  check('最近记录含第二个任务', detail.includes('读书'));
  check('最近记录带分钟数', detail.includes('25 分'));
  check('最近记录最多 8 条',
        [...app.$('recentList').querySelectorAll('.detail-name')].length === 5);

  // 图表切换器：默认 30 天趋势
  check('默认趋势图有 SVG', !!app.$('mainChart').querySelector('svg'));
  app.$('chartTabs').querySelector('[data-chart="donut"]').click();
  await flush();
  check('切到占比（饼图）', !!app.$('mainChart').querySelector('.donut-svg'),
        app.$('mainChart').innerHTML.slice(0, 80));
  check('饼图有图例', !!app.$('mainChart').querySelector('.donut-legend'));
  app.$('chartTabs').querySelector('[data-chart="week"]').click();
  await flush();
  check('切到星期柱状图', !!app.$('mainChart').querySelector('rect'));
  app.$('chartTabs').querySelector('[data-chart="rank"]').click();
  await flush();
  check('切到排行条形图', !!app.$('mainChart').querySelector('.tbar-row'));
  app.$('chartTabs').querySelector('[data-chart="hours"]').click();
  await flush();
  check('切到时段热图', !!app.$('mainChart').querySelector('.heat-cell'));
  app.$('chartTabs').querySelector('[data-chart="trend"]').click();
  await flush();

  // 范围切换：7 天生效且状态同步
  app.$('rangeTabs').querySelector('[data-range="7"]').click();
  await flush();
  check('切到 7 天范围', app.$('rangeTabs').querySelector('[data-range="7"]')
        .classList.contains('active'));
  check('范围说明文案在', app.$('chartNote').textContent.length > 0);
}

console.log('\n[M] 导出 JSON');
{
  const app = makeApp();
  await flush();
  app.w.PomodoroStore.addCompletion(25, '写代码');
  let clicked = null;
  const orig = app.w.document.createElement.bind(app.w.document);
  app.w.document.createElement = (tag) => {
    const e = orig(tag);
    if (tag === 'a') e.click = () => { clicked = { href: e.href, name: e.download }; };
    return e;
  };
  app.$('exportBtn').click();
  await flush();
  check('触发下载', !!clicked);
  check('文件名带日期', clicked && /pomodoro-\d{4}-\d{2}-\d{2}\.json/.test(clicked.name));
  check('用 blob URL', clicked && clicked.href.startsWith('blob:'));
  check('有成功提示', app.$('toast').textContent.includes('已导出'));
}

/** 按标题找到任务行。不能用 children[i]，因为列表会按优先级/完成态重排 */
function rowByTitle(app, title, listId) {
  const list = app.$(listId || 'taskList');
  const nodes = list.querySelectorAll('.task-item');
  for (const li of nodes) {
    const t = li.querySelector('.task-title');
    if (t && t.textContent === title) return li;
  }
  return null;
}

function addTask(app, title, opts = {}) {
  app.$('taskInput').value = title;
  if (opts.estimate != null) app.$('newEstimate').textContent = String(opts.estimate);
  if (opts.focusMin != null) app.$('newFocusMin').textContent = String(opts.focusMin);
  if (opts.priority) app.$('newPriority').value = opts.priority;
  app.$('taskAddForm').dispatchEvent(new app.w.Event('submit', { cancelable: true, bubbles: true }));
}

console.log('\n[N] 任务增删勾选');
{
  const storage = new Map();
  const app = makeApp({ storage });
  await flush();
  for (const name of ['任务A', '任务B']) { addTask(app, name); await flush(); }
  check('两个任务', app.$('taskList').children.length === 2);

  rowByTitle(app, '任务A').querySelector('[data-act="toggle"]').click();
  await flush();
  check('标记完成', rowByTitle(app, '任务A').classList.contains('done'));
  // 已完成的排到末尾，是刻意的排序行为
  check('完成的任务排到末尾',
        app.$('taskList').children[1].querySelector('.task-title').textContent === '任务A',
        app.$('taskList').children[1].querySelector('.task-title').textContent);

  rowByTitle(app, '任务B').querySelector('[data-act="focus"]').click();
  await flush();
  check('任务B 成为当前专注', app.$('activeTaskLabel').textContent === '任务B');

  rowByTitle(app, '任务B').querySelector('[data-act="del"]').click();
  await flush();
  check('删除后剩一个', app.$('taskList').children.length === 1);
  check('删掉当前专注回落自由专注', app.$('activeTaskLabel').textContent === '自由专注');

  const app2 = makeApp({ storage });
  await flush();
  check('刷新后删除生效', app2.$('taskList').children.length === 1);
  check('刷新后勾选态保留', rowByTitle(app2, '任务A').classList.contains('done'));
}

console.log('\n[Q] 任务优先级排序与预估');
{
  const storage = new Map();
  const app = makeApp({ storage });
  await flush();
  addTask(app, '普通事'); await flush();
  addTask(app, '紧急事', { priority: 'high' }); await flush();
  addTask(app, '不急事', { priority: 'low' }); await flush();

  const order = [...app.$('taskList').querySelectorAll('.task-title')].map((x) => x.textContent);
  check('高优先级排最前', order[0] === '紧急事', order.join(','));
  check('低优先级排最后', order[2] === '不急事', order.join(','));
  check('高优先级有色条标记',
        rowByTitle(app, '紧急事').classList.contains('prio-high'));

  addTask(app, '带预估', { estimate: 4 }); await flush();
  const t = app.w.PomodoroStore.loadTasks().list.filter((x) => x.title === '带预估')[0];
  check('预估已保存', t && t.estimate === 4, t && t.estimate);
  check('预估进度条已渲染', !!rowByTitle(app, '带预估').querySelector('.est-track'));

  const app2 = makeApp({ storage });
  await flush();
  const t2 = app2.w.PomodoroStore.loadTasks().list.filter((x) => x.title === '带预估')[0];
  check('刷新后预估保留', t2 && t2.estimate === 4);
  check('刷新后优先级保留',
        app2.w.PomodoroStore.loadTasks().list.filter((x) => x.title === '紧急事')[0].priority === 'high');
}

console.log('\n[R] 任务归档');
{
  const storage = new Map();
  const app = makeApp({ storage });
  await flush();
  addTask(app, '要归档的'); await flush();
  addTask(app, '留着的'); await flush();

  rowByTitle(app, '要归档的').querySelector('[data-act="focus"]').click();
  await flush();
  check('先设为当前专注', app.$('activeTaskLabel').textContent === '要归档的');

  rowByTitle(app, '要归档的').querySelector('[data-act="archive"]').click();
  await flush();
  check('归档后主列表只剩一个', app.$('taskList').children.length === 1);
  check('归档后回落自由专注', app.$('activeTaskLabel').textContent === '自由专注');
  check('归档区出现', app.$('archiveHead').hidden === false);
  check('归档计数正确', app.$('archiveCount').textContent === '(1)',
        app.$('archiveCount').textContent);

  app.$('toggleArchive').click();
  await flush();
  check('展开后能看到归档任务',
        !!rowByTitle(app, '要归档的', 'archiveList'), app.$('archiveList').innerHTML.length);

  rowByTitle(app, '要归档的', 'archiveList').querySelector('[data-act="unarchive"]').click();
  await flush();
  check('取消归档后回到主列表', app.$('taskList').children.length === 2);
  check('归档区隐藏', app.$('archiveHead').hidden === true);

  const app2 = makeApp({ storage });
  await flush();
  check('刷新后归档态保留（已取消）',
        app2.w.PomodoroStore.loadTasks().list.every((t) => !t.archived));
}

console.log('\n[O] 任务名不被当作 HTML');
{
  const app = makeApp();
  await flush();
  app.$('taskInput').value = '<img src=x onerror=alert(1)>危险';
  app.$('taskAddForm').dispatchEvent(new app.w.Event('submit', { cancelable: true, bubbles: true }));
  await flush();
  const el = app.$('taskList').querySelector('.task-title');
  check('按纯文本渲染', el.querySelector('img') === null, el.innerHTML.slice(0, 50));
  check('文本完整保留', el.textContent.includes('危险'));
}

console.log('\n[P] 按压震动反馈');
{
  const app = makeApp();
  await flush();
  app.calls.impact.length = 0;
  app.$('startBtn').click();
  await flush();
  check('开始有震动', app.calls.impact.length >= 1);
  check('用 MEDIUM', app.calls.impact.includes('MEDIUM'), app.calls.impact.join(','));

  app.calls.impact.length = 0;
  app.$('skipBtn').click();
  await flush();
  check('跳过有震动', app.calls.impact.length >= 1);

  app.w.PomodoroTimer.setSetting('vibrate', false);
  await flush();
  app.calls.impact.length = 0;
  app.$('resetBtn').click();
  await flush();
  check('关震动后不震', app.calls.impact.length === 0);
}

console.log('\n[S] agent 数据外链：写文件到共享目录（默认关闭，测试内显式开启）');
{
  const app = makeApp();
  await flush();
  const DL = app.w.PomodoroDataLink;
  check('默认关闭', DL.enabled() === false);
  DL._setEnabled(true);          // 测试钩子：恢复埋坑时 UI 也会走这条路径
  check('显式开启后可用', DL.available() === true);

  const ok = await DL.sync();
  check('sync 成功', ok === true, `err=${DL.lastError()}`);
  check('建了目录', app.calls.mkdir >= 1);
  check('写了 3 个文件', app.calls.writes.length === 3, app.calls.writes.join(','));
  check('含完整数据 json',
        app.calls.writes.some((p) => p.endsWith('pomodoro-data.json')), app.calls.writes.join(','));
  check('含 markdown 报告',
        app.calls.writes.some((p) => p.endsWith('pomodoro-report.md')));
  check('含轻量最新状态',
        app.calls.writes.some((p) => p.endsWith('pomodoro-latest.json')));
  check('路径在 PomodoroData 目录下',
        app.calls.writes.every((p) => p.indexOf('PomodoroData/') === 0), app.calls.writes.join(','));
  check('记录了写入时间', DL.lastWriteAt() > 0);

  // 写出的内容必须是 agent 能直接解析的
  const raw = app.fsFiles.get('PomodoroData/pomodoro-data.json');
  const parsed = JSON.parse(raw);
  check('json 可解析', !!parsed);
  check('带 schema 版本', parsed.schema === 2, parsed.schema);
  check('带字段说明 _readme', !!parsed._readme && !!parsed._readme.sessions);
  check('含 records', !!parsed.records);
  check('含 sessions', Array.isArray(parsed.sessions));
  check('含 summary', !!parsed.summary && typeof parsed.summary.totalCount === 'number');
  check('含图表序列', !!parsed.charts && Array.isArray(parsed.charts.last30Days));
  check('近30天序列长度 30', parsed.charts.last30Days.length === 30);
  check('时段直方图 24 格', parsed.charts.hourHistogram.length === 24);
  check('带时区偏移（agent 换算用）', typeof parsed.timezoneOffsetMin === 'number');

  const md = app.fsFiles.get('PomodoroData/pomodoro-report.md');
  check('markdown 有标题', md.indexOf('# 番茄钟数据报告') === 0, md.slice(0, 30));
  check('markdown 含总览', md.includes('## 总览'));

  const latest = JSON.parse(app.fsFiles.get('PomodoroData/pomodoro-latest.json'));
  check('latest 含今日数据', !!latest.today && typeof latest.today.count === 'number');
  check('latest 指明完整数据文件位置',
        latest.dataFile.includes('pomodoro-data.json'), latest.dataFile);

  const back = await DL.readBack();
  check('写出的文件能读回（agent 视角）', !!back && JSON.parse(back).today != null);
}

console.log('\n[T] agent 外链默认关闭（埋坑）+ session 落盘');
{
  const app = makeApp();
  await flush();
  check('外链总开关默认关闭', app.w.PomodoroDataLink.enabled() === false);

  addTask(app, '写代码'); await flush();
  rowByTitle(app, '写代码').querySelector('[data-act="focus"]').click();
  await flush();

  app.calls.writes.length = 0;
  app.w.PomodoroTimer.setSetting('focusMin', 1);
  await flush();
  app.$('startBtn').click();
  await flush();
  advance(app, 61_000);
  await flush(); await flush(); await flush();

  // 关闭状态下，完成番茄绝不悄悄写文件
  check('外链关闭时不写文件', app.calls.writes.length === 0, app.calls.writes.length);

  const sessions = app.w.PomodoroStore.loadSessions();
  check('落了一条 session', sessions.length === 1, sessions.length);
  check('session 带结束时间戳', sessions[0].at > 0);
  check('session 记了任务名', sessions[0].task === '写代码', sessions[0].task);
  check('session 关联了 taskId', !!sessions[0].taskId);
  check('session 记了时长', sessions[0].min === 1, sessions[0].min);
  check('session 记了小时', sessions[0].hour >= 0 && sessions[0].hour <= 23);

  // 时段直方图应该反映这条 session
  const hist = app.w.PomodoroStore.hourHistogram(30);
  const filled = hist.filter((b) => b.count > 0);
  check('直方图有一个非空时段', filled.length === 1, filled.length);
  check('直方图小时与 session 一致', filled[0].hour === sessions[0].hour);

  const bd = app.w.PomodoroStore.taskBreakdown(30);
  check('任务占比含该任务', bd.length === 1 && bd[0].task === '写代码', JSON.stringify(bd));
  check('占比 100%', bd[0].share === 1, bd[0].share);

  // 代码保留完整能力：显式开启后手动 sync 依然写出三个文件（埋坑恢复即用）
  check('关闭状态下 available 为 false', app.w.PomodoroDataLink.available() === false);
  app.w.PomodoroDataLink._setEnabled(true);
  const ok = await app.w.PomodoroDataLink.sync();
  check('手动 sync 可写', ok === true && app.calls.writes.length >= 3, app.calls.writes.length);
  check('写的是约定的三个文件',
        app.calls.writes.filter((p) => /pomodoro-(data\.json|report\.md|latest\.json)$/.test(p)).length === 3,
        app.calls.writes.join(','));
}

console.log('\n[U] 外链关闭时 autoSync 全程静默');
{
  const app = makeApp();
  await flush();
  app.calls.writes.length = 0;

  app.w.PomodoroTimer.setSetting('focusMin', 1);
  await flush();
  app.$('startBtn').click();
  await flush();
  advance(app, 61_000);
  await flush(); await flush();
  check('未写文件', app.calls.writes.length === 0, app.calls.writes.length);
  check('但统计照常记录', app.w.PomodoroStore.todayRecord().count === 1);
  const ok = await app.w.PomodoroDataLink.autoSync();
  check('autoSync 短路返回 false', ok === false);
}

console.log('\n[V] 写文件失败不崩溃');
{
  const app = makeApp({ writeFails: true });
  await flush();
  app.w.PomodoroDataLink._setEnabled(true);   // 失败路径需要管线真的跑起来
  const ok = await app.w.PomodoroDataLink.sync();
  check('返回失败而非抛错', ok === false);
  check('记录了错误信息', !!app.w.PomodoroDataLink.lastError());
  app.w.PomodoroTimer.setSetting('focusMin', 1);
  await flush();
  app.$('startBtn').click();
  await flush();
  advance(app, 61_000);
  await flush(); await flush();
  check('写失败不影响计时与统计', app.w.PomodoroStore.todayRecord().count === 1);
}

console.log('\n[W] 无 Filesystem 插件时静默降级（浏览器预览）');
{
  const app = makeApp({ noFs: true });
  await flush();
  check('available 为 false', app.w.PomodoroDataLink.available() === false);
  const ok = await app.w.PomodoroDataLink.sync();
  check('sync 返回 false 不抛错', ok === false);
  check('计时功能不受影响', app.w.PomodoroTimer.get().remainSec === 1500);
}

console.log('\n[X] 每日目标与洞察');
{
  const storage = new Map();
  const app = makeApp({ storage });
  await flush();
  app.$('panelBtn').click();
  await flush();

  check('默认目标 8', app.w.PomodoroTimer.getSettings().dailyGoal === 8);
  check('目标环已渲染', !!app.$('goalRingBox').querySelector('svg'));
  check('未开始时提示文案', app.$('goalDesc').textContent.includes('还没开始'),
        app.$('goalDesc').textContent);

  app.w.PomodoroStore.saveRecords({
    [app.w.PomodoroStore.dayKey()]: { count: 10, minutes: 250, tasks: { 写代码: 10 } },
  });
  app.w.PomodoroTimer.setSetting('dailyGoal', 8);
  await flush();
  app.$('tabStats').click();
  await flush();
  check('超额时显示已达成', app.$('goalTitle').textContent.includes('达成'),
        app.$('goalTitle').textContent);
  check('洞察列表非空', app.$('insightList').children.length > 0);
  check('洞察含累计数据', app.$('insightList').textContent.includes('累计'),
        app.$('insightList').textContent.slice(0, 60));

  const ins = app.w.PomodoroStore.insights();
  check('goalMet 为真', ins.goalMet === true);
  check('goalProgress 夹到 1', ins.goalProgress === 1, ins.goalProgress);

  const app2 = makeApp({ storage });
  await flush();
  check('目标设置刷新后保留', app2.w.PomodoroTimer.getSettings().dailyGoal === 8);
}

console.log('\n[Y] 分页切换');
{
  const app = makeApp();
  await flush();
  app.$('panelBtn').click();
  await flush();
  check('默认在统计页', app.$('pageStats').hidden === false && app.$('pageTasks').hidden === true);

  app.$('tabTasks').click();
  await flush();
  check('切到任务页', app.$('pageTasks').hidden === false);
  check('统计页隐藏', app.$('pageStats').hidden === true);
  check('tab 状态同步', app.$('tabTasks').getAttribute('aria-selected') === 'true');

  app.$('tabData').click();
  await flush();
  check('切到备份页', app.$('pageData').hidden === false);
  check('备份页有恢复入口', app.$('pageData').textContent.includes('从备份恢复'));
  check('备份页有导出入口', app.$('pageData').textContent.includes('下载 JSON 备份'));
  check('不再暴露文件路径', !app.$('pageData').textContent.includes('PomodoroData'));
  check('agent 自动导出入口已隐藏',
        app.$('autoExportToggle') === null && app.$('syncBtn') === null && app.$('syncStatus') === null);
}

console.log('\n[Z] 图表渲染与转义安全');
{
  const C = makeApp().w.PomodoroCharts;
  await flush();
  check('空数据不报错', C.trendLine([], 8).includes('还没有数据'));
  check('热图空数据不报错', C.hourHeatmap([]).includes('还没有数据'));
  check('任务条空数据不报错', C.taskBars([]).includes('还没有'));

  const svg = C.trendLine([
    { day: '2026-08-25', label: '8/25', count: 3, minutes: 75, goalMet: false },
    { day: '2026-08-26', label: '8/26', count: 9, minutes: 225, goalMet: true, isToday: true },
  ], 8);
  check('趋势图输出 svg', svg.includes('<svg') && svg.includes('polyline'));
  check('趋势图无 NaN 坐标', !svg.includes('NaN'), svg.slice(0, 120));

  const heat = C.hourHeatmap(Array.from({ length: 24 }, (_, h) => ({ hour: h, count: h, minutes: h })));
  check('热图 24 格', (heat.match(/heat-cell/g) || []).length === 24);
  check('热图无 NaN', !heat.includes('NaN'));

  // 任务名里的 HTML 必须被转义
  const bars = C.taskBars([{ task: '<img src=x onerror=alert(1)>', count: 3, minutes: 75, share: 1 }]);
  check('任务名已转义', !bars.includes('<img'), bars.slice(0, 100));
  check('转义成实体', bars.includes('&lt;img'));

  const ring = C.goalRing(0.5, 4, 8);
  check('目标环输出 svg', ring.includes('<svg') && ring.includes('stroke-dashoffset'));
  check('目标环无 NaN', !ring.includes('NaN'));
  check('progress 越界被夹紧', !C.goalRing(5, 40, 8).includes('NaN'));
}

console.log('\n[AA] 翻页时钟：进入/渲染/退出');
{
  const app = makeApp();
  await flush();
  const Flip = app.w.PomodoroFlip;
  const clock = app.$('flipclock');

  check('初始隐藏', clock.hidden === true && Flip.isOpen() === false);

  // 计时中进入 → 倒计时模式（先起跑，再看时钟跟着走）
  app.w.PomodoroTimer.start();
  await flush();
  app.$('flipBtn').click();
  await flush(); await flush();
  check('进入后打开', Flip.isOpen() === true && !clock.hidden);
  check('申请了常亮', app.wake.requested >= 1, app.wake.requested);

  advance(app, 5000);   // 走到 24:55 触发一次 tick
  await flush();
  const digits = [...app.$('flipStack').querySelectorAll('.flip-card:not(.flip-colon)')]
    .map((c) => c.querySelector('.flip-half.bottom .flip-digit').textContent).join('');
  check('显示剩余时间 2455', digits === '2455', digits);
  check('阶段标签=专注', app.$('flipSub').textContent === '专注', app.$('flipSub').textContent);

  // 退出（计时仍在进行：常亮由专注持有，不应被时钟退出带走）
  app.$('flipExit').click();
  await flush(); await flush();
  check('退出后关闭', Flip.isOpen() === false);
  check('专注中退出仍持锁', app.wake.released === 0 && app.wake.held === true,
        `released=${app.wake.released} held=${app.wake.held}`);

  // 完全复位后空闲再进 → 时钟模式；这次退出就该还锁了
  app.w.PomodoroTimer.reset();
  await flush(); await flush();
  const d = new Date(NOW);
  app.$('flipBtn').click();
  await flush(); await flush();
  const d2 = [...app.$('flipStack').querySelectorAll('.flip-card:not(.flip-colon)')]
    .map((c) => c.querySelector('.flip-half.bottom .flip-digit').textContent).join('');
  const expect = String(d.getHours()).padStart(2, '0') + String(d.getMinutes()).padStart(2, '0');
  check('空闲显示当前时间', d2 === expect, `got ${d2} want ${expect}`);
  app.$('flipExit').click();
  await flush(); await flush();
  check('空闲退出归还常亮', app.wake.released >= 1, app.wake.released);
}

console.log('\n[AB] 中断记录：暂停计入 session');
{
  const storage = new Map();
  const app = makeApp({ storage });
  await flush();

  // 暂停两次再跑完
  app.w.PomodoroTimer.setSetting('focusMin', 1);
  await flush();
  app.$('startBtn').click();
  await flush();
  advance(app, 10_000);
  app.$('startBtn').click();          // 暂停①（focus running）
  await flush();
  app.$('startBtn').click();
  await flush();
  advance(app, 10_000);
  app.$('startBtn').click();          // 暂停②
  await flush();
  app.$('startBtn').click();
  await flush();
  advance(app, 41_000);               // 跑完剩余
  await flush(); await flush(); await flush();

  const sess = app.w.PomodoroStore.loadSessions()[0];
  check('session 记了中断次数', sess && sess.interrupts === 2,
        sess && JSON.stringify(sess));
  const rec = app.w.PomodoroStore.todayRecord();
  check('日汇总累计中断', rec.interrupts === 2, rec.interrupts);
  check('完成数不受中断影响', rec.count === 1);

  const ins = app.w.PomodoroStore.insights();
  check('insights 今日中断', ins.todayInterrupts === 2, JSON.stringify(ins.todayInterrupts));

  // 休息里暂停不计中断
  app.$('startBtn').click();          // 开始休息
  await flush();
  app.$('startBtn').click();          // 休息中暂停
  await flush();
  const rec2 = app.w.PomodoroStore.todayRecord();
  check('休息中的暂停不计数', rec2.interrupts === 2, rec2.interrupts);
}

console.log('\n[AC] 白噪音：伴随专注启停 + 可设置');
{
  const storage = new Map();
  const app = makeApp({ storage });
  await flush();
  const Noise = app.w.PomodoroNoise;

  app.$('settingsBtn') && (app.calls.impact.length = 0);
  // 开雨声（设置面板 change 事件走真实 handler）
  app.$('noiseSelect').value = 'rain';
  app.$('noiseSelect').dispatchEvent(new app.w.Event('change', { bubbles: true }));
  // 立即断言：2.5s 的试听收尾守卫在测试时钟里是 0ms，flush 后就会停掉
  check('选择即启动雨声', Noise.current() === 'rain', Noise.current());
  // 雨声本质：一个循环噪声源走滤波链（LFO 是振荡器，不在该计数里）
  check('雨声建了循环噪声源', app.noiseNodes.sources === 1 && app.noiseNodes.buffers === 1,
        `src=${app.noiseNodes.sources} buf=${app.noiseNodes.buffers}`);
  await flush();
  check('非专注态下守卫自动停止', Noise.current() === null, Noise.current());

  // 设为关
  app.$('noiseSelect').value = 'off';
  app.$('noiseSelect').dispatchEvent(new app.w.Event('change', { bubbles: true }));
  await flush();
  check('off 即停', Noise.current() === null);

  // 设置持久化：noise 值保存了
  check('设置已持久化 rain→off', app.w.PomodoroTimer.getSettings().noise === 'off');

  // 专注进行时自动启动、暂停即停
  app.$('noiseSelect').value = 'cafe';
  app.$('noiseSelect').dispatchEvent(new app.w.Event('change', { bubbles: true }));
  await flush();
  app.w.PomodoroTimer.setSetting('focusMin', 1);
  await flush();
  const beforeStart = app.noiseNodes.started;
  app.$('startBtn').click();
  await flush(); await flush();
  check('专注开始自动播放', Noise.current() === 'cafe', Noise.current());
  check('源节点数量增长', app.noiseNodes.started > beforeStart);
  app.$('startBtn').click();           // 暂停
  await flush(); await flush();
  check('暂停即停', Noise.current() === null, Noise.current());
}

console.log('\n[AD] 备份恢复：校验/导入/留底');
{
  const storage = new Map();
  const app = makeApp({ storage });
  await flush();

  // 先造一点当前数据
  app.w.PomodoroStore.addCompletion(25, '旧任务');
  await flush();

  const bad1 = { foo: 1 };
  check('缺 records 拒绝',
        !!app.w.PomodoroStore.validateImport(bad1), app.w.PomodoroStore.validateImport(bad1));
  const bad2 = { records: { '26-08-26': { count: 1 } } };
  check('坏日期拒绝', !!app.w.PomodoroStore.validateImport(bad2));
  const bad3 = { schema: 9, records: {} };
  check('更高 schema 拒绝', !!app.w.PomodoroStore.validateImport(bad3));
  const good = {
    schema: 2,
    records: {
      [app.w.PomodoroStore.dayKey()]: { count: 7, minutes: 175, interrupts: 3,
                                        tasks: { '写代码': 5, 读文档: 2 } },
      '2026-08-01': { count: 2, minutes: 50, interrupts: 0, tasks: {} },
    },
    sessions: [
      { at: NOW - 86400000, day: '2026-08-01', hour: 10, min: 25, task: '读文档' },
    ],
    tasks: { list: [{ id: 'x1', title: '迁移来的任务', done: false, pomodoros: 0 }],
             activeId: null }
  };
  check('合法备份通过校验', app.w.PomodoroStore.validateImport(good) === null);

  const r = app.w.PomodoroStore.importAll(good);
  check('导入天数正确', r.importedDays === 2, r.importedDays);
  check('今日被覆盖为备份数据',
        app.w.PomodoroStore.todayRecord().count === 7 &&
        app.w.PomodoroStore.todayRecord().interrupts === 3,
        JSON.stringify(app.w.PomodoroStore.todayRecord()));
  check('旧 session 清空、新 session 在',
        app.w.PomodoroStore.loadSessions().length === 1);
  check('tasks 已导入', app.w.PomodoroStore.loadTasks().list.length === 1);

  const bk = JSON.parse(app.w.localStorage.getItem(app.w.PomodoroStore.BACKUP_KEY));
  check('导入前留底存在且含旧数据', bk && bk.records && Object.keys(bk.records).length >= 1,
        bk && Object.keys(bk.records||{}).join(','));

  // UI 触发完整文件链路：模拟 FileReader + 文件选择
  app.$('tabData') && app.$('panelBtn').click();
  await flush();
  app.$('tabData').click();
  await flush();
  const fileJson = JSON.stringify({
    schema: 2,
    records: { '2026-08-01': { count: 2, minutes: 50, interrupts: 0, tasks: {} } },
    sessions: [{ at: NOW - 86400000, day: '2026-08-01', hour: 10, min: 25, task: '读文档' }],
    tasks: { list: [], activeId: null }
  });
  const fakeFile = { };
  const frStub = class {
    readAsText(f) { this.result = fileJson; if (this.onload) setTimeout(() => this.onload(), 0); }
  };
  app.w.FileReader = frStub;
  Object.defineProperty(app.$('importFile'), 'files', { configurable: true, value: [fakeFile] });
  app.$('importFile').dispatchEvent(new app.w.Event('change', { bubbles: true }));
  await flush(); await flush();
  check('UI 导入成功有提示', app.$('toast').textContent.includes('已恢复'),
        app.$('toast').textContent);

  // 非法文件：toast 报错且不动数据
  app.w.FileReader = class { readAsText() { this.result = '{{bad'; setTimeout(() => this.onload && this.onload(), 0); } };
  const before = app.w.PomodoroStore.todayRecord().count;
  Object.defineProperty(app.$('importFile'), 'files', { configurable: true, value: [{}] });
  app.$('importFile').dispatchEvent(new app.w.Event('change', { bubbles: true }));
  await flush(); await flush();
  check('坏 JSON 被拒且数据不变',
        app.$('toast').textContent.includes('JSON') &&
        app.w.PomodoroStore.todayRecord().count === before,
        app.$('toast').textContent);
}

console.log('\n[AE] 周 vs 上周对比');
{
  const app = makeApp();
  await flush();
  const S = app.w.PomodoroStore;
  // 本周（周一起）造 5 个，上周同位置 3 个
  const now = new Date(NOW);
  const offMon = (now.getDay() + 6) % 7;
  function fmt(d) { return S.dayKey ? '' : ''; }
  const recs = {};
  for (let i = 0; i < 7; i++) {
    const a = new Date(now.getTime()); a.setDate(a.getDate() - offMon + i);
    recs[S.dayKey(a)] = { count: 5 - i, minutes: (5 - i) * 25, tasks: {}, interrupts: i };
    const b = new Date(a.getTime() - 7 * 86400000);
    recs[S.dayKey(b)] = { count: 3, minutes: 75, tasks: {}, interrupts: 0 };
  }
  S.saveRecords(recs);
  const ins = S.insights();
  // 本周种子是 5+4+3+2+1+0+0=15，上周恒为 3×7=21
  check('本周合计正确', ins.thisWeekCount === 15, ins.thisWeekCount);
  check('上周合计正确', ins.lastWeekCount === 21, ins.lastWeekCount);
  check('差值正确', ins.wowDelta === -6, ins.wowDelta);
  check('百分比正确', ins.wowPct === -29, ins.wowPct);

  const md = S.exportMarkdown();
  check('报告含对比行', md.includes('本周 vs 上周'), md.slice(0, 400));
  check('报告含本周数字', md.includes('15'));
}

console.log('\n[AF] 精确闹钟设置自检（官方建议）');
{
  const app = makeApp({ exactAlarm: 'enabled' });
  await flush(); await flush(); await flush();
  check('启动时检查了一次', app.calls.exactCheck === 1, app.calls.exactCheck);
  check('enabled 不打扰用户', app.$('notifyNote').textContent.indexOf('闹钟和提醒') === -1,
        app.$('notifyNote').textContent);

  const app2 = makeApp({ exactAlarm: 'disabled' });
  await flush(); await flush(); await flush();
  check('disabled 明确告知', app2.$('notifyNote').textContent.includes('闹钟和提醒'),
        app2.$('notifyNote').textContent);
  check('计时不受影响', app2.w.PomodoroTimer.get().remainSec === 1500);

  // 无该 API 的旧插件版本静默降级
  const app3 = makeApp();
  delete app3.w.Capacitor.Plugins.LocalNotifications.checkExactNotificationSetting;
  const app3b = app3;   // 同一实例
  await flush();
  check('旧插件降级不报错', app3b.w.PomodoroNative.checkExactAlarmSetting !== undefined);
  const st = await app3b.w.PomodoroNative.checkExactAlarmSetting();
  check('降级返回 unknown', st === 'unknown', st);
}

console.log('\n[AG] 任务编辑器 + 每任务专注时长');
{
  const storage = new Map();
  const app = makeApp({ storage });
  await flush();

  addTask(app, '写报告', { focusMin: 10 }); await flush();
  const saved = app.w.PomodoroStore.loadTasks().list[0];
  check('新任务带专注时长', saved.focusMin === 10, saved.focusMin);
  check('任务行显示时长', rowByTitle(app, '写报告').textContent.includes('10 分'));

  // 点标题展开编辑器
  rowByTitle(app, '写报告').querySelector('[data-act="edit"]').click();
  await flush();
  const li = rowByTitle(app, '写报告');
  check('编辑器已展开', !!li.querySelector('.task-editor'));
  check('标题回显', li.querySelector('.edit-title').value === '写报告');

  // 时长步进：10 → 25
  li.querySelector('[data-act="dur+"').click(); await flush();
  li.querySelector('[data-act="dur+"').click(); await flush();
  li.querySelector('[data-act="dur+"').click(); await flush();
  check('时长步进 +5 x3 = 25',
        li.querySelector('.edit-dur').textContent === '25',
        li.querySelector('.edit-dur').textContent);
  check('时长已保存',
        app.w.PomodoroStore.loadTasks().list[0].focusMin === 25);

  // 选中该任务后，计时器用任务时长而非全局
  li.querySelector('[data-act="focus"]').click();
  await flush();
  check('选中任务后覆盖生效', app.w.PomodoroTimer.getFocusOverride() === 25,
        app.w.PomodoroTimer.getFocusOverride());
  check('表盘显示任务时长', app.$('timeDisplay').textContent === '25:00',
        app.$('timeDisplay').textContent);

  // 改名
  const input = rowByTitle(app, '写报告').querySelector('.edit-title');
  input.value = '写周报';
  input.dispatchEvent(new app.w.Event('change', { bubbles: true }));
  await flush();
  check('改名已保存',
        app.w.PomodoroStore.loadTasks().list[0].title === '写周报');

  // 刷新后任务自带时长依然生效
  const stB = new Map();
  const appB = makeApp({ storage: stB });
  await flush();
  addTask(appB, '短任务', { focusMin: 5 }); await flush();
  rowByTitle(appB, '短任务').querySelector('[data-act="focus"]').click();
  await flush();
  check('短任务覆盖 5 分钟', appB.w.PomodoroTimer.getFocusOverride() === 5);
  rowByTitle(appB, '短任务').querySelector('[data-act="focus"]').click();
  await flush();
  check('取消选中回落全局', appB.w.PomodoroTimer.getFocusOverride() === 0);
  check('表盘回到全局 25:00', appB.$('timeDisplay').textContent === '25:00');

  const appC = makeApp({ storage: stB });
  await flush();
  rowByTitle(appC, '短任务').querySelector('[data-act="focus"]').click();
  await flush();
  check('刷新后再选中依然 5 分钟', appC.w.PomodoroTimer.getFocusOverride() === 5);
}

console.log(`\n${'='.repeat(48)}\nUI 集成：通过 ${pass} 项，失败 ${fail} 项\n${'='.repeat(48)}`);
process.exit(fail > 0 ? 1 : 0);
