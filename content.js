/*!
 * DeepSeek 用量 · 任意时间段 v3.0.0
 * 全新实现（不依赖旧版代码）。设计目标：官网接口 / 前端轻微改动时保持工作；
 * 任何内部失败都自动回退为原生请求，绝不影响页面本身。
 *
 * 原理：
 *   1. 在页面上下文（MAIN world）拦截官方用量请求 /api/v0/usage/by_api_key/*；
 *   2. 把目标区间按「≤31 个按天桶」自动拆片（官网后端的单次查询上限），并发拉取；
 *   3. 以「结构无关」方式合并分片（未知字段原样保留、series 按身份合并、桶按时间合并），
 *      并为区间内每天补齐零值桶、补齐官方前端无条件解引用的 function_series 数组；
 *   4. 把合并结果伪装成一次官方响应交还给页面（fetch 返回合成 Response；
 *      XHR 用本地 Blob URL 重放，响应状态机完全原生）。
 * 只读：仅查询本人账号用量，不修改任何账号数据；Manifest 无 permissions。
 */
(function () {
  'use strict';
  if (window.__DSU_LOADED__) return;
  window.__DSU_LOADED__ = true;

  /* ===================== 常量 ===================== */
  var VERSION = '3.0.0';
  var DAY = 86400;
  var MAX_SHARD_DAYS = 31;        // 官方后端单次查询上限：31 个按天桶（已实测：32 即 INVALID_PARAM）
  var CONCURRENCY = 3;            // 分片并发数
  var RETRIES = 2;                // 每个分片失败重试次数
  var REQ_TIMEOUT_MS = 60000;     // 单次分片请求超时
  var MAX_SPAN_DAYS = 4000;       // 区间安全阀（约 11 年）
  var STATE_KEY = 'dsu3.state';
  var PREF_PREFIX = 'deepseek.platform.usage.boardPreference.v1.';
  var PROBE_MAX_WINDOWS = 36;     // 「全部」向前最多探测约 3 年
  var PROBE_EMPTY_STOP = 3;       // 连续空窗口数达到即认为到头

  /* ===================== 日志 ===================== */
  var TAG = '[DeepSeek用量增强 v' + VERSION + ']';
  function log() { try { console.log.apply(console, [TAG].concat([].slice.call(arguments))); } catch (e) {} }
  function warn() { try { console.warn.apply(console, [TAG].concat([].slice.call(arguments))); } catch (e) {} }

  /* ===================== 基础工具 ===================== */
  function isObj(x) { return !!x && typeof x === 'object' && !Array.isArray(x); }
  function isNumLike(x) {
    if (typeof x === 'number') return isFinite(x);
    return typeof x === 'string' && x.trim() !== '' && isFinite(Number(x));
  }
  function toNum(x) { var n = Number(x); return isFinite(n) ? n : 0; }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function parseUrl(u) { try { return new URL(u, location.href); } catch (e) { return null; } }

  /* ===================== 时间工具（按天 / 按时区对齐） ===================== */
  function dayStart(ts, tz) { return Math.floor((ts + tz) / DAY) * DAY - tz; }
  function dateStrToSec(s, tz) {
    var a = String(s).split('-');
    return Date.UTC(+a[0], +a[1] - 1, +a[2]) / 1000 - tz;
  }
  function secToDateStr(ts, tz) {
    var d = new Date((ts + tz) * 1000);
    return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
  }
  function rangeLabel(startSec, endEx, tz) {
    var last = endEx - DAY;
    var a = new Date((startSec + tz) * 1000), b = new Date((last + tz) * 1000);
    var sameYear = a.getUTCFullYear() === b.getUTCFullYear();
    function f(d) {
      var mm = pad2(d.getUTCMonth() + 1), dd = pad2(d.getUTCDate());
      return sameYear ? mm + '/' + dd : d.getUTCFullYear() + '/' + mm + '/' + dd;
    }
    return f(a) + ' - ' + f(b);
  }
  function deviceTz() { try { return -new Date().getTimezoneOffset() * 60; } catch (e) { return 28800; } }
  function effectiveTz() {
    try {
      var ks = Object.keys(localStorage);
      for (var i = 0; i < ks.length; i++) {
        if (ks[i].indexOf(PREF_PREFIX) === 0) {
          var p = JSON.parse(localStorage.getItem(ks[i]) || 'null');
          var t = p && p.tzPreference;
          if (t != null && t !== 'device') {
            var n = Number(t);
            if (isFinite(n) && Math.abs(n) <= 64800) return n;
          }
        }
      }
    } catch (e) {}
    return deviceTz();
  }

  /* ===================== 状态 ===================== */
  function defaultState() {
    var tz = effectiveTz();
    var end = dayStart(Date.now() / 1000, tz) + DAY;
    return { v: 3, on: false, start: end - 90 * DAY, end: end, tz: tz, keyId: 'all', snap: null, earliest: null };
  }
  function loadState() {
    try {
      var s = JSON.parse(localStorage.getItem(STATE_KEY) || 'null');
      if (s && s.v === 3 && isNumLike(s.start) && isNumLike(s.end)) {
        s.tz = isNumLike(s.tz) ? Number(s.tz) : effectiveTz();
        return s;
      }
    } catch (e) {}
    return defaultState();
  }
  function saveState() { try { localStorage.setItem(STATE_KEY, JSON.stringify(state)); } catch (e) {} }
  var state = loadState();

  /* 官方筛选偏好（仅用于「用户手动改筛选 → 让位原生」的检测，不写入） */
  function prefKey() {
    try {
      var ks = Object.keys(localStorage);
      for (var i = 0; i < ks.length; i++) if (ks[i].indexOf(PREF_PREFIX) === 0) return ks[i];
    } catch (e) {}
    return null;
  }
  function dateFilterJson() {
    try {
      var k = prefKey();
      if (!k) return null;
      var p = JSON.parse(localStorage.getItem(k) || 'null');
      return JSON.stringify((p && p.dateFilter) || null);
    } catch (e) { return null; }
  }
  function yieldCheck() {
    try {
      if (!state.on) return true;
      var cur = dateFilterJson();
      if (state.snap == null) { state.snap = cur; saveState(); return false; }
      if (cur !== state.snap) {
        state.on = false;
        state.snap = null;
        saveState();
        log('检测到官方时间筛选被手动更改，增强已让位（点「任意时间段」可重新启用）');
        return true;
      }
    } catch (e) {}
    return false;
  }

  /* ===================== 登录态 / 请求头 ===================== */
  function tokenCandidates() {
    var out = [];
    try {
      var ks = Object.keys(localStorage);
      for (var i = 0; i < ks.length; i++) {
        var k = ks[i], v = localStorage.getItem(k);
        if (!v || !/token/i.test(k)) continue;
        try {
          var j = JSON.parse(v);
          if (j && typeof j.value === 'string' && j.value.length > 8) out.push(j.value);
          else if (typeof j === 'string' && j.length > 8) out.push(j);
        } catch (e) {
          if (v.length > 8 && v.length < 512 && v.indexOf('{') !== 0) out.push(v);
        }
      }
    } catch (e) {}
    return out;
  }
  function deviceId() {
    try {
      var ks = Object.keys(localStorage);
      for (var i = 0; i < ks.length; i++) {
        if (/device-id/i.test(ks[i])) {
          var v = localStorage.getItem(ks[i]);
          if (v) return v;
        }
      }
    } catch (e) {}
    return '';
  }
  function baseHeaders() {
    var h = {
      accept: '*/*',
      'x-client-bundle-id': 'com.deepseek.chat',
      'x-client-locale': 'en_US',
      'x-client-platform': 'web',
      'x-client-timezone-offset': String(state.tz),
      'x-client-version': '1.0.0'
    };
    var d = deviceId();
    if (d) h['x-device-id'] = d;
    return h;
  }
  function mergeHeaders(base, extra) {
    var out = {}, k;
    for (k in base) if (Object.prototype.hasOwnProperty.call(base, k)) out[k] = base[k];
    for (k in (extra || {})) {
      if (!Object.prototype.hasOwnProperty.call(extra, k)) continue;
      if (extra[k] == null) continue;
      if (/^(host|content-length|connection|accept-encoding)$/i.test(k)) continue;
      out[k] = extra[k];
    }
    return out;
  }

  /* ===================== 网络（带超时 / 重试 / token 兜底） ===================== */
  var realFetch = window.fetch ? window.fetch.bind(window) : function () { return Promise.reject(new Error('no fetch')); };

  function withTimeout(p, ms) {
    return new Promise(function (resolve, reject) {
      var t = setTimeout(function () { reject(new Error('请求超时')); }, ms);
      p.then(function (v) { clearTimeout(t); resolve(v); }, function (e) { clearTimeout(t); reject(e); });
    });
  }
  function httpJson(url, headers) {
    return withTimeout(realFetch(url, { headers: headers, credentials: 'same-origin' }), REQ_TIMEOUT_MS).then(function (r) {
      return r.text().then(function (t) {
        try { return JSON.parse(t); } catch (e) { throw new Error('响应不是 JSON (HTTP ' + r.status + ')'); }
      });
    });
  }
  // 优先复用页面请求自带的 Authorization；若报 Missing Token 则回退本地 token 候选
  function authJson(url, headers) {
    var cands = tokenCandidates();
    if (!cands.length) cands = [null];
    var i = 0;
    function attempt() {
      var h = {};
      for (var k in headers) if (Object.prototype.hasOwnProperty.call(headers, k)) h[k] = headers[k];
      if (!h.authorization && !h.Authorization && cands[i]) h.authorization = 'Bearer ' + cands[i];
      return httpJson(url, h).then(function (j) {
        var s = '';
        try { s = JSON.stringify(j); } catch (e) {}
        if (/Missing Token/i.test(s) && i + 1 < cands.length) { i++; return attempt(); }
        return j;
      });
    }
    return attempt();
  }

  /* ===================== 请求识别（宽松匹配，容忍路径微调） ===================== */
  function matchUsage(url) {
    var u = parseUrl(url);
    if (!u) return null;
    if (u.pathname.indexOf('/usage/') < 0) return null;
    var m = u.pathname.match(/\/usage\/(?:by_api_key\/)?([^\/]+)\/?$/i);
    if (!m) return null;
    if (!u.searchParams.has('start') || !u.searchParams.has('end')) return null;
    return { kind: m[1], parsed: u };
  }

  /* ===================== 结构无关合并 ===================== */
  var VOLATILE_KEYS = /^(time|timestamp|ts|created_at|updated_at|last_use|last_.+|at)$/i;

  function sigObj(o) {
    var out = {};
    for (var k in o) {
      if (!Object.prototype.hasOwnProperty.call(o, k)) continue;
      if (k === 'buckets') continue;
      if (VOLATILE_KEYS.test(k)) continue;
      var v = o[k];
      if (Array.isArray(v)) continue;
      if (isObj(v)) { var s = sigObj(v); if (s && Object.keys(s).length) out[k] = s; }
      else out[k] = v;
    }
    return out;
  }
  function sigKey(o) { try { return JSON.stringify(sigObj(o)); } catch (e) { return null; } }

  function mergeVals(a, b, key) {
    if (a === undefined || a === null) return b;
    if (b === undefined || b === null) return a;
    if (Array.isArray(a) && Array.isArray(b)) return mergeArr(a, b);
    if (isObj(a) && isObj(b)) return mergeObj(a, b);
    if ((key === 'start' || key === 'end') && isNumLike(a) && isNumLike(b)) {
      return key === 'start' ? Math.min(toNum(a), toNum(b)) : Math.max(toNum(a), toNum(b));
    }
    return a; // 标量：首个非空值优先，保留原始语义
  }
  function mergeObj(a, b) {
    var out = {}, k;
    for (k in a) if (Object.prototype.hasOwnProperty.call(a, k)) out[k] = a[k];
    for (k in b) if (Object.prototype.hasOwnProperty.call(b, k)) out[k] = mergeVals(out[k], b[k], k);
    return out;
  }
  function isBucketArr(arr) {
    return arr.length > 0 && arr.every(function (e) { return isObj(e) && isNumLike(e.time); });
  }
  function mergeArr(a, b) {
    if (!a.length) return b.slice();
    if (!b.length) return a.slice();
    // 桶数组：按 time 合并
    if (isBucketArr(a) && isBucketArr(b)) {
      var map = new Map();
      a.concat(b).forEach(function (e) {
        var t = toNum(e.time);
        map.set(t, map.has(t) ? mergeObj(map.get(t), e) : e);
      });
      return Array.from(map.keys()).sort(function (x, y) { return x - y; }).map(function (t) { return map.get(t); });
    }
    var scalar = function (e) { return !isObj(e) && !Array.isArray(e); };
    // 标量数组（models / functions 之类）：按值取并集
    if (a.every(scalar) && b.every(scalar)) {
      var seen = new Set(), out = [];
      a.concat(b).forEach(function (e) {
        var k = String(e);
        if (!seen.has(k)) { seen.add(k); out.push(e); }
      });
      return out;
    }
    // 对象数组（series / function_series / data 等）：按“身份签名”合并
    var map2 = new Map(), extra = [];
    a.concat(b).forEach(function (e) {
      if (!isObj(e)) { extra.push(e); return; }
      var k2 = sigKey(e);
      if (k2 == null) { extra.push(e); return; }
      map2.set(k2, map2.has(k2) ? mergeObj(map2.get(k2), e) : e);
    });
    return Array.from(map2.values()).concat(extra);
  }
  function mergeResponses(list) {
    if (!list || !list.length) throw new Error('没有可合并的分片');
    return list.reduce(function (acc, j) { return mergeVals(acc, j); });
  }

  /* ---- 数据节点定位 / 补零 / 防崩溃兜底 ---- */
  function findGridNodes(node, out) {
    if (!node || typeof node !== 'object') return out;
    if (!Array.isArray(node) && isNumLike(node.start) && isNumLike(node.end) && isNumLike(node.bucket)) out.push(node);
    if (Array.isArray(node)) {
      node.forEach(function (c) { findGridNodes(c, out); });
    } else {
      for (var k in node) if (Object.prototype.hasOwnProperty.call(node, k)) findGridNodes(node[k], out);
    }
    return out;
  }
  // 找到所有「series 形态」数组（每个元素都是带 buckets 数组的对象）
  function walkSeriesArrays(node, fn) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(function (c) { walkSeriesArrays(c, fn); }); return; }
    for (var k in node) {
      if (!Object.prototype.hasOwnProperty.call(node, k)) continue;
      var v = node[k];
      if (Array.isArray(v) && v.length && v.every(function (e) { return isObj(e) && Array.isArray(e.buckets); })) fn(v);
      walkSeriesArrays(v, fn);
    }
  }
  function zeroVal(v) {
    if (typeof v === 'number') return 0;
    if (typeof v === 'string') return (v.trim() !== '' && isFinite(Number(v))) ? '0' : v;
    if (Array.isArray(v)) return [];
    if (isObj(v)) {
      var o = {};
      for (var k in v) if (Object.prototype.hasOwnProperty.call(v, k)) o[k] = zeroVal(v[k]);
      return o;
    }
    return v;
  }
  function zeroBucket(t, tpl) {
    var out = {};
    if (tpl) {
      for (var k in tpl) {
        if (!Object.prototype.hasOwnProperty.call(tpl, k)) continue;
        out[k] = (k === 'time') ? t : zeroVal(tpl[k]);
      }
    }
    out.time = t;
    return out;
  }
  function fillBuckets(buckets, times) {
    var map = new Map(), tpl = null;
    (buckets || []).forEach(function (b) {
      if (!isObj(b)) return;
      if (tpl === null) tpl = b;
      map.set(toNum(b.time), b);
    });
    return times.map(function (t) { return map.has(t) ? map.get(t) : zeroBucket(t, tpl); });
  }
  function zeroFillGrid(g) {
    var bucket = isNumLike(g.bucket) ? toNum(g.bucket) : DAY;
    if (!(bucket > 0)) bucket = DAY;
    var s = toNum(g.start), e = toNum(g.end);
    var times = [];
    for (var t = s; t < e; t += bucket) times.push(t);
    walkSeriesArrays(g, function (arr) {
      arr.forEach(function (series) {
        try { series.buckets = fillBuckets(series.buckets, times); } catch (err) {}
      });
    });
  }
  function normalizeSeries(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(normalizeSeries); return; }
    // 官方前端对 function_series 无条件 .map()——缺失即整页报错，这里强制补空数组
    if (Array.isArray(node.series) && node.function_series == null) node.function_series = [];
    for (var k in node) if (Object.prototype.hasOwnProperty.call(node, k)) normalizeSeries(node[k]);
  }
  function finalize(merged, start, end) {
    var grids = findGridNodes(merged, []);
    if (!grids.length) throw new Error('合并结果缺少数据节点（结构变化？）');
    grids.forEach(function (g) {
      g.start = start;
      g.end = end;
      try { zeroFillGrid(g); } catch (e) { warn('补零失败（忽略）', e); }
    });
    normalizeSeries(merged);
    return merged;
  }

  /* ===================== 分片拉取 ===================== */
  function planShards(start, end) {
    var step = MAX_SHARD_DAYS * DAY, out = [];
    for (var s = start; s < end; s += step) out.push({ s: s, e: Math.min(s + step, end) });
    return out;
  }
  function pool(tasks, limit) {
    return new Promise(function (resolve, reject) {
      var idx = 0, active = 0, settled = 0, results = new Array(tasks.length), failed = false;
      function step() {
        if (settled >= tasks.length && !failed) { resolve(results); return; }
        while (!failed && active < limit && idx < tasks.length) {
          (function (i) {
            active++;
            Promise.resolve().then(tasks[i]).then(function (r) {
              results[i] = r;
              active--; settled++;
              step();
            }, function (e) {
              failed = true;
              reject(e);
            });
          })(idx++);
        }
      }
      step();
    });
  }
  function fetchShardWithRetry(url, headers) {
    function go(n) {
      return authJson(url, headers).then(function (j) {
        if (!findGridNodes(j, []).length) throw new Error('分片响应缺少数据节点');
        return j;
      })['catch'](function (e) {
        if (n < RETRIES) {
          return new Promise(function (res) { setTimeout(res, 400 * (n + 1)); }).then(function () { return go(n + 1); });
        }
        throw e;
      });
    }
    return go(0);
  }
  function buildUrl(kind) {
    var u = new URL('/api/v0/usage/by_api_key/' + kind, location.href);
    u.searchParams.set('start', String(state.start));
    u.searchParams.set('end', String(state.end));
    u.searchParams.set('tz', String(state.tz));
    return u.href;
  }
  function fetchMerged(kind, start, end, origUrl, reqHeaders, onProgress) {
    if (!(end > start)) return Promise.reject(new Error('区间非法'));
    if ((end - start) > MAX_SPAN_DAYS * DAY) return Promise.reject(new Error('区间超出安全上限'));
    var parsed = parseUrl(origUrl);
    var shards = planShards(start, end);
    var headers = mergeHeaders(baseHeaders(), reqHeaders);
    var done = 0;
    var progress = onProgress || function (m) { try { ui && ui.setStatus && ui.setStatus(m); } catch (e) {} };
    var tasks = shards.map(function (sh) {
      return function () {
        var u = parsed ? new URL(parsed.href) : new URL('/api/v0/usage/by_api_key/' + kind, location.href);
        u.searchParams.set('start', String(sh.s));
        u.searchParams.set('end', String(sh.e));
        if (!u.searchParams.has('tz')) u.searchParams.set('tz', String(state.tz));
        return fetchShardWithRetry(u.href, headers).then(function (j) {
          done++;
          try { progress('正在拉取分片 ' + done + '/' + shards.length + '…'); } catch (e) {}
          return j;
        });
      };
    });
    return pool(tasks, CONCURRENCY).then(function (list) {
      var merged = mergeResponses(list);
      return finalize(merged, start, end);
    });
  }

  /* ===================== 拦截：fetch ===================== */
  function reqUrl(input) {
    try {
      if (typeof input === 'string') return input;
      if (input && typeof input.url === 'string') return input.url;
      if (input && input.href) return input.href;
    } catch (e) {}
    return '';
  }
  function collectReqHeaders(input, init) {
    var h = {};
    try {
      var src = (init && init.headers) || (input && input.headers);
      if (src && typeof src.forEach === 'function') src.forEach(function (v, k) { h[k] = v; });
      else if (src) Object.keys(src).forEach(function (k) { h[k] = src[k]; });
    } catch (e) {}
    return h;
  }
  function serveUsage(kind, origUrl, reqHeaders) {
    return fetchMerged(kind, state.start, state.end, origUrl, reqHeaders).then(function (merged) {
      return JSON.stringify(merged);
    });
  }
  try {
    window.fetch = function (input, init) {
      try {
        var url = reqUrl(input);
        var m = state.on && url ? matchUsage(url) : null;
        if (!m || yieldCheck()) return realFetch(input, init);
        return serveUsage(m.kind, url, collectReqHeaders(input, init)).then(function (text) {
          return new Response(text, {
            status: 200,
            statusText: 'OK',
            headers: { 'content-type': 'application/json; charset=utf-8' }
          });
        })['catch'](function (e) {
          warn('增强服务失败，已回退原生请求:', (e && e.message) || e);
          return realFetch(input, init);
        });
      } catch (e) {
        return realFetch(input, init);
      }
    };
  } catch (e) { warn('fetch 拦截安装失败', e); }

  /* ===================== 拦截：XHR（Blob URL 重放） ===================== */
  try {
    var xo = XMLHttpRequest.prototype.open;
    var xs = XMLHttpRequest.prototype.setRequestHeader;
    var xd = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) {
      try { this.__dsu = { method: method, url: String(url), headers: {} }; } catch (e) {}
      return xo.apply(this, arguments);
    };
    XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
      try { if (this.__dsu) this.__dsu.headers[k] = v; } catch (e) {}
      return xs.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function () {
      var args = arguments, self = this, info = this.__dsu;
      try {
        var m = (state.on && info && info.url) ? matchUsage(info.url) : null;
        if (!m || yieldCheck()) return xd.apply(self, args);
        var rt = self.responseType;
        serveUsage(m.kind, info.url, info.headers).then(function (text) {
          var blobUrl = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
          self.addEventListener('loadend', function () { try { URL.revokeObjectURL(blobUrl); } catch (e) {} });
          xo.call(self, info.method || 'GET', blobUrl);
          try { self.responseType = rt; } catch (e) {}
          xd.call(self, null);
        })['catch'](function (e) {
          warn('增强服务失败(XHR)，已回退原生请求:', (e && e.message) || e);
          try { xd.apply(self, args); } catch (e2) {}
        });
      } catch (e) {
        try { return xd.apply(self, args); } catch (e2) {}
      }
    };
  } catch (e) { warn('XHR 拦截安装失败', e); }

  /* ===================== 数据提取（表格 / CSV / KPI） ===================== */
  function collectSeriesRows(grids) {
    var rows = [];
    (grids || []).forEach(function (g) {
      walkSeriesArrays(g, function (arr) {
        arr.forEach(function (s) {
          rows.push({
            apiName: (s.api_key && (s.api_key.name || s.api_key.sensitive_id)) || '',
            apiId: (s.api_key && (s.api_key.tracking_id || s.api_key.sensitive_id)) || '',
            model: s.model || s.function || s.name || '',
            fn: s.function || '',
            buckets: s.buckets || []
          });
        });
      });
    });
    return rows;
  }
  function bucketMetrics(b) {
    var out = {};
    if (!isObj(b)) return out;
    for (var k in b) {
      if (!Object.prototype.hasOwnProperty.call(b, k) || k === 'time') continue;
      var v = b[k];
      if (isObj(v)) {
        for (var k2 in v) if (Object.prototype.hasOwnProperty.call(v, k2) && isNumLike(v[k2])) out[k2] = toNum(v[k2]);
      } else if (isNumLike(v)) {
        out[k] = toNum(v);
      }
    }
    return out;
  }
  function isCostKey(k) { return /cost|amount.*fee|fee/i.test(k) && !/token|request/i.test(k); }
  function isRequestKey(k) { return /request|req_count|call/i.test(k) && !/token/i.test(k); }
  function isTokenKey(k) { return /token/i.test(k); }

  // 汇总：每天 {costByCurrency, requests, tokens}
  function summarize(last, keyId) {
    var dayMap = new Map();
    var totals = { cost: {}, requests: 0, tokens: 0 };
    function feed(grids, currency) {
      collectSeriesRows(grids).forEach(function (row) {
        if (keyId && keyId !== 'all' && row.apiId !== keyId && row.apiName !== keyId) return;
        row.buckets.forEach(function (b) {
          if (!isObj(b)) return;
          var day = secToDateStr(toNum(b.time), state.tz);
          if (!dayMap.has(day)) dayMap.set(day, { cost: {}, requests: 0, tokens: 0 });
          var d = dayMap.get(day);
          var m = bucketMetrics(b);
          for (var k in m) {
            if (isCostKey(k)) {
              var cur = currency || 'CNY';
              d.cost[cur] = (d.cost[cur] || 0) + m[k];
              totals.cost[cur] = (totals.cost[cur] || 0) + m[k];
            } else if (isRequestKey(k)) {
              d.requests += m[k]; totals.requests += m[k];
            } else if (isTokenKey(k)) {
              d.tokens += m[k]; totals.tokens += m[k];
            }
          }
        });
      });
    }
    try {
      if (last && last.cost) {
        findGridNodes(last.cost, []).forEach(function (g) {
          // 每个 grid 下 data[] 按币种分组
          var perCurrency = [];
          (function walk(n) {
            if (!n || typeof n !== 'object') return;
            if (Array.isArray(n)) { n.forEach(walk); return; }
            if (typeof n.currency === 'string') perCurrency.push(n);
            for (var k in n) if (Object.prototype.hasOwnProperty.call(n, k) && isObj(n[k])) walk(n[k]);
            for (var k2 in n) if (Object.prototype.hasOwnProperty.call(n, k2) && Array.isArray(n[k2])) walk(n[k2]);
          })(g);
          if (perCurrency.length) {
            perCurrency.forEach(function (p) {
              feed([p], p.currency);
            });
          } else {
            feed([g], 'CNY');
          }
        });
      }
      if (last && last.amount) feed(findGridNodes(last.amount, []), null);
    } catch (e) { warn('汇总失败', e); }
    var days = Array.from(dayMap.keys()).sort().reverse().map(function (k) {
      var v = dayMap.get(k);
      return { day: k, cost: v.cost, requests: v.requests, tokens: v.tokens };
    });
    return { days: days, totals: totals };
  }

  function fmtCost(costMap) {
    var parts = [];
    for (var cur in costMap) {
      if (!Object.prototype.hasOwnProperty.call(costMap, cur)) continue;
      if (!costMap[cur]) continue;
      var sym = cur === 'CNY' ? '¥' : (cur === 'USD' ? '$' : '');
      parts.push(sym + costMap[cur].toFixed(4).replace(/0+$/, '').replace(/\.$/, '') + (sym ? '' : ' ' + cur));
    }
    return parts.length ? parts.join(' + ') : '0';
  }
  function fmtInt(n) { return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }

  function buildCsv(last, keyId) {
    var cols = ['日期', 'API Key', 'Key ID', '模型/功能'];
    var colSet = new Set();
    var rows = [];
    var grids = [];
    try {
      if (last && last.cost) grids = grids.concat(findGridNodes(last.cost, []));
      if (last && last.amount) grids = grids.concat(findGridNodes(last.amount, []));
    } catch (e) {}
    collectSeriesRows(grids).forEach(function (row) {
      if (keyId && keyId !== 'all' && row.apiId !== keyId && row.apiName !== keyId) return;
      row.buckets.forEach(function (b) {
        if (!isObj(b)) return;
        var m = bucketMetrics(b);
        for (var k in m) if (!colSet.has(k)) { colSet.add(k); cols.push(k); }
        rows.push({
          day: secToDateStr(toNum(b.time), state.tz),
          apiName: row.apiName, apiId: row.apiId, model: row.model || row.fn, m: m
        });
      });
    });
    var metricCols = cols.slice(4);
    rows.sort(function (a, b) { return a.day < b.day ? -1 : (a.day > b.day ? 1 : 0); });
    function esc(v) {
      var s = String(v == null ? '' : v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }
    var lines = [cols.map(esc).join(',')];
    rows.forEach(function (r) {
      var line = [r.day, r.apiName, r.apiId, r.model];
      metricCols.forEach(function (k) { line.push(r.m[k] != null ? r.m[k] : ''); });
      lines.push(line.map(esc).join(','));
    });
    return lines.join('\r\n');
  }
  function exportCsv() {
    try {
      if (!lastData) throw new Error('尚无数据，请先「应用并查询」');
      var csv = buildCsv(lastData, state.keyId);
      var name = 'deepseek-usage_' + secToDateStr(state.start, state.tz) + '_' + secToDateStr(state.end - DAY, state.tz) + '.csv';
      var blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { try { URL.revokeObjectURL(a.href); a.remove(); } catch (e) {} }, 1500);
      log('CSV 已导出:', name);
    } catch (e) {
      warn('CSV 导出失败', e);
      try { ui && ui.setStatus && ui.setStatus('导出失败: ' + ((e && e.message) || e)); } catch (e2) {}
    }
  }

  /* ===================== 「全部」：向前探测最早用量 ===================== */
  function probeEarliest(onProgress) {
    var tz = state.tz;
    var end = dayStart(Date.now() / 1000, tz) + DAY;
    var emptyStreak = 0, earliest = null;

    function windowHasUsage(j) {
      var grids = findGridNodes(j, []);
      for (var i = 0; i < grids.length; i++) {
        var found = false;
        walkSeriesArrays(grids[i], function (arr) {
          if (arr.length) found = true;
        });
        if (found) return true;
      }
      return false;
    }
    function firstActiveDay(j) {
      var min = null;
      findGridNodes(j, []).forEach(function (g) {
        walkSeriesArrays(g, function (arr) {
          arr.forEach(function (s) {
            (s.buckets || []).forEach(function (b) {
              if (!isObj(b)) return;
              var m = bucketMetrics(b), active = false;
              for (var k in m) if (m[k]) { active = true; break; }
              if (active) {
                var t = toNum(b.time);
                if (min === null || t < min) min = t;
              }
            });
          });
        });
      });
      return min;
    }

    var win = 0;
    function next() {
      if (win >= PROBE_MAX_WINDOWS || emptyStreak >= PROBE_EMPTY_STOP) {
        return Promise.resolve(earliest != null ? earliest : end - 90 * DAY);
      }
      var e = end - win * MAX_SHARD_DAYS * DAY;
      var s = e - MAX_SHARD_DAYS * DAY;
      win++;
      if (onProgress) try { onProgress('探测最早用量… 第 ' + win + ' 窗口'); } catch (err) {}
      return fetchShardWithRetry(buildUrlWith('cost', s, e), mergeHeaders(baseHeaders(), null)).then(function (j) {
        if (windowHasUsage(j)) {
          emptyStreak = 0;
          var d = firstActiveDay(j);
          earliest = (d != null ? d : s);
        } else {
          emptyStreak++;
          if (earliest === null) earliest = s;
        }
        return next();
      })['catch'](function () {
        return earliest != null ? earliest : end - 90 * DAY;
      });
    }
    return next();
  }
  function buildUrlWith(kind, start, end) {
    var u = new URL('/api/v0/usage/by_api_key/' + kind, location.href);
    u.searchParams.set('start', String(start));
    u.searchParams.set('end', String(end));
    u.searchParams.set('tz', String(state.tz));
    return u.href;
  }

  /* ===================== 加载（面板自用） ===================== */
  var lastData = null;
  function loadAll(onProgress) {
    var progress = onProgress || function (m) { try { ui && ui.setStatus && ui.setStatus(m); } catch (e) {} };
    progress('正在拉取数据…');
    return Promise.all([
      fetchMerged('cost', state.start, state.end, buildUrl('cost'), null, progress),
      fetchMerged('amount', state.start, state.end, buildUrl('amount'), null, progress)
    ]).then(function (pair) {
      lastData = {
        cost: pair[0], amount: pair[1],
        start: state.start, end: state.end, tz: state.tz, at: Date.now()
      };
      return lastData;
    });
  }

  /* ===================== UI（Shadow DOM，不影响页面样式） ===================== */
  var ui = null;
  var CSS = [
    ':host{all:initial}',
    '.wrap{font:13px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;color:#1f2329;}',
    '.btn{cursor:pointer;user-select:none;border:1px solid #d0d3d9;border-radius:6px;padding:4px 10px;background:#fff;color:#1f2329;font-size:13px;}',
    '.btn:hover{border-color:#4e6ef2;color:#4e6ef2;}',
    '.btn.primary{background:#4e6ef2;border-color:#4e6ef2;color:#fff;}',
    '.btn.primary:hover{opacity:.9;color:#fff;}',
    '.btn.on{background:#eef2ff;border-color:#4e6ef2;color:#4e6ef2;}',
    '.panel{position:fixed;z-index:2147483647;width:420px;max-height:80vh;overflow:auto;background:#fff;border:1px solid #e3e5e8;border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,.12);padding:14px;}',
    '.title{font-weight:600;font-size:14px;margin-bottom:2px;}',
    '.sub{color:#8a9099;font-size:12px;margin-bottom:10px;}',
    '.row{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0;align-items:center;}',
    '.row input,.row select{border:1px solid #d0d3d9;border-radius:6px;padding:4px 6px;font-size:12px;color:#1f2329;background:#fff;}',
    '.status{min-height:20px;color:#4e6ef2;font-size:12px;margin:6px 0;word-break:break-all;}',
    '.status.err{color:#d4380d;}',
    '.kpi{display:flex;gap:10px;margin:8px 0;}',
    '.kpi .card{flex:1;background:#f7f8fa;border-radius:8px;padding:8px;}',
    '.kpi .num{font-size:15px;font-weight:600;}',
    '.kpi .lbl{color:#8a9099;font-size:11px;}',
    'table{width:100%;border-collapse:collapse;font-size:12px;}',
    'th,td{border-bottom:1px solid #eef0f2;padding:4px 6px;text-align:right;white-space:nowrap;}',
    'th:first-child,td:first-child{text-align:left;}',
    'thead th{position:sticky;top:0;background:#fff;color:#8a9099;font-weight:500;}',
    '.tbl{max-height:240px;overflow:auto;border:1px solid #eef0f2;border-radius:8px;}',
    '.hint{color:#8a9099;font-size:11px;margin-top:8px;}',
    '.chips .btn{padding:2px 8px;font-size:12px;}'
  ].join('\n');

  var HTML = '' +
    '<div class="wrap">' +
    '  <div class="title">DeepSeek 用量 · 任意时间段 <span style="color:#8a9099;font-weight:400">v' + VERSION + '</span></div>' +
    '  <div class="sub">自动分片拉取（≤31 天/片）→ 结构无关合并 → 官方图表原生渲染</div>' +
    '  <div class="row chips" id="chips"></div>' +
    '  <div class="row">' +
    '    <span>开始</span><input type="date" id="d1">' +
    '    <span>结束</span><input type="date" id="d2">' +
    '  </div>' +
    '  <div class="row">' +
    '    <span>API Key</span><select id="key"><option value="all">全部（仅影响表格/CSV）</option></select>' +
    '  </div>' +
    '  <div class="row">' +
    '    <span class="btn primary" id="apply">应用并查询</span>' +
    '    <span class="btn" id="sync">同步官方图表</span>' +
    '    <span class="btn" id="csv">导出 CSV</span>' +
    '    <span class="btn" id="restore">恢复原生</span>' +
    '  </div>' +
    '  <div class="status" id="status"></div>' +
    '  <div class="kpi">' +
    '    <div class="card"><div class="num" id="kCost">-</div><div class="lbl">总费用</div></div>' +
    '    <div class="card"><div class="num" id="kReq">-</div><div class="lbl">API 请求</div></div>' +
    '    <div class="card"><div class="num" id="kTok">-</div><div class="lbl">Tokens</div></div>' +
    '  </div>' +
    '  <div class="tbl"><table><thead><tr><th>日期</th><th>费用</th><th>请求</th><th>Tokens</th></tr></thead><tbody id="tbody"></tbody></table></div>' +
    '  <div class="hint">提示：①「同步官方图表」= 刷新页面，官方界面即显示该区间；②在官方「Time」里手动换筛选会让增强自动让位；③本扩展只读用量接口，无任何额外权限。</div>' +
    '</div>';

  function el(id, root) { return (root || document).querySelector('#' + id); }
  function mountUi() {
    try {
      var host = document.createElement('div');
      host.id = 'dsu3-root';
      var shadow = host.attachShadow({ mode: 'open' });
      var style = document.createElement('style');
      style.textContent = CSS;
      shadow.appendChild(style);
      var panel = document.createElement('div');
      panel.className = 'panel';
      panel.style.display = 'none';
      panel.innerHTML = HTML;
      shadow.appendChild(panel);
      (document.body || document.documentElement).appendChild(host);

      var btn = document.createElement('span');
      btn.id = 'dsu3-btn';
      btn.title = '查询任意时间跨度：自动分片拉取并合并，官方界面原生渲染';
      var BTN_BASE = 'cursor:pointer;user-select:none;border:1px solid #d0d3d9;border-radius:6px;' +
        'padding:4px 10px;background:#fff;color:#1f2329;display:inline-block;vertical-align:middle;' +
        'font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;';
      var BTN_ON = 'background:#eef2ff;border-color:#4e6ef2;color:#4e6ef2;';
      var BTN_FLOAT = 'position:fixed;right:20px;bottom:20px;z-index:2147483646;box-shadow:0 4px 16px rgba(0,0,0,.15);';

      function refreshBtn() {
        try {
          btn.textContent = state.on ? ('任意时间段 ' + rangeLabel(state.start, state.end, state.tz)) : '任意时间段';
          btn.style.cssText = BTN_BASE + (btn.__floating ? BTN_FLOAT : 'position:static;') + (state.on ? BTN_ON : '');
        } catch (e) {}
      }
      function place() {
        try {
          var anchor = findAnchor();
          if (anchor && anchor.parentNode) {
            if (btn.parentNode !== anchor.parentNode || btn.previousElementSibling !== anchor) {
              anchor.insertAdjacentElement('afterend', btn);
            }
            btn.__floating = false;
          } else {
            btn.__floating = true;
            if (!btn.parentNode) (document.body || document.documentElement).appendChild(btn);
          }
          refreshBtn();
        } catch (e) {}
      }
      function findAnchor() {
        try {
          var cands = document.querySelectorAll('div,button,span,a');
          for (var i = 0; i < cands.length; i++) {
            var e = cands[i];
            if (e.childElementCount > 2) continue;
            var t = (e.textContent || '').trim();
            if ((t === 'Export' || t === '导出') && e.getBoundingClientRect().width > 0) return e;
          }
        } catch (e) {}
        return null;
      }
      function openPanel() {
        panel.style.display = 'block';
        try {
          var r = btn.getBoundingClientRect();
          var top = Math.min(r.bottom + 8, window.innerHeight - 80);
          panel.style.top = Math.max(8, top) + 'px';
          panel.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 440)) + 'px';
        } catch (e) {}
      }
      function closePanel() { panel.style.display = 'none'; }
      btn.addEventListener('click', function (e) {
        e.preventDefault(); e.stopPropagation();
        if (panel.style.display === 'none') openPanel(); else closePanel();
      });
      document.addEventListener('click', function (e) {
        try {
          if (panel.style.display === 'none') return;
          var path = e.composedPath ? e.composedPath() : [];
          if (path.indexOf(host) >= 0 || path.indexOf(btn) >= 0) return;
          closePanel();
        } catch (err) {}
      }, true);

      // 预设
      var chips = el('chips', shadow);
      var presets = [
        ['近30天', 30], ['近90天', 90], ['近180天', 180], ['近1年', 365], ['全部', 0]
      ];
      presets.forEach(function (p) {
        var b = document.createElement('span');
        b.className = 'btn';
        b.textContent = p[0];
        b.addEventListener('click', function () {
          try {
            if (p[1] === 0) {
              setStatus('正在探测最早用量…');
              probeEarliest(setStatus).then(function (day) {
                var tz = effectiveTz();
                setDates(day, dayStart(Date.now() / 1000, tz) + DAY);
                setStatus('最早用量：' + secToDateStr(day, tz) + '，点「应用并查询」生效');
              })['catch'](function (e) { setStatus('探测失败: ' + ((e && e.message) || e), true); });
            } else {
              var tz = effectiveTz();
              var end = dayStart(Date.now() / 1000, tz) + DAY;
              setDates(end - p[1] * DAY, end);
            }
          } catch (e) { setStatus('预设失败: ' + ((e && e.message) || e), true); }
        });
        chips.appendChild(b);
      });

      var d1 = el('d1', shadow), d2 = el('d2', shadow), keySel = el('key', shadow);
      function setDates(startSec, endSec) {
        var tz = effectiveTz();
        d1.value = secToDateStr(startSec, tz);
        d2.value = secToDateStr(endSec - DAY, tz);
      }
      setDates(state.start, state.end);

      function setStatus(msg, isErr) {
        try {
          var s = el('status', shadow);
          s.textContent = msg || '';
          s.className = 'status' + (isErr ? ' err' : '');
        } catch (e) {}
      }
      function render() {
        try {
          if (!lastData) return;
          var sum = summarize(lastData, state.keyId);
          el('kCost', shadow).textContent = fmtCost(sum.totals.cost);
          el('kReq', shadow).textContent = fmtInt(sum.totals.requests);
          el('kTok', shadow).textContent = fmtInt(sum.totals.tokens);
          var tb = el('tbody', shadow);
          tb.innerHTML = '';
          sum.days.forEach(function (d) {
            var tr = document.createElement('tr');
            tr.innerHTML = '<td>' + d.day + '</td><td>' + fmtCost(d.cost) + '</td><td>' + fmtInt(d.requests) + '</td><td>' + fmtInt(d.tokens) + '</td>';
            tb.appendChild(tr);
          });
        } catch (e) { warn('表格渲染失败', e); }
      }
      function loadKeys() {
        try {
          authJson('/api/v0/users/get_api_keys', mergeHeaders(baseHeaders(), null)).then(function (j) {
            var list = [];
            (function walk(n) {
              if (!n || typeof n !== 'object') return;
              if (Array.isArray(n)) { n.forEach(walk); return; }
              if (n.tracking_id && (n.name || n.sensitive_id)) list.push(n);
              for (var k in n) if (Object.prototype.hasOwnProperty.call(n, k)) walk(n[k]);
            })(j);
            var seen = new Set();
            list.forEach(function (k) {
              if (seen.has(k.tracking_id)) return;
              seen.add(k.tracking_id);
              var o = document.createElement('option');
              o.value = k.tracking_id;
              o.textContent = (k.name || k.sensitive_id || k.tracking_id);
              keySel.appendChild(o);
            });
          })['catch'](function () {});
        } catch (e) {}
      }

      el('apply', shadow).addEventListener('click', function () {
        try {
          var tz = effectiveTz();
          var s = dateStrToSec(d1.value, tz);
          var e2 = dateStrToSec(d2.value, tz) + DAY;
          if (!(e2 > s)) { setStatus('结束日期需晚于开始日期', true); return; }
          if ((e2 - s) > MAX_SPAN_DAYS * DAY) { setStatus('区间过长（上限约 ' + MAX_SPAN_DAYS + ' 天）', true); return; }
          state.start = s; state.end = e2;
          state.tz = tz;
          state.keyId = keySel.value || 'all';
          state.on = true;
          state.snap = dateFilterJson();
          saveState();
          refreshBtn();
          setStatus('已启用 ' + rangeLabel(s, e2, tz) + '，正在拉取…');
          loadAll(setStatus).then(function () {
            render();
            setStatus('✓ ' + rangeLabel(state.start, state.end, state.tz) + ' 数据已就绪（点「同步官方图表」刷新页面即可在官方界面查看）');
          })['catch'](function (err) {
            setStatus('拉取失败: ' + ((err && err.message) || err), true);
          });
        } catch (err) { setStatus('应用失败: ' + ((err && err.message) || err), true); }
      });
      el('sync', shadow).addEventListener('click', function () {
        try {
          if (!state.on) { setStatus('请先「应用并查询」启用区间', true); return; }
          location.reload();
        } catch (e) {}
      });
      el('csv', shadow).addEventListener('click', function () {
        if (!lastData) {
          setStatus('正在拉取数据…');
          loadAll(setStatus).then(function () { render(); exportCsv(); })['catch'](function (e) {
            setStatus('拉取失败: ' + ((e && e.message) || e), true);
          });
        } else exportCsv();
      });
      el('restore', shadow).addEventListener('click', function () {
        state.on = false;
        state.snap = null;
        saveState();
        refreshBtn();
        setStatus('已恢复原生行为（最多 31 天）');
      });
      keySel.addEventListener('change', function () {
        state.keyId = keySel.value || 'all';
        saveState();
        render();
      });

      ui = { setStatus: setStatus, render: render, refresh: refreshBtn, panel: panel };
      loadKeys();
      refreshBtn();

      // 锚点定位 + 轻量守护（找不到 Export 就用悬浮按钮兜底）
      place();
      var tries = 0;
      var timer = setInterval(function () {
        tries++;
        place();
        if (tries > 40) clearInterval(timer);
      }, 1000);
      try {
        new MutationObserver(function () {
          if (!btn.isConnected) place();
        }).observe(document.documentElement, { childList: true, subtree: true });
      } catch (e) {}

      log('已加载');
    } catch (e) {
      warn('UI 挂载失败（不影响页面）', e);
    }
  }

  /* ===================== 调试句柄 ===================== */
  try {
    window.__dsu = {
      version: VERSION,
      state: function () { return state; },
      applyRange: function (start, end, keyId) {
        state.start = start; state.end = end;
        if (keyId) state.keyId = keyId;
        state.on = true;
        state.snap = dateFilterJson();
        saveState();
        return loadAll();
      },
      disable: function () { state.on = false; state.snap = null; saveState(); },
      loadAll: loadAll,
      last: function () { return lastData; },
      exportCsv: exportCsv,
      probeEarliest: probeEarliest,
      merge: function (list) { return finalize(mergeResponses(list), state.start, state.end); },
      planShards: planShards,
      summarize: function (keyId) { return lastData ? summarize(lastData, keyId || state.keyId) : null; },
      summarizeWith: function (last, keyId) { return summarize(last, keyId || 'all'); },
      buildCsvWith: function (last, keyId) { return buildCsv(last, keyId || 'all'); }
    };
  } catch (e) {}

  /* ===================== 启动 ===================== */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mountUi);
  } else {
    mountUi();
  }
})();
