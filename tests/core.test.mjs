/**
 * 核心逻辑回归测试（store.js + timer.js，不涉及 DOM）
 *
 * 用假的 Date.now 和手动驱动的 setInterval 模拟时间流动与 WebView 冻结。
 * 跑法：node tests/core.test.mjs   （或 npm test）
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const storeSrc = fs.readFileSync(path.join(ROOT, 'www/js/store.js'), 'utf8');
const timerSrc = fs.readFileSync(path.join(ROOT, 'www/js/timer.js'), 'utf8');

let NOW = new Date('2026-08-26T10:00:00').getTime();

/** shared 传入可跨实例复用的 Map 即可模拟"刷新页面" */
function makeEnv(shared) {
  const store = shared || new Map();
  const ls = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  const timers = new Map();
  let seq = 1;
  const g = {
    localStorage: ls,
    setInterval: (fn, ms) => { const id = seq++; timers.set(id, { fn, ms }); return id; },
    clearInterval: (id) => { timers.delete(id); },
    _timers: timers,
    _store: store,
  };
  const FakeDate = class extends Date {
    constructor(...a) { super(...(a.length ? a : [NOW])); }
    static now() { return NOW; }
  };
  Date.now = () => NOW;
  // timer.js 里用的是裸 localStorage / Date（浏览器里就是全局），
  // 所以必须作为形参注入，只挂在 window 上不够
  const run = (src) =>
    new Function('window', 'localStorage', 'Date', 'setInterval', 'clearInterval', src)
      (g, ls, FakeDate, g.setInterval, g.clearInterval);
  run(storeSrc);
  run(timerSrc);
  return { T: g.PomodoroTimer, S: g.PomodoroStore, g };
}

/** 推进时间并驱动 tick（模拟前台正常运行） */
function advance(g, ms, stepMs = 250) {
  let left = ms;
  while (left > 0) {
    const step = Math.min(stepMs, left);
    NOW += step;
    for (const t of [...g._timers.values()]) t.fn();
    left -= step;
  }
}

/** 只推时间不跑 tick（模拟 WebView 被系统冻结） */
function freeze(ms) { NOW += ms; }

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
}

console.log('\n[A] 状态机与基础倒计时');
{
  const { T } = makeEnv();
  T.init();
  check('初始 idle', T.get().state === 'idle', T.get().state);
  check('初始 25 分钟', T.get().remainSec === 1500, T.get().remainSec);
  T.start();
  check('start 后 running', T.get().state === 'running', T.get().state);
  check('endsAt 指向未来', T.get().endsAt > NOW);
}

console.log('\n[B] 退后台 1 分钟（WebView 冻结）');
{
  const { T, g } = makeEnv();
  T.init(); T.start();
  advance(g, 10_000);
  const before = T.get().remainSec;
  check('前台 10 秒后 24:50', before === 1490, before);
  freeze(60_000);
  T.resync();
  const after = T.get().remainSec;
  check('冻结 60 秒后准确扣除', after === 1430, `got ${after}`);
  check('仍在 running', T.get().state === 'running', T.get().state);
  check('无跳变（差值正好 60 秒）', before - after === 60, before - after);
}

console.log('\n[C] pause 后 resume 不重算总时长');
{
  const { T, g } = makeEnv();
  T.init(); T.start();
  advance(g, 120_000);
  check('跑 2 分钟后 23:00', T.get().remainSec === 1380, T.get().remainSec);
  T.pause();
  check('paused 状态', T.get().state === 'paused', T.get().state);
  const paused = T.get().remainSec;
  freeze(600_000);
  check('暂停期间不流逝', T.get().remainSec === paused, T.get().remainSec);
  T.start();
  check('总时长不变', T.get().totalMs === 25 * 60_000, T.get().totalMs);
  advance(g, 60_000);
  check('从暂停点继续', T.get().remainSec === 1320, T.get().remainSec);
}

console.log('\n[D] 长休息节奏（每 4 个番茄）');
{
  const { T, g } = makeEnv();
  T.init();
  const seq = [];
  T.on('phaseEnd', (i) => seq.push(i.finished + '->' + i.next));
  T.on('overtimeStart', () => seq.push('overtime'));
  for (let i = 0; i < 8; i++) {
    T.start();
    advance(g, T.get().remainMs + 300);
    // 专注走完先进加时；跳过加时 = 结算并进入下一阶段
    if (T.get().overtime) T.skip();
  }
  check('出现 focus->long', seq.includes('focus->long'), seq.join(' | '));
  // 每个番茄产生三条事件（overtime、focus->short、short->focus），
  // 第 4 个番茄的 focus->long 落在第 10 条（0 基）
  check('long 在第 4 个番茄后', seq.indexOf('focus->long') === 10, seq.join(' | '));
}

console.log('\n[E] 改时长刷新后仍在');
{
  const shared = new Map();
  const a = makeEnv(shared);
  a.T.init();
  a.T.setSetting('focusMin', 40);
  a.T.setSetting('shortMin', 8);
  check('设置生效', a.T.get().remainSec === 2400, a.T.get().remainSec);
  const b = makeEnv(shared);
  b.T.init();
  check('刷新后 focusMin 保留', b.T.getSettings().focusMin === 40);
  check('刷新后 shortMin 保留', b.T.getSettings().shortMin === 8);
  check('刷新后显示 40 分钟', b.T.get().remainSec === 2400, b.T.get().remainSec);
  a.T.setSetting('focusMin', 999);
  check('上限截断到 90', a.T.getSettings().focusMin === 90);
  a.T.setSetting('focusMin', -10);
  check('下限截断到 1', a.T.getSettings().focusMin === 1);
}

console.log('\n[F] 刷新恢复到暂停态，不自动跑完');
{
  const shared = new Map();
  const a = makeEnv(shared);
  a.T.init(); a.T.start();
  advance(a.g, 120_000);
  freeze(10 * 60 * 60_000);          // 关掉 app 十小时
  const b = makeEnv(shared);
  b.T.init();
  check('恢复为 paused', b.T.get().state === 'paused', b.T.get().state);
  check('剩余未被跑光', b.T.get().remainSec > 0, b.T.get().remainSec);
  check('已跑的 2 分钟保留', b.T.get().remainSec === 1380, b.T.get().remainSec);
}

console.log('\n[G] 完成专注写入记录（加时结算才算，倒计时到点不停车）');
{
  const shared = new Map();
  const { T, S, g } = makeEnv(shared);
  T.init();
  T.setSetting('focusMin', 1);
  let counted = null;
  let ot = null;
  T.on('phaseEnd', (i) => { counted = i; });
  T.on('overtimeStart', (s) => { ot = s; });
  T.start(); advance(g, 30_000); T.reset();
  check('中途 reset 不计入', S.todayRecord().count === 0);
  T.start(); advance(g, 61_000);
  check('到点先进加时而不是停车', ot && ot.overtime === true && T.get().running === true,
        JSON.stringify(ot));
  check('表盘显示 +00:01', T.get().overtimeMs === 1000, T.get().overtimeMs);
  T.pause();   // 加时态按暂停 = 结算
  check('phaseEnd 标记 counted', counted && counted.counted === true);
  check('结算分钟含加时', counted.focusMin === 1, counted.focusMin);
  S.addCompletion(counted.focusMin, '自由专注');   // UI 层负责写，这里模拟
  check('记录 count=1', S.todayRecord().count === 1);
  check('记录 minutes=1', S.todayRecord().minutes === 1);
  const b = makeEnv(shared);
  check('刷新后统计仍在', b.S.todayRecord().count === 1);
}

console.log('\n[H] 手动 skip 不计入');
{
  const { T, S } = makeEnv();
  T.init();
  let info = null;
  T.on('phaseEnd', (i) => { info = i; });
  T.start(); T.skip();
  check('skip 的 counted=false', info && info.counted === false);
  check('记录仍为 0', S.todayRecord().count === 0);
}

console.log('\n[I] 跨天记录归入新一天');
{
  const shared = new Map();
  const { S } = makeEnv(shared);
  S.addCompletion(25, '自由专注');
  const day1 = S.dayKey();
  check('今天有 1 个', S.todayRecord().count === 1);
  NOW = new Date('2026-08-27T09:30:00').getTime();
  const b = makeEnv(shared);
  check('新一天归零', b.S.todayRecord().count === 0);
  b.S.addCompletion(25, '自由专注');
  check('新一天记 1 个', b.S.todayRecord().count === 1);
  const recs = b.S.loadRecords();
  check('旧一天记录保留', recs[day1] && recs[day1].count === 1);
  check('两天各自独立', Object.keys(recs).length === 2);
}

console.log('\n[J] streak 连续天数');
{
  NOW = new Date('2026-08-26T10:00:00').getTime();
  const { S } = makeEnv();
  S.saveRecords({
    '2026-08-24': { count: 2, minutes: 50, tasks: {} },
    '2026-08-25': { count: 3, minutes: 75, tasks: {} },
    '2026-08-26': { count: 1, minutes: 25, tasks: {} },
  });
  check('streak = 3', S.streak() === 3, S.streak());
  S.saveRecords({
    '2026-08-23': { count: 2, minutes: 50, tasks: {} },
    '2026-08-26': { count: 1, minutes: 25, tasks: {} },
  });
  check('断档后 streak = 1', S.streak() === 1, S.streak());
  S.saveRecords({
    '2026-08-24': { count: 1, minutes: 25, tasks: {} },
    '2026-08-25': { count: 1, minutes: 25, tasks: {} },
  });
  check('今天空但昨天有 → 2', S.streak() === 2, S.streak());
  S.saveRecords({});
  check('无记录 → 0', S.streak() === 0);
}

console.log('\n[K] 本周柱状图数据');
{
  NOW = new Date('2026-08-26T10:00:00').getTime();   // 周三
  const { S } = makeEnv();
  S.saveRecords({ '2026-08-26': { count: 4, minutes: 100, tasks: {} } });
  const w = S.weekSeries();
  check('7 根柱子', w.length === 7);
  check('周一到周日', w.map((d) => d.label).join('') === '一二三四五六日');
  const today = w.filter((d) => d.isToday);
  check('恰好一个今天', today.length === 1);
  check('今天 count=4', today[0].count === 4);
  check('今天是周三', today[0].label === '三');
}

console.log('\n[L] 导出数据结构');
{
  const { S } = makeEnv();
  S.addCompletion(25, '写代码');
  const dump = S.exportAll();
  check('含 settings', !!dump.settings);
  check('含 records', !!dump.records);
  check('含 tasks', !!dump.tasks);
  check('含导出时间', typeof dump.exportedAt === 'string');
  const round = JSON.parse(JSON.stringify(dump));
  check('JSON 可往返（文件可打开）', round.records[S.dayKey()].count === 1);
}

console.log('\n[M] 任务持久化');
{
  const shared = new Map();
  const { S } = makeEnv(shared);
  S.saveTasks({
    list: [
      { id: 't1', title: '写代码', done: false, pomodoros: 2 },
      { id: 't2', title: '读文档', done: true, pomodoros: 0 },
    ],
    activeId: 't1',
  });
  const b = makeEnv(shared);
  const t = b.S.loadTasks();
  check('刷新后 2 个任务', t.list.length === 2);
  check('番茄数保留', t.list[0].pomodoros === 2);
  check('完成态保留', t.list[1].done === true);
  check('activeId 保留', t.activeId === 't1');
  b.S.saveTasks({ list: [t.list[1]], activeId: 't1' });
  const c = makeEnv(shared);
  check('指向已删任务的 activeId 被清空', c.S.loadTasks().activeId === null);
  const d = makeEnv(new Map());
  d.g._store.set('pomodoro_tasks', '{"list":[{"nope":1},{"title":"ok"}]}');
  const dl = d.S.loadTasks();
  check('脏任务被过滤', dl.list.length === 1 && dl.list[0].title === 'ok');
}

console.log('\n[N] 脏数据防御');
{
  const g1 = new Map();
  g1.set('pomodoro_settings', '{ 不是合法 JSON');
  const a = makeEnv(g1);
  a.T.init();
  check('坏 JSON 回落默认', a.T.getSettings().focusMin === 25);

  const g2 = new Map();
  g2.set('pomodoro_settings', JSON.stringify({ focusMin: 99999, shortMin: -3, longMin: 'x' }));
  const b = makeEnv(g2);
  b.T.init();
  const s = b.T.getSettings();
  check('非法时长夹紧', s.focusMin === 90 && s.shortMin === 1 && s.longMin === 15,
        JSON.stringify(s));

  const g3 = new Map();
  g3.set('pomodoro_state', JSON.stringify({ phase: '乱来', state: '乱来', elapsedBefore: -5 }));
  const c = makeEnv(g3);
  c.T.init();
  check('非法 phase 回落 focus', c.T.get().phase === 'focus');
  check('非法 state 不崩', typeof c.T.get().state === 'string');

  const g4 = new Map();
  g4.set('pomodoro_records', JSON.stringify({ '2026-08-26': { count: -9, minutes: 'x' } }));
  const d = makeEnv(g4);
  check('负计数夹紧', d.S.todayRecord().count === 0);
  check('非法分钟归 0', d.S.todayRecord().minutes === 0);
}

console.log('\n[O] 每任务专注时长覆盖');
{
  const { T, S } = makeEnv();
  T.init();
  check('默认无覆盖', T.getFocusOverride() === 0);

  T.setFocusOverride(50);
  check('覆盖生效 50 分钟', T.get().totalMs === 50 * 60000, T.get().totalMs);
  T.setFocusOverride(999);
  check('覆盖上限夹到 90', T.getFocusOverride() === 90);
  T.setFocusOverride(-5);
  check('覆盖下限归 0（跟随全局）', T.getFocusOverride() === 0);
  check('归 0 后回到全局时长', T.get().totalMs === 25 * 60000);

  // 覆盖值随状态持久化：杀进程恢复后依然用任务时长
  const shared = new Map();
  const a = makeEnv(shared);
  a.T.init();
  a.T.setFocusOverride(40);
  const b = makeEnv(shared);
  b.T.init();
  check('刷新后覆盖保留', b.T.getFocusOverride() === 40, b.T.getFocusOverride());
  check('恢复后的总时长按覆盖算', b.T.get().totalMs === 40 * 60000);

  // 完成的番茄按真实时长记录（advance 报告的 focusMin 是覆盖值）
  b.T.setFocusOverride(1);
  let info = null;
  b.T.on('phaseEnd', (i) => { info = i; });
  b.T.start();
  advance(b.g, 61_000);
  b.T.pause();   // 加时态按暂停 = 结算，报告真实时长
  check('phaseEnd 报告覆盖时长', info && info.focusMin === 1, info && info.focusMin);
}

console.log('\n[P] 新统计查询：星期分布 / 任务分钟 / 最近记录');
{
  const g1 = new Map();
  const { S } = makeEnv(g1);

  // 三条流水（真实场景按时间升序追加）：两天、两个任务、两个 taskId
  S.saveSessions([
    { at: NOW - 3 * 86400_000, day: '2026-08-24', hour: 21, min: 30, task: '写代码', taskId: 't1', interrupts: 0 },
    { at: NOW - 7200_000, day: '2026-08-26', hour: 8, min: 15, task: '读书', taskId: 't2', interrupts: 1 },
    { at: NOW - 3600_000, day: '2026-08-26', hour: 9, min: 25, task: '写代码', taskId: 't1', interrupts: 0 },
  ]);

  const wd = S.weekdayHistogram(30);
  check('星期分布固定 7 项', wd.length === 7);
  const total = wd.reduce((a, r) => a + r.count, 0);
  check('三条流水全部入桶', total === 3, total);
  check('带星期标签', typeof wd[0].label === 'string' && wd[0].label.length === 1);

  const wd7 = S.weekdayHistogram(1);
  check('范围过滤生效（1 天只剩今天）',
        wd7.reduce((a, r) => a + r.count, 0) === 2);

  const mins = S.taskMinutesById();
  check('按 taskId 聚合分钟', mins.t1 === 55 && mins.t2 === 15, JSON.stringify(mins));

  const recent = S.recentSessions(2);
  check('最近记录条数限制', recent.length === 2);
  check('最近记录新的在前', recent[0].at > recent[1].at);
  check('最近记录带任务名', recent[0].task === '写代码');

  // 无任务名时 addCompletion 也会记成「自由专注」（统计不依赖任务）
  S.addCompletion(25, null);
  const rec = S.todayRecord();
  check('无任务记为自由专注', rec.tasks['自由专注'] === 1, JSON.stringify(rec.tasks));
  check('无任务流水同样可查', S.recentSessions(1)[0].task === '自由专注');
}

console.log('\n[Q2] 加时正计时：结算、去重、恢复');
{
  const shared = new Map();
  const a = makeEnv(shared);
  a.T.init();
  a.T.setSetting('focusMin', 1);
  let ends = [];
  a.T.on('phaseEnd', (i) => ends.push(i));

  // 到点 → 加时；再跑 30 秒后暂停结算：1 分钟 + 1 分钟加时
  a.T.start();
  advance(a.g, 61_000);
  check('加时标志已置位', a.T.get().overtime === true);
  advance(a.g, 30_000);
  check('加时毫秒在涨', a.T.get().overtimeMs === 31_000, a.T.get().overtimeMs);
  a.T.pause();
  check('暂停结算一条且计入加时', ends.length === 1 && ends[0].counted === true
        && ends[0].focusMin === 2, JSON.stringify(ends));

  // 杀进程恢复：加时暂停态恢复后仍是加时，时长不丢
  const b = makeEnv(shared);
  b.T.init();
  check('恢复后仍是加时暂停', b.T.get().overtime === true && b.T.get().paused === true,
        JSON.stringify({ ot: b.T.get().overtime, st: b.T.get().state }));
  check('恢复后加时毫秒保留', b.T.get().overtimeMs >= 31_000, b.T.get().overtimeMs);

  // 结算后继续跑再跳过：不得二次记账
  a.T.start();
  advance(a.g, 65_000);
  check('结算后仍在加时正计时', a.T.get().overtime === true && a.T.get().running === true);
  a.T.skip();
  check('跳过不重复记账', ends.length === 2 && ends[1].counted === false,
        JSON.stringify(ends.map((e) => e.counted)));
  check('跳过后进入短休息并自动开跑', a.T.get().phase === 'short' && a.T.get().running === true);

  // 加时里 reset：放弃，不写记录
  const c = makeEnv();
  c.T.init();
  c.T.setSetting('focusMin', 1);
  c.T.start();
  advance(c.g, 62_000);
  c.T.reset();
  check('加时重置不记账', c.S.todayRecord().count === 0);
}

console.log('\n[Q3] 自动连跑：休息自动开始 / 下一轮自动开始');
{
  // 严格模式：专注到点不进加时，直接自动开始休息
  const a = makeEnv();
  a.T.init();
  a.T.setSetting('focusMin', 1);
  a.T.setSetting('autoStartBreak', true);
  let ends = [];
  a.T.on('phaseEnd', (i) => ends.push(i));
  a.T.start();
  advance(a.g, 61_000);
  check('到点自动进入休息', a.T.get().phase === 'short' && a.T.get().running === true,
        JSON.stringify({ ph: a.T.get().phase, st: a.T.get().state }));
  check('休息是被结算的专注触发的', ends.length === 1 && ends[0].counted === true
        && ends[0].focusMin === 1, JSON.stringify(ends));
  check('未进加时', a.T.get().overtime === false);
  a.T.reset();

  // 下一轮自动开始：休息走完自动继续专注
  const b = makeEnv();
  b.T.init();
  b.T.setSetting('shortMin', 1);
  b.T.setSetting('autoStartFocus', true);
  b.T.start();                       // 开始短休息
  advance(b.g, 61_000);
  check('休息结束自动开始专注', b.T.get().phase === 'focus' && b.T.get().running === true,
        JSON.stringify({ ph: b.T.get().phase, st: b.T.get().state }));
  b.T.reset();

  // 默认关闭：休息结束仍然停车等人
  const c = makeEnv();
  c.T.init();
  c.T.setSetting('shortMin', 1);
  c.T.skip();                        // 空闲跳过 → 短休息
  c.T.start();
  advance(c.g, 61_000);
  check('默认停车等人', c.T.get().phase === 'focus' && c.T.get().state === 'idle',
        JSON.stringify({ ph: c.T.get().phase, st: c.T.get().state }));
}

console.log(`\n${'='.repeat(48)}\n核心逻辑：通过 ${pass} 项，失败 ${fail} 项\n${'='.repeat(48)}`);
process.exit(fail > 0 ? 1 : 0);
