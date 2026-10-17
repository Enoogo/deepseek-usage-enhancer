/* =====================================================================
 * DeepSeek 用量页 · 任意时间段增强（浏览器扩展，Manifest V3）  v1.2.0
 * ---------------------------------------------------------------------
 * 背景：platform.deepseek.com/usage 的用量接口（/api/v0/usage/by_api_key/*）
 *       单次最多只接受 31 天（2,678,400 秒）的查询，官方日期选择器同样限制 31 天。
 * 原理：以 MAIN world 内容脚本在页面上下文运行，拦截 XMLHttpRequest：
 *       1) 识别官方发起的用量请求（当增强模式开启且页面筛选仍为受控状态）；
 *       2) 把目标区间拆成若干 ≤31 天的分片，逐片请求后合并为与官方接口
 *          完全同构的 JSON，并为区间内每一天补齐零值桶（保证图表横轴完整）；
 *       3) 用本地 Blob URL 重放该响应（XHR 完整走一遍原生生命周期），
 *          官方 KPI / 图表 / 明细表因此原样渲染任意长度区间；
 *       4) 通过 React fiber 找到官方 ECharts 图表实例，注入原生 dataZoom：
 *          底部横向滑动条 + 滚轮/拖动平移，长区间可滚动查看更早日期。
 * 说明：纯前端实现，只读当前登录账号自身的用量数据，不修改服务器与官方代码。
 * ===================================================================== */
(function () {
  'use strict';

  var DS = (window.__DS_USAGE_ENHANCER__ = window.__DS_USAGE_ENHANCER__ || {});
  if (DS.__installed) return;
  DS.__installed = true;
  DS.version = '1.2.0';

  /* ---------------------------- 常量 ---------------------------- */
  var DAY = 86400;                       // 一天的秒数
  var CAP = 31 * DAY;                    // 官方接口单次查询上限（31 天）
  var API = 'https://platform.deepseek.com/api/v0/usage/by_api_key/';
  var KEY_API = 'https://platform.deepseek.com/api/v0/users/get_api_keys';
  var STORE = 'deepseek.usage.enhancer.v1';       // 本扩展自己的状态
  var PREF_PREFIX = 'deepseek.platform.usage.boardPreference.v1.'; // 官方筛选偏好
  var EARLIEST = '2024-01-01';           // 最早可查询日期（平台上线前）
  // 官方日期筛选标签（中英双语 + 自定义格式），用于定位页面上的日期 chip
  var DATE_LABEL_RE = /^(Today|Yesterday|Last 7 days|Last 30 days|This month|Last month|今天|昨天|近\s?7\s?天|近\s?30\s?天|本月|上月)$|^\d{2}\/\d{2}\s-\s\d{2}\/\d{2}$|^\d{4}\/\d{2}\/\d{2}\s-\s\d{4}\/\d{2}\/\d{2}$/;

  /* ------------------------- 状态 / 偏好 ------------------------- */
  function getState() {
    try {
      var s = JSON.parse(localStorage.getItem(STORE));
      return s && s.v === 1 ? s : null;
    } catch (e) { return null; }
  }
  function setState(s) {
    try { s.v = 1; localStorage.setItem(STORE, JSON.stringify(s)); } catch (e) { }
  }
  function prefKey() {
    try {
      var ks = Object.keys(localStorage);
      for (var i = 0; i < ks.length; i++) {
        if (ks[i].indexOf(PREF_PREFIX) === 0) return ks[i];
      }
    } catch (e) { }
    return null;
  }
  function readPref() {
    try { return JSON.parse(localStorage.getItem(prefKey())); } catch (e) { return null; }
  }
  function writePref(p) {
    try { localStorage.setItem(prefKey(), JSON.stringify(p)); return true; } catch (e) { return false; }
  }
  // 增强模式"受控筛选"标记：页面当前日期筛选仍为我们写入的「近 30 天」预设
  function applied() {
    var p = readPref();
    var f = p && p.dateFilter;
    return !!(f && f.kind === 'preset' && f.preset === 'last30Days');
  }
  // 「近 30 天」在给定时区下的时间区间（与官方算法一致，[start, end) 且 end 为明天 0 点）
  function appliedRange(tz) {
    var D = dayStart(Math.floor(Date.now() / 1000), tz);
    return [D - 29 * DAY, D + DAY];
  }

  /* --------------------------- 时间工具 --------------------------- */
  function dayStart(ts, tz) { return Math.floor((ts + tz) / DAY) * DAY - tz; }
  function dateStrToSec(s, tz) {
    var a = s.split('-');
    return Date.UTC(+a[0], +a[1] - 1, +a[2]) / 1000 - tz;
  }
  function secToDateStr(ts, tz) {
    var d = new Date((ts + tz) * 1000);
    return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
  }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  // 生成与官方"自定义"筛选同款标签：同年 MM/DD - MM/DD，跨年 YYYY/MM/DD - YYYY/MM/DD
  function rangeLabel(startSec, endEx, tz) {
    var last = endEx - DAY;
    var a = new Date((startSec + tz) * 1000);
    var b = new Date((last + tz) * 1000);
    var sameYear = a.getUTCFullYear() === b.getUTCFullYear();
    function f(d) {
      var mm = pad2(d.getUTCMonth() + 1), dd = pad2(d.getUTCDate());
      return sameYear ? mm + '/' + dd : d.getUTCFullYear() + '/' + mm + '/' + dd;
    }
    return f(a) + ' - ' + f(b);
  }
  // 当前生效时区：官方偏好里的固定时区（秒），否则取本机时区
  function effectiveTz() {
    var p = readPref();
    var t = p && p.tzPreference;
    if (t != null && t !== 'device') {
      var n = Number(t);
      if (isFinite(n) && Math.abs(n) <= 50400) return n;
    }
    return -new Date().getTimezoneOffset() * 60;
  }

  /* --------------------------- Token --------------------------- */
  function getToken() {
    try {
      var t = JSON.parse(localStorage.getItem('userToken'));
      return t && t.value ? t.value : null;
    } catch (e) { return null; }
  }

  /* ----------------------- 分片拉取 + 合并 ----------------------- */
  function usageUrl(kind, s, e, tz) {
    return API + kind + '?start=' + s + '&end=' + e + '&tz=' + tz;
  }

  // 把一个任意长度的区间拆成 ≤31 天的分片，逐片请求并用与官方同构的结构合并
  function fetchMerged(kind, start, end, tz, onProgress) {
    var token = getToken();
    if (!token) return Promise.reject(new Error('未登录：找不到 userToken'));
    var chunks = [];
    for (var a = start; a < end; a += CAP) chunks.push([a, Math.min(a + CAP, end)]);
    var jsons = [];
    var done = 0;
    function step(i) {
      if (i >= chunks.length) {
        if (!jsons.length) return Promise.reject(new Error('没有任何分片数据'));
        var merged = mergeUsage(kind, jsons, start, end);
        padBuckets(kind, merged, start, end);
        return merged;
      }
      var c = chunks[i];
      return fetch(usageUrl(kind, c[0], c[1], tz), {
        credentials: 'include',
        headers: { Authorization: 'Bearer ' + token }
      }).then(function (r) {
        if (r.status !== 200) throw new Error('HTTP ' + r.status);
        return r.json();
      }).then(function (j) {
        if (!(j && j.data && j.data.biz_code === 0)) {
          throw new Error('接口返回异常：' + JSON.stringify(j).slice(0, 120));
        }
        jsons.push(j);
        done++;
        if (onProgress) { try { onProgress(done, chunks.length); } catch (e) { } }
        return step(i + 1);
      });
    }
    return step(0);
  }

  // 为区间内的每一天补齐"零值桶"。
  // 官方前端在区间 >31 天时只用"数据里出现过的日期"作为图表横轴（其源码 mP() 的上限逻辑），
  // 补齐后横轴即可获得完整区间；配合 dataZoom 即可横向滚动查看更早日期。
  function padBuckets(kind, merged, s, e) {
    try {
      var bd = merged && merged.data && merged.data.biz_data;
      if (!bd) return merged;
      var lists = [];
      if (kind === 'cost') {
        var arr = bd.data || [];
        for (var ci = 0; ci < arr.length; ci++) lists = lists.concat(arr[ci].series || []);
      } else {
        lists = bd.series || [];
      }
      for (var i = 0; i < lists.length; i++) {
        var ser = lists[i];
        if (!ser || !ser.buckets || !ser.buckets.length) continue;   // 全空 series 不补
        var have = {};
        for (var j = 0; j < ser.buckets.length; j++) have[ser.buckets[j].time] = 1;
        for (var t = s; t < e; t += DAY) {
          if (!have[t]) {
            ser.buckets.push(kind === 'cost'
              ? { time: t, cost: '0' }
              : { time: t, usage: { REQUEST: 0, RESPONSE_TOKEN: 0, PROMPT_CACHE_HIT_TOKEN: 0, PROMPT_CACHE_MISS_TOKEN: 0 } });
          }
        }
        ser.buckets.sort(function (a, b) { return a.time - b.time; });
      }
    } catch (err) { }
    return merged;
  }

  function mergeUsage(kind, jsons, s, e) {
    var models = [];
    var seenModel = {};
    function addModels(bd) {
      var ms = (bd && bd.models) || [];
      for (var i = 0; i < ms.length; i++) {
        if (!seenModel[ms[i]]) { seenModel[ms[i]] = 1; models.push(ms[i]); }
      }
    }
    function keyOf(ser) { return ser.api_key.tracking_id + '|' + ser.model; }
    function finishSer(t) {
      t.buckets.sort(function (x, y) { return x.time - y.time; });
      var out = [], prev = -1;
      for (var i = 0; i < t.buckets.length; i++) {
        if (t.buckets[i].time !== prev) { out.push(t.buckets[i]); prev = t.buckets[i].time; }
      }
      t.buckets = out;
      return t;
    }
    if (kind === 'cost') {
      var curMap = {};
      for (var i = 0; i < jsons.length; i++) {
        var bd = jsons[i].data.biz_data;
        addModels(bd);
        var arr = bd.data || [];
        for (var c = 0; c < arr.length; c++) {
          var cur = arr[c];
          if (!curMap[cur.currency]) curMap[cur.currency] = { map: {}, order: [] };
          var grp = curMap[cur.currency];
          var series = cur.series || [];
          for (var j = 0; j < series.length; j++) {
            var ser = series[j], k = keyOf(ser);
            if (!grp.map[k]) { grp.map[k] = { api_key: ser.api_key, model: ser.model, buckets: [] }; grp.order.push(k); }
            grp.map[k].buckets = grp.map[k].buckets.concat(ser.buckets || []);
          }
        }
      }
      var data = [];
      for (var cu in curMap) {
        if (!Object.prototype.hasOwnProperty.call(curMap, cu)) continue;
        var g = curMap[cu], list = [];
        for (var oi = 0; oi < g.order.length; oi++) list.push(finishSer(g.map[g.order[oi]]));
        data.push({ currency: cu, series: list });
      }
      return { code: 0, msg: '', data: { biz_code: 0, biz_msg: '', biz_data: { start: s, end: e, bucket: DAY, models: models, data: data } } };
    }
    var sm = {}, order = [];
    for (var m = 0; m < jsons.length; m++) {
      var bdm = jsons[m].data.biz_data;
      addModels(bdm);
      var ss = bdm.series || [];
      for (var n = 0; n < ss.length; n++) {
        var ser2 = ss[n], k2 = keyOf(ser2);
        if (!sm[k2]) { sm[k2] = { api_key: ser2.api_key, model: ser2.model, buckets: [] }; order.push(k2); }
        sm[k2].buckets = sm[k2].buckets.concat(ser2.buckets || []);
      }
    }
    var seriesOut = [];
    for (var q = 0; q < order.length; q++) seriesOut.push(finishSer(sm[order[q]]));
    return { code: 0, msg: '', data: { biz_code: 0, biz_msg: '', biz_data: { start: s, end: e, bucket: DAY, models: models, series: seriesOut } } };
  }

  /* ------------------------- XHR 拦截 ------------------------- */
  var ORIG_OPEN = XMLHttpRequest.prototype.open;
  var ORIG_SEND = XMLHttpRequest.prototype.send;

  // 判断某个请求是否属于"增强模式受控范围内的官方用量请求"
  function matchUsageReq(rawUrl) {
    var st = getState();
    if (!st || !st.on) return null;
    if (String(rawUrl).indexOf('/api/v0/usage/by_api_key/') === -1) return null;   // 快速短路
    var u;
    try { u = new URL(rawUrl, location.href); } catch (e) { return null; }
    if (u.origin !== 'https://platform.deepseek.com') return null;
    var m = /^\/api\/v0\/usage\/by_api_key\/(cost|amount)$/.exec(u.pathname);
    if (!m) return null;
    if (!applied()) return null;                       // 页面筛选保持受控
    var s = Number(u.searchParams.get('start'));
    var e = Number(u.searchParams.get('end'));
    var tz = Number(u.searchParams.get('tz'));
    if (!isFinite(s) || !isFinite(e) || !isFinite(tz)) return null;
    var R = appliedRange(tz);
    if (s !== R[0] || e !== R[1]) return null;         // 仅接管官方自身的"近30天"请求
    return { kind: m[1], tz: tz };
  }

  XMLHttpRequest.prototype.open = function (method, url) {
    try { this.__dsuUrl = String(url); } catch (e) { }
    return ORIG_OPEN.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function (body) {
    var meta = null;
    try { meta = matchUsageReq(this.__dsuUrl); } catch (e) { }
    if (!meta) return ORIG_SEND.apply(this, arguments);

    var xhr = this;
    var st = getState();
    (function () {
      fetchMerged(meta.kind, st.start, st.end, meta.tz, null).then(function (merged) {
        var text = JSON.stringify(merged);
        try {
          replay(xhr, text);
        } catch (err) {
          console.warn('[任意时间段增强] 响应重放失败，回退原生请求：', err);
          try { ORIG_SEND.call(xhr, body); } catch (e) { }
        }
      }).catch(function (err) {
        console.warn('[任意时间段增强] 分片拉取失败，回退原生请求：', err);
        try { ORIG_SEND.call(xhr, body); } catch (e) { }
      });
    })();
  };

  // 用本地 Blob 作为响应体"重放"请求：XHR 完整经历原生生命周期，
  // 页面上任何客户端（axios / SWR / 自定义封装）都能无感接收。
  function replay(xhr, text) {
    var rt = xhr.responseType, to = xhr.timeout, wc = xhr.withCredentials;
    var burl = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    xhr.addEventListener('loadend', function () { DS.served = true; }, { once: true });
    ORIG_OPEN.call(xhr, 'GET', burl, true);
    try { xhr.responseType = rt; } catch (e) { }
    try { xhr.timeout = to; } catch (e) { }
    try { xhr.withCredentials = wc; } catch (e) { }
    ORIG_SEND.call(xhr);
    setTimeout(function () { URL.revokeObjectURL(burl); }, 30000);
  }

  /* --------------------- 官方日期 chip 回写 --------------------- */
  function findDateChip() {
    var btns = document.querySelectorAll('[role="button"]');
    var exp = null;
    for (var i = 0; i < btns.length; i++) {
      var t = (btns[i].textContent || '').trim();
      if (t === 'Export' || t === '导出') { exp = btns[i]; break; }
    }
    if (!exp) return null;
    var holder = exp;
    for (var k = 0; k < 3 && holder; k++) holder = holder.parentElement;
    if (!holder) return null;
    var spans = holder.querySelectorAll('span');
    for (var j = 0; j < spans.length; j++) {
      var s = spans[j];
      if (s.children.length === 0 && DATE_LABEL_RE.test((s.textContent || '').trim())) return s;
    }
    return null;
  }

  function relabelTick() {
    try {
      var st = getState();
      if (!st || !st.on || !DS.served) return;
      if (!applied()) return;                 // 用户改动过筛选，尊重原生显示
      var chip = findDateChip();
      if (!chip) return;
      var label = rangeLabel(st.start, st.end, effectiveTz());
      if (chip.textContent.trim() !== label) chip.textContent = label;
    } catch (e) { }
  }

  /* ---------------- 图表增强（ECharts 横向滚动/缩放） ----------------
   * 官方图表由 ECharts（SVG 渲染）绘制。这里通过 React fiber 找到图表实例，
   * 注入原生 dataZoom 组件：
   *   - 底部横向滑动条（slider）：左右拖动查看更早的日期；
   *   - 鼠标滚轮/拖动平移（inside）：hover 在图表上滚动 = 横向滚动；
   * 同时把固定的 Y 轴上限改为自适应（长区间浏览时更合理）。
   * ------------------------------------------------------------------ */
  var ZOOM_MIN_CATS = 40;        // 分类数超过该值才启用滑动条
  var ZOOM_WINDOW = 62;          // 默认窗口显示最近 N 天
  var ZOOM_GRID_BOTTOM = 38;     // 给底部滑条留出空间

  function optionCatLen(opt) {
    try {
      var xs = opt && opt.xAxis ? (Array.isArray(opt.xAxis) ? opt.xAxis : [opt.xAxis]) : [];
      var x0 = xs[0];
      return (x0 && x0.data) ? x0.data.length : 0;
    } catch (e) { return 0; }
  }

  // 读取当前缩放窗口：存在多个 dataZoom 组件时优先取 slider（其数值最可靠地跟随用户操作；
  // 若读取 [0]（inside 条目）可能拿到未同步的默认值 0/100，导致滚轮被误判为"已到边缘"）。
  function readZoomWindow(zs) {
    var z0 = null;
    for (var i = 0; i < zs.length; i++) {
      if (zs[i] && zs[i].type === 'slider') { z0 = zs[i]; break; }
    }
    if (!z0) z0 = zs[0];
    return (z0 && z0.start != null) ? z0 : null;
  }

  // 从图表容器元素出发，沿 React fiber 找到持有 ECharts 实例的 ref
  function findChartInstance(dom) {
    try {
      var fkey = null, ks = Object.keys(dom);
      for (var i = 0; i < ks.length; i++) {
        if (ks[i].indexOf('__reactFiber$') === 0) { fkey = ks[i]; break; }
      }
      if (!fkey) return null;
      var f = dom[fkey];
      while (f) {
        var h = f.memoizedState;
        while (h) {
          var s = h.memoizedState;
          var c = s && s.current;
          if (c && typeof c.getOption === 'function' && typeof c.setOption === 'function' &&
              typeof c.getDom === 'function' && c.getDom() === dom) return c;
          h = h.next;
        }
        f = f.return;
      }
    } catch (e) { }
    return null;
  }

  function prepChartOption(opt) {
    try {
      if (!opt || typeof opt !== 'object') return opt;
      if (optionCatLen(opt) <= ZOOM_MIN_CATS) return opt;
      if (opt.yAxis) {
        var ys = Array.isArray(opt.yAxis) ? opt.yAxis : [opt.yAxis];
        var ys2 = ys.map(function (y) {
          if (y && typeof y === 'object') { var c = Object.assign({}, y); c.max = null; c.interval = null; return c; }
          return y;
        });
        opt.yAxis = Array.isArray(opt.yAxis) ? ys2 : ys2[0];
      }
      if (opt.grid && typeof opt.grid === 'object' && !Array.isArray(opt.grid)) {
        opt.grid = Object.assign({}, opt.grid, { bottom: ZOOM_GRID_BOTTOM });
      }
    } catch (e) { }
    return opt;
  }

  function ensureChartZoom(inst) {
    try {
      if (!inst || !inst.__dsuRaw) return;
      var o = inst.getOption();
      var len = optionCatLen(o);
      var zs = o.dataZoom || [];
      if (len > ZOOM_MIN_CATS) {
        if (zs.length) {
          var z0 = readZoomWindow(zs);
          if (z0) inst.__dsuWin = { start: z0.start, end: z0.end != null ? z0.end : 100, len: len };
          return;                                   // 已注入（含用户当前滚动位置），保持不动
        }
        var win = Math.min(len, ZOOM_WINDOW);
        var start = len > win ? +(((1 - win / len) * 100).toFixed(3)) : 0;
        if (inst.__dsuWin && inst.__dsuWin.len === len) start = inst.__dsuWin.start;
        inst.__dsuRaw({
          yAxis: { max: null, interval: null },
          grid: { bottom: ZOOM_GRID_BOTTOM },
          dataZoom: [
            { type: 'inside', xAxisIndex: 0, zoomOnMouseWheel: false, moveOnMouseWheel: false, moveOnMouseMove: true, start: start, end: 100, minValueSpan: 2, throttle: 50 },
            { type: 'slider', xAxisIndex: 0, height: 14, bottom: 2, start: start, end: 100, minValueSpan: 2, showDetail: false, brushSelect: false }
          ]
        });
        inst.__dsuZoomInjected = true;
      }
    } catch (e) { }
  }

  function wrapChartInstance(inst) {
    if (!inst || inst.__dsuWrapped) return;
    try {
      inst.__dsuWrapped = true;
      var orig = inst.setOption.bind(inst);
      inst.__dsuRaw = orig;
      inst.setOption = function () {
        var a = Array.prototype.slice.call(arguments);
        try {
          var len = optionCatLen(a[0]);
          if (len > ZOOM_MIN_CATS) a[0] = prepChartOption(a[0]);
          if (len <= ZOOM_MIN_CATS && inst.__dsuZoomInjected) {
            a[1] = Object.assign({}, (a[1] && typeof a[1] === 'object') ? a[1] : {}, { replaceMerge: ['dataZoom'] });
            inst.__dsuZoomInjected = false;
          }
        } catch (e) { }
        var r = orig.apply(null, a);
        try { ensureChartZoom(inst); } catch (e) { }
        return r;
      };
      ensureChartZoom(inst);
      try { bindWheelPan(inst); } catch (e) { }
    } catch (e) { }
  }

  // 滚轮 = 横向滚动：向下（或向左）滚 → 查看更早的日期；向上（或向右）滚 → 回到更近。
  // 官方 ECharts 构建未实现 moveOnMouseWheel，因此这里自行接管（并阻止页面滚动）。
  function bindWheelPan(inst) {
    if (!inst || inst.__dsuWheelBound) return;
    inst.__dsuWheelBound = true;
    var dom = inst.getDom();
    var lastT = 0;
    dom.addEventListener('wheel', function (e) {
      try {
        var o = inst.getOption();
        var zs = o.dataZoom || [];
        if (!zs.length) return;                              // 未启用增强
        if (e.ctrlKey || e.metaKey || e.shiftKey) return;    // 保留浏览器缩放等行为
        var dx = e.deltaX || 0, dy = e.deltaY || 0;
        var d = Math.abs(dx) > Math.abs(dy) ? dx : dy;       // 正值 = 往回（更早）
        if (!d) return;
        var nowT = Date.now();
        if (nowT - lastT < 45) { e.preventDefault(); return; }
        var len = optionCatLen(o) || 1;
        var z0 = readZoomWindow(zs);
        if (!z0) return;
        var start0 = z0.start;
        var end0 = z0.end != null ? z0.end : 100;
        var span = end0 - start0;
        var step = Math.min(span * 0.5, Math.max(0.5, (30 / len) * 100));
        var delta = d > 0 ? -step : step;
        var s2 = start0 + delta, e2 = end0 + delta;
        if (s2 < 0) { e2 -= s2; s2 = 0; }
        if (e2 > 100) { s2 -= (e2 - 100); e2 = 100; }
        if (s2 < 0) s2 = 0;
        if (Math.abs(s2 - start0) < 0.01 && Math.abs(e2 - end0) < 0.01) return;  // 已到边缘：让页面正常滚动
        lastT = nowT;
        e.preventDefault();
        inst.__dsuRaw({ dataZoom: [{ start: s2, end: e2 }, { start: s2, end: e2 }] });
        inst.__dsuWin = { start: s2, end: e2, len: len };
      } catch (err) { }
    }, { passive: false });
  }

  function scanCharts() {
    try {
      if (location.pathname.indexOf('/usage') !== 0) return;
      var doms = document.querySelectorAll('div[_echarts_instance_]');
      for (var i = 0; i < doms.length; i++) {
        var inst = findChartInstance(doms[i]);
        if (!inst) continue;
        wrapChartInstance(inst);
        ensureChartZoom(inst);
      }
    } catch (e) { }
  }

  /* --------------------------- UI --------------------------- */
  var CSS =
    ':root{--dsu-bg:#fff;--dsu-fg:#0f1115;--dsu-muted:#6b7280;--dsu-chip:#f5f6f7;--dsu-border:rgba(15,17,21,.12);--dsu-accent:#4d6bfe;--dsu-accent-fg:#fff;--dsu-font:inherit;}' +
    '.dsu-mask{position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,.38);display:flex;align-items:center;justify-content:center;font-family:var(--dsu-font);}' +
    '.dsu-panel{width:580px;max-width:92vw;max-height:86vh;overflow:auto;background:var(--dsu-bg);color:var(--dsu-fg);border:1px solid var(--dsu-border);border-radius:16px;box-shadow:0 18px 60px rgba(0,0,0,.28);padding:22px 22px 16px;box-sizing:border-box;}' +
    '.dsu-title{display:flex;align-items:center;gap:8px;font-size:16px;font-weight:600;margin:0 0 8px;}' +
    '.dsu-badge{font-size:11px;font-weight:600;color:var(--dsu-accent);border:1px solid var(--dsu-accent);border-radius:999px;padding:1px 8px;}' +
    '.dsu-note{font-size:12.5px;line-height:1.7;color:var(--dsu-muted);margin:0 0 14px;}' +
    '.dsu-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:10px 0;}' +
    '.dsu-row label{display:inline-flex;align-items:center;gap:6px;font-size:13px;color:var(--dsu-muted);}' +
    '.dsu-btn{font:inherit;font-size:13px;height:34px;padding:0 12px;border-radius:10px;border:1px solid var(--dsu-border);background:var(--dsu-bg);color:var(--dsu-fg);cursor:pointer;}' +
    '.dsu-btn:hover{background:var(--dsu-chip);}' +
    '.dsu-btn[data-active="1"]{border-color:var(--dsu-accent);color:var(--dsu-accent);}' +
    '.dsu-primary{background:var(--dsu-accent);border-color:var(--dsu-accent);color:var(--dsu-accent-fg);font-weight:600;}' +
    '.dsu-primary:hover{filter:brightness(1.07);background:var(--dsu-accent);}' +
    '.dsu-input{font:inherit;font-size:13px;height:34px;padding:0 10px;border-radius:10px;border:1px solid var(--dsu-border);background:var(--dsu-bg);color:var(--dsu-fg);}' +
    '.dsu-status{font-size:12.5px;color:var(--dsu-muted);background:var(--dsu-chip);border-radius:10px;padding:10px 12px;margin:12px 0 2px;line-height:1.7;}' +
    '.dsu-actions{display:flex;gap:10px;margin-top:14px;}' +
    '.dsu-foot{font-size:12px;color:var(--dsu-muted);margin:12px 0 0;line-height:1.7;}' +
    '.dsu-close{margin-left:auto;background:none;border:none;color:var(--dsu-muted);font-size:20px;line-height:1;cursor:pointer;padding:2px 8px;border-radius:8px;}' +
    '.dsu-close:hover{background:var(--dsu-chip);}' +
    '.dsu-hr{border:none;border-top:1px solid var(--dsu-border);margin:16px 0 4px;}' +
    '.dsu-progress{font-size:12.5px;color:var(--dsu-muted);}' +
    '.dsu-toolbtn{display:inline-flex;align-items:center;gap:6px;height:36px;padding:0 14px;margin:0 8px;border-radius:18px;background:var(--dsu-chip);color:var(--dsu-fg);font-size:14px;font-family:var(--dsu-font);cursor:pointer;user-select:none;border:1px solid transparent;}' +
    '.dsu-toolbtn:hover{filter:brightness(.97);}' +
    '.dsu-toolbtn.dsu-on{border-color:var(--dsu-accent);color:var(--dsu-accent);}';

  function installStyle() {
    if (document.getElementById('dsu-style')) return;
    var s = document.createElement('style');
    s.id = 'dsu-style';
    s.textContent = CSS;
    (document.head || document.documentElement).appendChild(s);
  }

  function isDark(color) {
    var m = /rgba?\((\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(String(color));
    if (!m) return false;
    var lum = (0.2126 * +m[1] + 0.7152 * +m[2] + 0.0722 * +m[3]) / 255;
    return lum < 0.5;
  }

  // 从官方页面采样主题（颜色 / 字体），让面板尽量贴近原生外观（含暗色模式自适应）
  function sampleTheme() {
    var root = document.documentElement.style;
    var t = { font: 'inherit' };
    try {
      var b = getComputedStyle(document.body);
      if (b.backgroundColor && b.backgroundColor !== 'rgba(0, 0, 0, 0)') t.bg = b.backgroundColor;
      if (b.color) t.fg = b.color;
      if (b.fontFamily) t.font = b.fontFamily;
    } catch (e) { }
    try {
      var card = document.querySelector('[data-usage-layout-card]');
      if (card) {
        var cb = getComputedStyle(card).backgroundColor;
        if (cb && cb !== 'rgba(0, 0, 0, 0)') t.chip = cb;
      }
    } catch (e) { }
    try {
      var fill = document.querySelector('.ds-button--filled .ds-button__background');
      if (fill) {
        var fb = getComputedStyle(fill).backgroundColor;
        if (fb && fb !== 'rgba(0, 0, 0, 0)') t.accent = fb;
      }
    } catch (e) { }
    try {
      var exp = null, btns = document.querySelectorAll('[role="button"]');
      for (var i = 0; i < btns.length; i++) {
        if ((btns[i].textContent || '').trim() === 'Export' || (btns[i].textContent || '').trim() === '导出') { exp = btns[i]; break; }
      }
      if (exp) { var ec = getComputedStyle(exp).color; if (ec) t.accentFg = ec; }
    } catch (e) { }
    try {
      var note = null, spans = document.querySelectorAll('span');
      for (var j = 0; j < spans.length; j++) {
        if (spans[j].children.length === 0 && /GMT\s?\+0?8/.test(spans[j].textContent || '')) { note = spans[j]; break; }
      }
      if (note) { var nc = getComputedStyle(note).color; if (nc) t.muted = nc; }
    } catch (e) { }

    if (t.bg) root.setProperty('--dsu-bg', t.bg);
    if (t.fg) root.setProperty('--dsu-fg', t.fg);
    if (t.font) root.setProperty('--dsu-font', t.font);
    var dark = t.bg ? isDark(t.bg) : false;
    root.setProperty('--dsu-chip', t.chip || (dark ? 'rgba(255,255,255,.08)' : 'rgba(15,17,21,.05)'));
    root.setProperty('--dsu-muted', t.muted || (dark ? 'rgba(255,255,255,.55)' : 'rgba(15,17,21,.55)'));
    root.setProperty('--dsu-border', dark ? 'rgba(255,255,255,.16)' : 'rgba(15,17,21,.12)');
    if (t.accent) root.setProperty('--dsu-accent', t.accent);
    if (t.accentFg) root.setProperty('--dsu-accent-fg', t.accentFg);
  }

  var CLOCK_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"></circle><path d="M12 7v5l3 2"></path></svg>';

  function ensureButton() {
    try {
      if (location.pathname.indexOf('/usage') !== 0) {
        var old = document.getElementById('dsu-btn');
        if (old) old.remove();
        return;
      }
      var btn = document.getElementById('dsu-btn');
      if (btn && document.contains(btn)) { syncButtonState(btn); return; }
      var exp = null, btns = document.querySelectorAll('[role="button"]');
      for (var i = 0; i < btns.length; i++) {
        var t = (btns[i].textContent || '').trim();
        if (t === 'Export' || t === '导出') { exp = btns[i]; break; }
      }
      if (!exp || !exp.parentElement) return;
      btn = document.createElement('div');
      btn.id = 'dsu-btn';
      btn.className = 'dsu-toolbtn';
      btn.setAttribute('role', 'button');
      btn.tabIndex = 0;
      btn.title = '查询任意时间跨度：自动分片拉取并合并，官方界面原生渲染';
      btn.innerHTML = CLOCK_SVG + '<span>任意时间段</span>';
      btn.addEventListener('click', openPanel);
      btn.addEventListener('keydown', function (e) { if (e.key === 'Enter') openPanel(); });
      exp.parentElement.insertBefore(btn, exp.nextSibling);
      syncButtonState(btn);
    } catch (e) { }
  }
  function syncButtonState(btn) {
    try {
      var st = getState();
      if (st && st.on) btn.classList.add('dsu-on'); else btn.classList.remove('dsu-on');
    } catch (e) { }
  }

  var panel = null;

  function openPanel() {
    installStyle();
    sampleTheme();
    if (!panel) panel = buildPanel();
    refreshPanel();
    panel.mask.style.display = 'flex';
  }
  function closePanel() { if (panel) panel.mask.style.display = 'none'; }

  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }

  function buildPanel() {
    var mask = el('div', 'dsu-mask');
    mask.style.display = 'none';
    var p = el('div', 'dsu-panel');
    mask.appendChild(p);

    var title = el('div', 'dsu-title', '任意时间段查询 <span class="dsu-badge">增强</span>');
    var close = el('button', 'dsu-close', '&times;');
    close.addEventListener('click', closePanel);
    title.appendChild(close);
    p.appendChild(title);

    p.appendChild(el('p', 'dsu-note',
      '官方接口单次最多 31 天，这里会自动拆成多个分片拉取并合并；页面上的总览、图表、明细表仍由官方界面渲染。' +
      '应用后页面会自动刷新，日期筛选将固定显示为你选择的区间。'));
    p.appendChild(el('p', 'dsu-note',
      '长区间的图表会出现横向滑动条：左右拖动滑条，或把鼠标放在图表上滚动滚轮（向下滚 = 往回看更早的日期），即可浏览完整区间（在图表上按住拖动也可平移）。'));
    p.appendChild(el('p', 'dsu-note', '注意：若之后在页面上手动更改了「时间」筛选，增强视图会暂时让位给原生筛选（点「应用」可再次生效）。'));

    var presetRow = el('div', 'dsu-row');
    var presets = [[90, '近 3 个月'], [180, '近 6 个月'], [365, '近 1 年'], [0, '全部']];
    presets.forEach(function (pr) {
      var b = el('button', 'dsu-btn', pr[1]);
      b.addEventListener('click', function () {
        if (pr[0] === 0) { findAll(); return; }
        var tz = effectiveTz();
        var now = Math.floor(Date.now() / 1000);
        var endD = dayStart(now, tz);
        var startD = endD - (pr[0] - 1) * DAY; // 含今天共 pr[0] 天
        setInputs(secToDateStr(startD, tz), secToDateStr(endD, tz));
      });
      presetRow.appendChild(b);
    });
    p.appendChild(presetRow);

    var dateRow = el('div', 'dsu-row');
    var l1 = el('label', '', '开始');
    var i1 = el('input'); i1.type = 'date'; i1.className = 'dsu-input'; i1.id = 'dsu-start';
    l1.appendChild(i1);
    var l2 = el('label', '', '结束');
    var i2 = el('input'); i2.type = 'date'; i2.className = 'dsu-input'; i2.id = 'dsu-end';
    l2.appendChild(i2);
    dateRow.appendChild(l1); dateRow.appendChild(l2);
    p.appendChild(dateRow);

    var keyRow = el('div', 'dsu-row');
    var lk = el('label', '', 'API Key');
    var sel = el('select', 'dsu-input'); sel.id = 'dsu-key';
    var optAll = el('option'); optAll.value = 'all'; optAll.textContent = '全部';
    sel.appendChild(optAll);
    lk.appendChild(sel);
    keyRow.appendChild(lk);
    p.appendChild(keyRow);

    var actions = el('div', 'dsu-actions');
    var apply = el('button', 'dsu-btn dsu-primary', '应用（刷新生效）');
    apply.addEventListener('click', doApply);
    var revert = el('button', 'dsu-btn', '恢复原生');
    revert.addEventListener('click', doRevert);
    actions.appendChild(apply); actions.appendChild(revert);
    p.appendChild(actions);

    var status = el('div', 'dsu-status'); status.id = 'dsu-status';
    p.appendChild(status);

    p.appendChild(el('hr', 'dsu-hr'));

    var csvRow = el('div', 'dsu-row');
    var csv = el('button', 'dsu-btn', '导出 CSV（按天 × Key × 模型）');
    csv.addEventListener('click', doCsv);
    var prog = el('span', 'dsu-progress'); prog.id = 'dsu-progress';
    csvRow.appendChild(csv); csvRow.appendChild(prog);
    p.appendChild(csvRow);

    p.appendChild(el('p', 'dsu-foot',
      '时区跟随页面设置（当前 ' + tzText() + '）；数据最多延迟 5 分钟。' +
      '所有查询仅发生在你的浏览器本地，不修改账号数据。'));

    mask.addEventListener('click', function (e) { if (e.target === mask) closePanel(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closePanel(); });

    (document.body || document.documentElement).appendChild(mask);
    return { mask: mask, panel: p };
  }

  function tzText() {
    var tz = effectiveTz();
    var sign = tz >= 0 ? '+' : '-';
    var abs = Math.abs(tz);
    var h = Math.floor(abs / 3600), m = Math.floor((abs % 3600) / 60);
    return 'GMT' + sign + h + (m ? ':' + pad2(m) : '');
  }

  function $(id) { return document.getElementById(id); }
  function setInputs(sv, ev) {
    var i1 = $('dsu-start'), i2 = $('dsu-end');
    if (!i1 || !i2) return;
    var tz = effectiveTz();
    var today = secToDateStr(dayStart(Math.floor(Date.now() / 1000), tz), tz);
    i1.min = EARLIEST; i1.max = today;
    i2.min = EARLIEST; i2.max = today;
    if (sv) i1.value = sv;
    if (ev) i2.value = ev;
  }

  function refreshPanel() {
    var st = getState();
    var tz = effectiveTz();
    if (st && st.on) {
      setInputs(secToDateStr(st.start, tz), secToDateStr(st.end - DAY, tz));
    } else if (!$('dsu-start').value) {
      var now = Math.floor(Date.now() / 1000);
      var endD = dayStart(now, tz);
      setInputs(secToDateStr(endD - 89 * DAY, tz), secToDateStr(endD, tz));
    }
    updateStatus();
    loadKeys();
  }

  function updateStatus() {
    var el2 = $('dsu-status');
    if (!el2) return;
    var st = getState();
    var tz = effectiveTz();
    var msg;
    if (st && st.on) {
      msg = '增强模式已开启，页面固定显示：<b>' + rangeLabel(st.start, st.end, tz) + '</b>（' + Math.round((st.end - st.start) / DAY) + ' 天）';
      if (!applied()) msg += '<br>⚠ 检测到页面上的「时间」筛选已被手动更改，增强视图暂时失效；点「应用」可重新生效。';
    } else {
      msg = '当前为原生模式（最多 31 天）。选择区间后点「应用」开启增强。';
    }
    el2.innerHTML = msg;
  }

  function doApply() {
    try {
      var sv = ($('dsu-start') || {}).value, ev = ($('dsu-end') || {}).value;
      if (!sv || !ev) return setProgress('请先选择开始和结束日期');
      var tz = effectiveTz();
      var s = dateStrToSec(sv, tz);
      var e = dateStrToSec(ev, tz) + DAY;
      if (e <= s) return setProgress('结束日期需要晚于开始日期');
      var st0 = getState();
      var p = readPref() || { version: 1 };
      var st = { on: true, start: s, end: e };
      if (!(st0 && st0.on)) {           // 记录首次开启前的官方筛选，供「恢复原生」还原
        st.prevDateFilter = p.dateFilter || null;
        st.prevApiKeyFilter = p.apiKeyFilter || null;
      } else {
        st.prevDateFilter = st0.prevDateFilter || null;
        st.prevApiKeyFilter = st0.prevApiKeyFilter || null;
      }
      var sel = $('dsu-key');
      var kv = sel ? sel.value : 'all';
      p.dateFilter = { kind: 'preset', preset: 'last30Days' };   // 受控标记
      p.apiKeyFilter = kv === 'all' ? { kind: 'all' } : { kind: 'selected', trackingIds: [kv] };
      if (!writePref(p)) return setProgress('写入页面偏好失败，请刷新后重试');
      setState(st);
      location.reload();
    } catch (err) { setProgress('应用失败：' + err); }
  }

  function doRevert() {
    try {
      var st = getState() || {};
      var p = readPref() || {};
      p.dateFilter = st.prevDateFilter || { kind: 'preset', preset: 'last30Days' };
      p.apiKeyFilter = st.prevApiKeyFilter || { kind: 'all' };
      writePref(p);
      st.on = false; st.prevDateFilter = null; st.prevApiKeyFilter = null;
      setState(st);
      location.reload();
    } catch (err) { setProgress('恢复失败：' + err); }
  }

  function setProgress(txt) {
    var p = $('dsu-progress');
    if (p) p.textContent = txt || '';
  }

  function loadKeys() {
    var sel = $('dsu-key');
    if (!sel || sel.dataset.loaded === '1' || sel.dataset.loading === '1') return;
    var token = getToken();
    if (!token) return;
    sel.dataset.loading = '1';
    fetch(KEY_API, { credentials: 'include', headers: { Authorization: 'Bearer ' + token } })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        var arr = (j && j.data && j.data.biz_data && j.data.biz_data.api_keys) || [];
        arr.forEach(function (k) {
          var o = document.createElement('option');
          o.value = k.tracking_id;
          o.textContent = k.name + ' · ' + k.sensitive_id;
          sel.appendChild(o);
        });
        var p = readPref();
        var f = p && p.apiKeyFilter;
        if (f && f.kind === 'selected' && f.trackingIds && f.trackingIds[0]) sel.value = f.trackingIds[0];
        sel.dataset.loaded = '1';
      })
      .catch(function () { })
      .then(function () { sel.dataset.loading = ''; });
  }

  // 「全部」：定位最早有数据的日期。
  // 做法：以「最早 API Key 创建时间 - 31 天」为下界，从今天起按 31 天窗口向前逐窗扫描，
  // 取所有窗口中出现过"非零用量"的最早一天（每个窗口仅 1 个请求，且 ≤31 天不触发接口上限）。
  // 注意：不能用二分查找——用量日期间可能存在断档（如 8/11~8/12 有数据、而后空白到 8/30），
  // 二分会被断档误导，逐窗扫描则不受影响。
  function findAll() {
    var tz = effectiveTz();
    var now = Math.floor(Date.now() / 1000);
    var todayStart = dayStart(now, tz);
    setProgress('正在定位最早数据…');
    var cache = null;
    try { cache = JSON.parse(localStorage.getItem('deepseek.usage.enhancer.earliest')); } catch (e) { cache = null; }
    if (cache && cache.v === 2 && cache.tz === tz && cache.day > 0 && cache.day <= todayStart) {
      setInputs(secToDateStr(cache.day, tz), secToDateStr(todayStart, tz));
      setProgress('最早有数据的日期：' + secToDateStr(cache.day, tz));
      return;
    }
    var token = getToken();
    if (!token) { setProgress('未登录：找不到 userToken'); return; }
    var floor0 = dateStrToSec(EARLIEST, tz);
    function scan(floor) {
      var earliest = 0;
      var total = Math.ceil((todayStart + DAY - floor) / CAP);
      var idx = 0;
      function win(wEnd) {
        if (wEnd <= floor) return Promise.resolve();
        var wStart = Math.max(floor, wEnd - CAP);
        idx++;
        setProgress('扫描中… ' + idx + '/' + total + '（' + secToDateStr(wStart, tz) + ' ~ ' + secToDateStr(wEnd - DAY, tz) + '）');
        return fetch(usageUrl('amount', wStart, wEnd, tz), {
          credentials: 'include',
          headers: { Authorization: 'Bearer ' + token }
        }).then(function (r) { return r.json(); }).then(function (j) {
          var ss = (j && j.data && j.data.biz_data && j.data.biz_data.series) || [];
          for (var a = 0; a < ss.length; a++) {
            var bs = ss[a].buckets || [];
            for (var b = 0; b < bs.length; b++) {
              var u = bs[b].usage || {};
              var v = Number(u.REQUEST || 0) + Number(u.RESPONSE_TOKEN || 0) +
                      Number(u.PROMPT_CACHE_HIT_TOKEN || 0) + Number(u.PROMPT_CACHE_MISS_TOKEN || 0);
              if (v > 0 && (earliest === 0 || bs[b].time < earliest)) earliest = bs[b].time;
            }
          }
          return win(wStart);
        }).catch(function () { return win(wStart); });   // 单个窗口失败则跳过，继续向前
      }
      return win(todayStart + DAY).then(function () { return earliest; });
    }
    fetch(KEY_API, { credentials: 'include', headers: { Authorization: 'Bearer ' + token } })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        var arr = (j && j.data && j.data.biz_data && j.data.biz_data.api_keys) || [];
        var minC = 0;
        for (var i = 0; i < arr.length; i++) {
          var c = Number(arr[i].created_at);
          if (isFinite(c) && c > 0 && (minC === 0 || c < minC)) minC = c;
        }
        var floor = minC ? dayStart(minC, tz) - CAP : floor0;
        if (floor < floor0) floor = floor0;
        return scan(floor);
      })
      .catch(function () { return scan(floor0); })
      .then(function (earliest) {
        var found = earliest;
        if (!earliest) earliest = todayStart - 89 * DAY;    // 没有任何数据时的兜底
        setInputs(secToDateStr(earliest, tz), secToDateStr(todayStart, tz));
        setProgress('最早有数据的日期：' + secToDateStr(earliest, tz) + (found ? '' : '（未发现任何数据）'));
        if (found) {
          try { localStorage.setItem('deepseek.usage.enhancer.earliest', JSON.stringify({ v: 2, tz: tz, day: found, at: now })); } catch (e) { }
        }
      })
      .catch(function (e) { setProgress('定位失败（' + e + '），请手动选择日期'); });
  }

  function csvCell(v) {
    var s = v == null ? '' : String(v);
    if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function doCsv() {
    var st = getState();
    if (!st || !st.on) return setProgress('请先「应用」一个时间段');
    var tz = effectiveTz();
    var p = readPref();
    var f = p && p.apiKeyFilter;
    var onlyTid = f && f.kind === 'selected' && f.trackingIds && f.trackingIds[0] ? f.trackingIds[0] : null;
    setProgress('正在拉取费用数据…');
    var prog = function (d, n) { setProgress('费用分片 ' + d + '/' + n); };
    fetchMerged('cost', st.start, st.end, tz, prog).then(function (cost) {
      setProgress('正在拉取用量数据…');
      return fetchMerged('amount', st.start, st.end, tz, function (d, n) { setProgress('用量分片 ' + d + '/' + n); }).then(function (amt) {
        return { cost: cost, amt: amt };
      });
    }).then(function (both) {
      var rows = {};
      function add(key, obj) { rows[key] = rows[key] || obj; return rows[key]; }
      (function () {
        var arr = (both.cost.data.biz_data.data) || [];
        arr.forEach(function (cur) {
          (cur.series || []).forEach(function (ser) {
            if (onlyTid && ser.api_key.tracking_id !== onlyTid) return;
            (ser.buckets || []).forEach(function (b) {
              var r = add(b.time + '|' + ser.api_key.tracking_id + '|' + ser.model, {
                time: b.time, name: ser.api_key.name, tid: ser.api_key.tracking_id,
                model: ser.model, cost: '', currency: cur.currency
              });
              r.cost = b.cost;
            });
          });
        });
      })();
      (function () {
        var ss = (both.amt.data.biz_data.series) || [];
        ss.forEach(function (ser) {
          if (onlyTid && ser.api_key.tracking_id !== onlyTid) return;
          (ser.buckets || []).forEach(function (b) {
            var r = add(b.time + '|' + ser.api_key.tracking_id + '|' + ser.model, {
              time: b.time, name: ser.api_key.name, tid: ser.api_key.tracking_id,
              model: ser.model, cost: '', currency: ''
            });
            var u = b.usage || {};
            r.req = u.REQUEST || 0;
            r.hit = u.PROMPT_CACHE_HIT_TOKEN || 0;
            r.miss = u.PROMPT_CACHE_MISS_TOKEN || 0;
            r.out = u.RESPONSE_TOKEN || 0;
          });
        });
      })();
      var list = Object.keys(rows).map(function (k) { return rows[k]; });
      list.sort(function (a, b) { return a.time - b.time || String(a.tid).localeCompare(String(b.tid)) || String(a.model).localeCompare(String(b.model)); });
      var head = ['日期', 'API Key', 'Tracking ID', '模型', '请求次数', '输入缓存命中token', '输入缓存未命中token', '输出token', '费用', '币种'];
      var lines = [head.join(',')];
      list.forEach(function (r) {
        lines.push([
          secToDateStr(r.time, tz), r.name || '', r.tid || '', r.model || '',
          r.req || 0, r.hit || 0, r.miss || 0, r.out || 0,
          r.cost === '' ? '' : r.cost, r.currency || ''
        ].map(csvCell).join(','));
      });
      var csv = '\ufeff' + lines.join('\r\n');
      var name = 'deepseek-usage_' + secToDateStr(st.start, tz) + '_' + secToDateStr(st.end - DAY, tz) + '.csv';
      var blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url; a.download = name;
      (document.body || document.documentElement).appendChild(a);
      a.click();
      setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 1000);
      setProgress('已导出 ' + list.length + ' 行 → ' + name);
    }).catch(function (e) {
      setProgress('导出失败：' + e);
    });
  }

  /* --------------------------- 启动 --------------------------- */
  function init() {
    installStyle();
    setInterval(relabelTick, 700);
    setInterval(ensureButton, 1200);
    setInterval(scanCharts, 1300);
    try {
      var pendingBtn = false, pendingChart = false;
      new MutationObserver(function () {
        if (!pendingBtn) {
          pendingBtn = true;
          setTimeout(function () { pendingBtn = false; ensureButton(); }, 120);
        }
        if (!pendingChart) {
          pendingChart = true;
          setTimeout(function () { pendingChart = false; scanCharts(); }, 400);
        }
      }).observe(document.documentElement, { childList: true, subtree: true });
    } catch (e) { }
    ensureButton();
    scanCharts();
    console.log('[任意时间段增强 v' + DS.version + '] 已加载。按钮将出现在用量页「Export」旁；长区间图表支持横向滚动。');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // 调试出口（仅供本页控制台排查问题使用）
  DS.fetchMerged = fetchMerged;
  DS.padBuckets = padBuckets;
  DS.scanCharts = scanCharts;
})();
