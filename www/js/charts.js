/**
 * 图表渲染：纯手写 SVG 字符串，零依赖
 *
 * 不引图表库的原因：这几种图都很简单，一个库动辄几百 KB，
 * 打进 apk 不值得；而且自己画能精确控制配色和动效，
 * 保持"只动 transform/opacity"这条性能约定。
 *
 * 所有函数返回 SVG/HTML 字符串，由 ui.js 塞进容器。
 * 数值一律经过转义与夹紧，任务名等文本走 escapeText。
 */
(function (global) {
  'use strict';

  var ORANGE = '#d97757';
  var TEAL = '#6a8a82';
  var TRACK = 'rgba(20,20,19,0.08)';
  var FAINT = '#9a9892';

  // 饼图切片色板：暖色家族由深到浅 + 青灰对冲，同族不重复、相邻可分辨
  var SLICES = ['#d97757', '#b4532a', '#8f4a3c', '#c99a6b', '#6a8a82', '#a5988a'];

  /** 文本进 SVG/HTML 前必须转义，任务名是用户输入 */
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /** 数字进 SVG 坐标前保证是有限数，避免 NaN 让整张图不渲染 */
  function num(v, fallback) {
    var n = Number(v);
    return isFinite(n) ? Math.round(n * 100) / 100 : (fallback || 0);
  }

  var Charts = {
    escapeText: esc,

    /**
     * 近 N 天趋势：折线 + 面积 + 目标虚线
     * @param {Array} series Store.daySeries() 的结果
     * @param {number} goal 每日目标
     */
    trendLine: function (series, goal) {
      if (!series || !series.length) return '<p class="empty-tip">还没有数据</p>';

      // 右侧留出 6px：末位那个圆点半径 3，贴边会被裁掉一半
      var W = 320, H = 110, padL = 4, padR = 7, padT = 8, padB = 18;
      var innerW = W - padL - padR;
      var innerH = H - padT - padB;

      var max = Math.max(goal || 0, 1);
      series.forEach(function (d) { if (d.count > max) max = d.count; });

      var n = series.length;
      var stepX = n > 1 ? innerW / (n - 1) : 0;

      function px(i) { return num(padL + i * stepX); }
      function py(v) { return num(padT + innerH - (v / max) * innerH); }

      var linePts = [], areaPts = [];
      series.forEach(function (d, i) {
        linePts.push(px(i) + ',' + py(d.count));
      });
      // 面积多两个底部点闭合
      areaPts.push(px(0) + ',' + py(0));
      areaPts = areaPts.concat(linePts);
      areaPts.push(px(n - 1) + ',' + py(0));

      var goalY = py(goal || 0);
      var svg = [];
      svg.push('<svg class="chart-svg" viewBox="0 0 ' + W + ' ' + H + '" '
             + 'preserveAspectRatio="none" role="img" aria-label="近 ' + n + ' 天专注趋势">');

      // 目标线
      if (goal > 0) {
        svg.push('<line x1="' + padL + '" y1="' + goalY + '" x2="' + (W - padR) + '" y2="' + goalY
               + '" stroke="' + TEAL + '" stroke-width="1" stroke-dasharray="3 3" opacity="0.55"/>');
      }
      // 面积
      svg.push('<polygon points="' + areaPts.join(' ') + '" fill="' + ORANGE + '" opacity="0.12"/>');
      // 折线
      svg.push('<polyline points="' + linePts.join(' ') + '" fill="none" stroke="' + ORANGE
             + '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>');
      // 今天那个点标出来
      var last = series[n - 1];
      svg.push('<circle cx="' + px(n - 1) + '" cy="' + py(last.count) + '" r="3" fill="' + ORANGE + '"/>');
      svg.push('</svg>');

      // 首尾日期标签，中间不标免得挤
      var mid = series[Math.floor(n / 2)];
      svg.push('<div class="chart-axis">'
             + '<span>' + esc(series[0].label) + '</span>'
             + '<span>' + esc(mid.label) + '</span>'
             + '<span>今天</span>'
             + '</div>');
      return svg.join('');
    },

    /**
     * 24 小时热图：24 个小格子，颜色深浅表示专注密度
     * @param {Array} hist Store.hourHistogram() 的结果
     */
    hourHeatmap: function (hist) {
      if (!hist || !hist.length) return '<p class="empty-tip">还没有数据</p>';

      var max = 1;
      hist.forEach(function (b) { if (b.count > max) max = b.count; });

      var cells = hist.map(function (b) {
        // 有数据的最低也给 0.15 透明度，看得出"有但少"
        var ratio = b.count > 0 ? (0.15 + 0.85 * (b.count / max)) : 0;
        var style = b.count > 0
          ? 'background:' + ORANGE + ';opacity:' + num(ratio, 0)
          : 'background:' + TRACK;
        return '<i class="heat-cell" style="' + style + '" '
             + 'title="' + b.hour + ':00 共 ' + b.count + ' 个番茄"></i>';
      }).join('');

      // 只标 0/6/12/18 四个刻度
      return '<div class="heatmap" role="img" aria-label="24 小时专注时段分布">' + cells + '</div>'
           + '<div class="heat-axis"><span>0</span><span>6</span><span>12</span>'
           + '<span>18</span><span>23</span></div>';
    },

    /**
     * 任务占比：横向条形
     * @param {Array} rows Store.taskBreakdown() 的结果
     * @param {number} limit 最多显示几条
     */
    taskBars: function (rows, limit) {
      if (!rows || !rows.length) return '<p class="empty-tip">还没有任务数据</p>';
      limit = limit || 6;

      var shown = rows.slice(0, limit);
      var max = 1;
      shown.forEach(function (r) { if (r.count > max) max = r.count; });

      return shown.map(function (r) {
        var w = num((r.count / max) * 100, 0);
        return '<div class="tbar-row">'
             + '<span class="tbar-name">' + esc(r.task) + '</span>'
             + '<span class="tbar-track"><i style="width:' + w + '%"></i></span>'
             + '<span class="tbar-val">' + r.count + '</span>'
             + '</div>';
      }).join('');
    },

    /**
     * 任务占比环形图：最多 5 个任务，其余并入「其他」。
     * 圆环用 circle + stroke-dasharray 拼，中心放总数。
     * @param {Array} rows Store.taskBreakdown() 的结果
     */
    donut: function (rows) {
      if (!rows || !rows.length) return '<p class="empty-tip">还没有任务数据</p>';

      var SIZE = 150, R = 56, SW = 21;
      var C = 2 * Math.PI * R;
      var cx = SIZE / 2;

      // 前 5 个切片，其余合并成「其他」
      var top = rows.slice(0, 5);
      var restCount = 0;
      rows.slice(5).forEach(function (r) { restCount += r.count; });
      if (restCount > 0) top.push({ task: '其他', count: restCount });

      var total = 0;
      top.forEach(function (r) { total += r.count; });
      if (total <= 0) return '<p class="empty-tip">还没有任务数据</p>';

      var svg = ['<svg class="donut-svg" viewBox="0 0 ' + SIZE + ' ' + SIZE + '" role="img" '
               + 'aria-label="任务专注占比，共 ' + total + ' 个番茄">'];
      var acc = 0;
      top.forEach(function (r, i) {
        var frac = r.count / total;
        // 留 2° 缝隙，切片之间才读得开
        var gap = top.length > 1 ? Math.min(2 / 360, frac * 0.3) : 0;
        var len = Math.max(0, C * (frac - gap));
        var dash = len + ' ' + num(C - len);
        var rot = num(-90 + 360 * acc);
        svg.push('<circle cx="' + cx + '" cy="' + cx + '" r="' + R + '" fill="none" '
               + 'stroke="' + SLICES[i % SLICES.length] + '" stroke-width="' + SW + '" '
               + 'stroke-dasharray="' + dash + '" stroke-dashoffset="0" '
               + 'transform="rotate(' + rot + ' ' + cx + ' ' + cx + ')"/>');
        acc += frac;
      });
      svg.push('<text x="' + cx + '" y="' + (cx - 2) + '" text-anchor="middle" '
             + 'class="donut-num">' + total + '</text>');
      svg.push('<text x="' + cx + '" y="' + (cx + 16) + '" text-anchor="middle" '
             + 'class="donut-cap">个番茄</text>');
      svg.push('</svg>');

      var legend = top.map(function (r, i) {
        var pct = Math.round((r.count / total) * 100);
        return '<li><i class="swatch" style="background:'
             + SLICES[i % SLICES.length] + '"></i>'
             + '<span class="lg-name">' + esc(r.task) + '</span>'
             + '<b>' + r.count + '</b><span class="lg-pct">' + pct + '%</span></li>';
      }).join('');

      return '<div class="donut-wrap">' + svg.join('') + '</div>'
           + '<ul class="donut-legend">' + legend + '</ul>';
    },

    /**
     * 星期分布柱状图：7 根 SVG 柱，看"周几最能专注"。
     * @param {Array} rows Store.weekdayHistogram() 的结果
     */
    weekdayBars: function (rows) {
      if (!rows || !rows.length || rows.length !== 7) return '<p class="empty-tip">还没有数据</p>';

      var W = 320, H = 130, padT = 10, padB = 22;
      var innerH = H - padT - padB;
      var slot = W / 7;
      var barW = 18;

      var max = 1;
      rows.forEach(function (r) { if (r.count > max) max = r.count; });

      var svg = ['<svg class="chart-svg chart-svg-tall" viewBox="0 0 ' + W + ' ' + H + '" '
               + 'role="img" aria-label="星期分布：'
               + rows.map(function (r) { return '周' + r.label + r.count + '个'; }).join('，') + '">'];
      rows.forEach(function (r, i) {
        var h = (r.count / max) * innerH;
        var x = num(slot * i + (slot - barW) / 2);
        var y = num(padT + innerH - h);
        svg.push('<rect x="' + x + '" y="' + y + '" width="' + barW + '" height="' + num(h)
               + '" rx="5" fill="' + (r.count > 0 ? ORANGE : TRACK) + '"/>');
        svg.push('<text x="' + num(slot * i + slot / 2) + '" y="' + (H - 6)
               + '" text-anchor="middle" class="bar-txt">' + esc(r.label) + '</text>');
        if (r.count > 0) {
          svg.push('<text x="' + num(slot * i + slot / 2) + '" y="' + num(y - 4)
                 + '" text-anchor="middle" class="bar-val">' + r.count + '</text>');
        }
      });
      svg.push('</svg>');
      return svg.join('');
    },

    /**
     * 每日目标进度环
     * @param {number} progress 0..1
     * @param {number} done 已完成
     * @param {number} goal 目标
     */
    goalRing: function (progress, done, goal) {
      var R = 34, SW = 7;
      var C = 2 * Math.PI * R;
      var p = Math.max(0, Math.min(1, Number(progress) || 0));
      var offset = num(C * (1 - p));
      var size = (R + SW) * 2;
      var center = R + SW;

      return '<div class="goal-ring">'
        + '<svg viewBox="0 0 ' + size + ' ' + size + '" role="img" '
        + 'aria-label="今日目标进度 ' + done + ' / ' + goal + '">'
        + '<circle cx="' + center + '" cy="' + center + '" r="' + R + '" fill="none" '
        + 'stroke="' + TRACK + '" stroke-width="' + SW + '"/>'
        + '<circle cx="' + center + '" cy="' + center + '" r="' + R + '" fill="none" '
        + 'stroke="' + ORANGE + '" stroke-width="' + SW + '" stroke-linecap="round" '
        + 'stroke-dasharray="' + num(C) + '" stroke-dashoffset="' + offset + '" '
        + 'transform="rotate(-90 ' + center + ' ' + center + ')"/>'
        + '</svg>'
        + '<div class="goal-ring-text"><b>' + (done | 0) + '</b><span>/ ' + (goal | 0) + '</span></div>'
        + '</div>';
    },

    /**
     * 任务预估 vs 实际的进度条
     * @param {object} task
     */
    taskProgress: function (task) {
      if (!task || !task.estimate) return '';
      var ratio = task.estimate > 0 ? task.pomodoros / task.estimate : 0;
      var w = num(Math.min(1, ratio) * 100, 0);
      // 超预估用青灰提示，不用红色，避免制造焦虑
      var over = ratio > 1;
      return '<span class="est-track" title="已投入 ' + task.pomodoros
           + ' / 预估 ' + task.estimate + '">'
           + '<i style="width:' + w + '%;background:' + (over ? TEAL : ORANGE) + '"></i>'
           + '</span>';
    }
  };

  global.PomodoroCharts = Charts;
})(window);
