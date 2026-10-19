(function () {
  'use strict';

  var DATA = window.METRO_NETWORK;
  var Core = window.MetroCore;
  var model = Core.build(DATA);
  var LINES = model.lines;
  var LINE_BY_ID = model.lineMap;
  var ALL_LINE_IDS = LINES.map(function (l) { return l.id; });
  var SYNC_URL = window.METRO_SYNC_URL || 'network-sync.json';
  var SYNC_API = window.METRO_SYNC_API || (location.protocol === 'file:' ? 'http://127.0.0.1:8765/api/sync-network' : '/api/sync-network');
  var syncBusy = false;

  var KEY_STATIONS = [
    '北大街', '钟楼', '小寨', '大雁塔', '西安北站', '纺织城', '五路口',
    '行政中心', '曲江池西', '电视塔', '青龙寺', '余家寨', '机场西（T1、T2、T3）',
    '秦陵西', '创新港', '昭慧广场', '咸阳西站', '东长安街'
  ];
  var HOT_STATIONS = ['小寨', '钟楼', '北大街', '大雁塔', '西安北站', '纺织城', '行政中心', '五路口'];
  var ALIASES = {
    '北客站': '西安北站',
    '北客站(北广场)': '西安北站',
    '北客站（北广场）': '西安北站',
    '火车站': '西安站',
    '西安火车站': '西安站',
    '机场': '机场西（T1、T2、T3）',
    '机场西': '机场西（T1、T2、T3）',
    '机场西(T1/T2/T3)': '机场西（T1、T2、T3）',
    '机场T5': '机场（T5）',
    '机场(T5)': '机场（T5）',
    '华清池站': '华清池',
    '钟楼站': '钟楼',
    '大雁塔站': '大雁塔'
  };

  var state = {
    tab: 'route',
    mapMode: 'all',
    route: null,
    routeOptions: [],
    activeRoute: 0,
    from: '',
    to: '',
    selectedLineId: null,
    focusStation: null,
    exploreHistory: [],
    liveStation: null,
    liveLineId: null,
    board: null,
    labelAll: false,
    sheetCollapsed: false,
    userLocation: null,
    nearest: null,
    nearbyList: [],
    locating: false,
    geoError: null,
    animateMap: true,
    map: { W: 0, H: 0, scale: 1, tx: 0, ty: 0 },
    projection: null,
    projectedLines: [],
    projectedStations: new Map(),
    dragging: false,
    suppressClickUntil: 0
  };

  var refs = {};
  var timeFormatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  });
  var labelRaf = 0;
  var toastTimer = 0;
  var resizeTimer = 0;
  var viewAnimation = 0;
  var lineDrawTimers = [];
  var lineDrawFrames = [];

  function $(selector, root) { return (root || document).querySelector(selector); }
  function $all(selector, root) { return Array.prototype.slice.call((root || document).querySelectorAll(selector)); }
  function pad2(n) { return n < 10 ? '0' + n : '' + n; }
  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function nowParts() {
    var parts = timeFormatter.formatToParts(new Date());
    var out = { hour: 0, minute: 0, second: 0 };
    parts.forEach(function (p) {
      if (p.type === 'hour') out.hour = parseInt(p.value, 10) % 24;
      if (p.type === 'minute') out.minute = parseInt(p.value, 10);
      if (p.type === 'second') out.second = parseInt(p.value, 10);
    });
    return out;
  }
  function nowSeconds() {
    var p = nowParts();
    return p.hour * 3600 + p.minute * 60 + p.second;
  }
  function clockText() {
    var p = nowParts();
    return pad2(p.hour) + ':' + pad2(p.minute) + ':' + pad2(p.second);
  }
  function contrastText(hex) {
    var h = hex.replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var r = parseInt(h.slice(0, 2), 16) / 255;
    var g = parseInt(h.slice(2, 4), 16) / 255;
    var b = parseInt(h.slice(4, 6), 16) / 255;
    function linear(c) { return c <= .03928 ? c / 12.92 : Math.pow((c + .055) / 1.055, 2.4); }
    var lum = .2126 * linear(r) + .7152 * linear(g) + .0722 * linear(b);
    return lum > .43 ? '#14251d' : '#ffffff';
  }
  function lineTag(lineId) {
    var l = LINE_BY_ID[lineId];
    if (!l) return '';
    return '<span class="line-tag" style="--c:' + l.color + ';--tc:' + contrastText(l.color) + '">' + esc(l.short) + '</span>';
  }
  function miniLine(lineId) {
    var l = LINE_BY_ID[lineId];
    if (!l) return '';
    return '<button class="mini-line" type="button" data-switch-line="' + l.id + '" style="--c:' + l.color + ';--tc:' + contrastText(l.color) + '" title="换乘 ' + esc(l.name) + '">' + esc(l.id) + '</button>';
  }
  function lineName(lineId) {
    return LINE_BY_ID[lineId] ? LINE_BY_ID[lineId].name : '';
  }
  function stationLines(name) {
    var entry = model.stationMap.get(name);
    return entry ? entry.lines.map(function (x) { return x.line; }) : [];
  }
  function resolveStation(value) {
    var v = String(value || '').trim();
    if (!v) return null;
    if (model.stationMap.has(v)) return v;
    if (ALIASES[v] && model.stationMap.has(ALIASES[v])) return ALIASES[v];
    var found = [];
    model.stationMap.forEach(function (entry, name) {
      if (name.indexOf(v) !== -1 || v.indexOf(name) !== -1) found.push(name);
    });
    if (found.length === 1) return found[0];
    return null;
  }
  function formatCountdown(seconds) {
    seconds = Math.max(0, Math.round(seconds));
    if (seconds <= 0) return '即将进站';
    if (seconds < 3600) return pad2(Math.floor(seconds / 60)) + ':' + pad2(seconds % 60);
    return Math.floor(seconds / 3600) + ':' + pad2(Math.floor((seconds % 3600) / 60));
  }
  function formatMinute(seconds) {
    var m = Math.max(1, Math.round(seconds / 60));
    return m + ' 分钟';
  }
  function mapToast(message) {
    var el = refs.mapToast;
    if (!el) return;
    el.textContent = message;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, 2300);
  }
  function stationSubLabel(name) {
    var ls = stationLines(name);
    if (ls.length > 1) return '换乘站 · ' + ls.length + ' 条线路';
    return ls.length ? ls[0].name : '';
  }

  function bearingDegrees(a, b) {
    var lat1 = a.lat * Math.PI / 180;
    var lat2 = b.lat * Math.PI / 180;
    var dLon = (b.lon - a.lon) * Math.PI / 180;
    var y = Math.sin(dLon) * Math.cos(lat2);
    var x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  }

  function directionName(deg) {
    var names = ['北', '东北', '东', '东南', '南', '西南', '西', '西北'];
    return names[Math.round(deg / 45) % 8];
  }

  function formatMeters(m) {
    if (m < 1000) return Math.max(1, Math.round(m)) + ' 米';
    return (m / 1000).toFixed(m < 10000 ? 1 : 0) + ' 公里';
  }

  function walkMinutes(meters) {
    return Math.max(1, Math.round(meters / 78));
  }

  function findNearbyStations(lat, lon, count) {
    var origin = { lat: lat, lon: lon };
    var list = [];
    model.stationMap.forEach(function (entry) {
      var km = Core.distanceKm(origin, { lat: entry.lat, lon: entry.lon });
      list.push({
        name: entry.name,
        lat: entry.lat,
        lon: entry.lon,
        meters: km * 1000,
        lines: entry.lines.map(function (x) { return x.line; }),
        bearing: bearingDegrees(origin, { lat: entry.lat, lon: entry.lon })
      });
    });
    list.sort(function (a, b) { return a.meters - b.meters; });
    return list.slice(0, count || 3);
  }

  /* ------------------------------------------------------------------ */
  /* clock                                                              */
  /* ------------------------------------------------------------------ */
  function tickClock() {
    var text = clockText();
    if (refs.topClock) refs.topClock.textContent = text;
    $all('.js-live-clock').forEach(function (el) { el.textContent = text; });
    if (state.route) {
      var arrival = $('[data-route-arrival]');
      if (arrival) arrival.textContent = Core.formatClock(nowSeconds() + state.route.totalSec);
    }
    updateCountdowns();
  }

  function updateCountdowns() {
    if (state.tab !== 'live' || !state.board) return;
    var now = nowSeconds();
    var refresh = false;
    $all('[data-countdown-at]').forEach(function (el) {
      var at = parseInt(el.getAttribute('data-countdown-at'), 10);
      var left = at - now;
      if (!isFinite(at)) return;
      if (left <= 0) {
        refresh = true;
        el.textContent = '即将进站';
        return;
      }
      el.textContent = formatCountdown(left);
      el.classList.toggle('is-soon', left <= 60);
    });
    if (refresh) {
      var keepScroll = refs.panelScroll.scrollTop;
      renderLiveContent();
      refs.panelScroll.scrollTop = keepScroll;
    }
  }

  /* ------------------------------------------------------------------ */
  /* route planning                                                     */
  /* ------------------------------------------------------------------ */
  function planRoute(fromRaw, toRaw, options) {
    options = options || {};
    var from = resolveStation(fromRaw);
    var to = resolveStation(toRaw);
    refs.routeFeedback.hidden = true;
    if (!from) return showRouteFeedback('请选择一个有效的起点车站');
    if (!to) return showRouteFeedback('请选择一个有效的终点车站');
    if (from === to) return showRouteFeedback('起点与终点不能是同一个车站');

    var fastest = Core.plan(model, from, to, {});
    if (!fastest.ok) return showRouteFeedback(fastest.error || '未能生成路线');
    var fewer = Core.plan(model, from, to, { transferPenaltyMin: 26 });
    var optionsList = [{ label: '最快', route: fastest }];
    if (fewer.ok && fewer.transferCount < fastest.transferCount && fewer.signature !== fastest.signature) {
      optionsList.push({ label: '少换乘', route: fewer });
    }

    state.from = from;
    state.to = to;
    state.routeOptions = optionsList;
    state.activeRoute = 0;
    state.route = fastest;
    state.selectedLineId = null;
    state.focusStation = null;
    state.exploreHistory = [];
    state.mapMode = 'route';
    refs.fromInput.value = from;
    refs.toInput.value = to;
    updateInputClearButtons();
    closeSuggest();
    hideLiveSuggest();
    renderRouteResult();
    renderExplore();
    applyMapMode('route', true);
    activateTab('route', { keepMap: true, expand: true });
    if (!options.initial) {
      refs.panelScroll.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }

  function showRouteFeedback(message) {
    refs.routeFeedback.textContent = message;
    refs.routeFeedback.hidden = false;
    return null;
  }

  function renderRouteResult() {
    var r = state.route;
    if (!r) {
      refs.routeResult.innerHTML = '';
      refs.routeWelcome.hidden = false;
      refs.viewRoute.classList.remove('has-result');
      return;
    }
    refs.routeWelcome.hidden = true;
    refs.viewRoute.classList.add('has-result');
    var arrive = Core.formatClock(nowSeconds() + r.totalSec);
    var optionsHtml = state.routeOptions.length > 1
      ? '<div class="route-options">' + state.routeOptions.map(function (opt, i) {
        return '<button class="route-option ' + (i === state.activeRoute ? 'is-active' : '') + '" type="button" data-route-option="' + i + '">' +
          '<span class="route-option-top"><span class="route-option-label">' + opt.label + '</span><span class="route-option-meta">' + (opt.route.transferCount ? opt.route.transferCount + ' 次换乘' : '直达') + '</span></span>' +
          '<span class="route-option-time">' + opt.route.durationMin + ' <small>分钟</small></span>' +
          '</button>';
      }).join('') + '</div>'
      : '';

    var summaryLines = r.segments.map(function (s, i) {
      return lineTag(s.lineId) + (i < r.segments.length - 1 ? '<span class="summary-arrow">›</span>' : '');
    }).join('');

    var journey = '<div class="journey-step">' +
      '<div class="journey-rail"><span class="rail-dot"></span></div>' +
      '<div class="journey-main"><div class="journey-kicker">从起点出发</div><div class="journey-title">' + esc(r.from) + '</div></div>' +
      '</div>';

    r.segments.forEach(function (seg, i) {
      var line = LINE_BY_ID[seg.lineId];
      var direction = seg.loop ? '环线 · 经 ' + seg.stations[1] : '开往 ' + seg.terminus;
      var detail = seg.stations.join(' · ');
      journey += '<div class="journey-step">' +
        '<div class="journey-rail" style="--rail:' + line.color + '"><span class="rail-dot" style="border-color:' + line.color + '"></span></div>' +
        '<div class="journey-main">' +
        '<div class="journey-kicker">乘坐 ' + esc(line.short) + '</div>' +
        '<div class="journey-title">' + lineTag(seg.lineId) + '<span class="journey-dir">' + esc(direction) + '</span><span class="journey-time">' + formatMinute(seg.rideSec) + ' · ' + (seg.stations.length - 1) + ' 站</span></div>' +
        '<div class="journey-stations">' + esc(seg.board) + '<svg class="ic"><use href="#i-arrow"></use></svg>' + esc(seg.alight) + '</div>' +
        '<details class="journey-detail"><summary>沿途 ' + seg.stations.length + ' 站</summary><p>' + esc(detail) + '</p></details>' +
        '</div>' +
        '</div>';

      if (r.transfers[i]) {
        var t = r.transfers[i];
        journey += '<div class="transfer-line">' +
          '<div class="transfer-icon"><svg class="ic"><use href="#i-transfer"></use></svg></div>' +
          '<div class="transfer-copy"><strong>' + esc(t.station) + '</strong> 换乘 ' + lineTag(t.toLineId) +
          '<span class="transfer-note">站内步行约 ' + Math.round(t.walkSeconds / 60) + ' 分钟 · 候车约 ' + Math.round(t.waitSeconds / 60) + ' 分钟</span></div>' +
          '</div>';
      }
    });

    journey += '<div class="journey-step">' +
      '<div class="journey-rail"><span class="rail-dot dest"></span></div>' +
      '<div class="journey-main"><div class="journey-kicker">到达终点</div><div class="journey-title">' + esc(r.to) + '</div></div>' +
      '</div>';

    refs.routeResult.innerHTML = optionsHtml +
      '<div class="route-hero">' +
      '<div class="route-hero-top">' +
      '<div><div class="route-duration"><strong>' + r.durationMin + '</strong><span>分钟</span></div><div class="route-duration-label">预计行程时间</div></div>' +
      '<div class="route-arrive"><div class="route-arrive-label">预计到达</div><time data-route-arrival>' + arrive + '</time><small>按当前时刻计算</small></div>' +
      '</div>' +
      '<div class="route-hero-meta">' +
      '<div><b>' + r.stopCount + '</b><span>乘坐站数</span></div>' +
      '<div><b>' + (r.transferCount || '直达') + '</b><span>换乘次数</span></div>' +
      '<div><b>¥' + r.fare + '</b><span>预估票价</span></div>' +
      '<div><b>' + r.distanceKm.toFixed(1) + '</b><span>公里</span></div>' +
      '</div>' +
      '</div>' +
      '<div class="route-summary-line">' + summaryLines + '</div>' +
      '<div class="journey">' + journey + '</div>' +
      '<div class="route-foot"><span>含候车约 ' + Math.round(r.waitSec / 60) + ' 分钟 · 换乘步行约 ' + Math.round(r.walkSec / 60) + ' 分钟</span><button type="button" id="clearRouteBtn">清除路线</button></div>';

    $all('[data-route-option]', refs.routeResult).forEach(function (btn) {
      btn.addEventListener('click', function () {
        var i = parseInt(btn.getAttribute('data-route-option'), 10);
        if (!state.routeOptions[i]) return;
        state.activeRoute = i;
        state.route = state.routeOptions[i].route;
        renderRouteResult();
        applyMapMode('route', true);
      });
    });
    var clearBtn = $('#clearRouteBtn', refs.routeResult);
    if (clearBtn) clearBtn.addEventListener('click', clearRoute);
  }

  function clearRoute() {
    state.route = null;
    state.routeOptions = [];
    state.activeRoute = 0;
    state.mapMode = 'all';
    state.selectedLineId = null;
    state.focusStation = null;
    state.exploreHistory = [];
    renderRouteResult();
    renderExplore();
    applyMapMode('all', true);
  }

  /* ------------------------------------------------------------------ */
  /* autocomplete                                                       */
  /* ------------------------------------------------------------------ */
  var suggestState = { field: null, items: [], index: -1 };
  var liveSuggestState = { items: [], index: -1 };

  function searchStations(query) {
    var q = String(query || '').trim().toLowerCase().replace(/\s+/g, '');
    var list = [];
    model.stationMap.forEach(function (entry, name) {
      var aliasHit = false;
      Object.keys(ALIASES).some(function (alias) {
        if (ALIASES[alias] === name && alias.toLowerCase().indexOf(q) !== -1) { aliasHit = true; return true; }
        return false;
      });
      var hay = (name + ' ' + entry.lines.map(function (x) { return x.line.id + '号线'; }).join(' ')).toLowerCase();
      var idx = hay.indexOf(q);
      if (!q || idx !== -1 || aliasHit) {
        var score = 0;
        if (!q) score = KEY_STATIONS.indexOf(name) !== -1 ? 100 : 10;
        else if (name.toLowerCase().indexOf(q) === 0) score = 100;
        else if (name.toLowerCase().indexOf(q) !== -1) score = 60;
        else if (aliasHit) score = 55;
        else score = 20;
        if (KEY_STATIONS.indexOf(name) !== -1) score += 6;
        score += entry.lines.length;
        list.push({ name: name, lines: entry.lines.map(function (x) { return x.line; }), score: score });
      }
    });
    list.sort(function (a, b) {
      if (b.score !== a.score) return b.score - a.score;
      return a.name.length - b.name.length;
    });
    if (!q) {
      var order = {};
      KEY_STATIONS.forEach(function (n, i) { order[n] = i; });
      list.sort(function (a, b) {
        var ao = order[a.name] == null ? 999 : order[a.name];
        var bo = order[b.name] == null ? 999 : order[b.name];
        return ao - bo;
      });
    }
    return list.slice(0, 8);
  }

  function suggestItemHtml(station) {
    return '<button class="suggest-item" type="button" data-suggest-station="' + esc(station.name) + '">' +
      '<span class="suggest-name">' + esc(station.name) + '<small>' + (station.lines.length > 1 ? '换乘站' : station.lines[0].name) + '</small></span>' +
      '<span class="suggest-lines">' + station.lines.map(function (l) {
        return '<span class="mini-line" style="--c:' + l.color + ';--tc:' + contrastText(l.color) + '">' + esc(l.id) + '</span>';
      }).join('') + '</span>' +
      '</button>';
  }

  function openSuggest(field) {
    var input = field === 'from' ? refs.fromInput : refs.toInput;
    var row = input.closest('.od-row');
    var items = searchStations(input.value);
    suggestState.field = field;
    suggestState.items = items;
    suggestState.index = -1;
    refs.stationSuggest.innerHTML = items.length ? items.map(function (s) { return suggestItemHtml(s); }).join('') : '<div class="suggest-empty">没有找到匹配车站</div>';
    refs.stationSuggest.style.top = (row.offsetTop + row.offsetHeight + 4) + 'px';
    refs.stationSuggest.hidden = false;
    hideLiveSuggest();
    refs.stationSuggest.querySelectorAll('[data-suggest-station]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        pickStation(field, btn.getAttribute('data-suggest-station'));
      });
    });
  }

  function closeSuggest() {
    refs.stationSuggest.hidden = true;
    suggestState.field = null;
    suggestState.items = [];
    suggestState.index = -1;
  }

  function pickStation(field, name) {
    if (field === 'from') refs.fromInput.value = name;
    else refs.toInput.value = name;
    updateInputClearButtons();
    closeSuggest();
    refs.routeFeedback.hidden = true;
    var from = resolveStation(refs.fromInput.value);
    var to = resolveStation(refs.toInput.value);
    if (from && to && from !== to) {
      setTimeout(function () { planRoute(from, to); }, 80);
    }
  }

  function updateInputClearButtons() {
    $all('.od-clear').forEach(function (btn) {
      var field = btn.getAttribute('data-clear');
      var input = field === 'from' ? refs.fromInput : refs.toInput;
      btn.classList.toggle('is-visible', !!input.value.trim());
    });
  }

  function openLiveSuggest() {
    var items = searchStations(refs.liveSearch.value);
    liveSuggestState.items = items;
    liveSuggestState.index = -1;
    refs.liveSuggest.innerHTML = items.length ? items.map(function (s) { return suggestItemHtml(s); }).join('') : '<div class="suggest-empty">没有找到匹配车站</div>';
    refs.liveSuggest.hidden = false;
    closeSuggest();
    refs.liveSuggest.querySelectorAll('[data-suggest-station]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var name = btn.getAttribute('data-suggest-station');
        refs.liveSearch.value = name;
        refs.liveSuggest.hidden = true;
        openLive(name);
      });
    });
  }

  function hideLiveSuggest() { refs.liveSuggest.hidden = true; liveSuggestState.items = []; liveSuggestState.index = -1; }

  /* ------------------------------------------------------------------ */
  /* explore                                                            */
  /* ------------------------------------------------------------------ */
  function renderExplore() {
    refs.viewExplore.classList.toggle('has-line', !!state.selectedLineId);
    if (state.selectedLineId) {
      refs.lineGrid.hidden = true;
      refs.lineDetail.hidden = false;
      renderLineDetail();
    } else {
      refs.lineGrid.hidden = false;
      refs.lineDetail.hidden = true;
      renderLineGrid();
    }
  }

  function renderLineGrid() {
    refs.lineGrid.innerHTML = LINES.map(function (l) {
      var active = state.mapMode === 'line' && state.selectedLineId === l.id;
      return '<button class="line-card ' + (active ? 'is-active' : '') + '" type="button" data-card-line="' + l.id + '" style="--c:' + l.color + '">' +
        '<span class="line-card-top"><span class="line-dot"></span><span class="line-card-name">' + esc(l.name) + '</span><span class="line-card-count">' + l.stations.length + ' 站</span></span>' +
        '<span class="line-card-terminals" title="' + esc(l.stations[0].name + ' ↔ ' + l.stations[l.stations.length - 1].name) + '">' + esc(l.stations[0].name + ' ↔ ' + l.stations[l.stations.length - 1].name) + '</span>' +
        '<span class="line-card-foot"><span>间隔约 ' + l.headway + ' 分</span><span>探索 →</span></span>' +
        '</button>';
    }).join('');
  }

  function renderLineDetail() {
    var line = LINE_BY_ID[state.selectedLineId];
    if (!line) { state.selectedLineId = null; renderExplore(); return; }
    var crumb = '';
    if (state.exploreHistory.length) {
      var shown = state.exploreHistory.slice(-2);
      crumb = '<div class="breadcrumb">' + shown.map(function (h, idx) {
        return (idx ? '<svg class="ic"><use href="#i-arrow"></use></svg>' : '') +
          '<b>' + esc(lineName(h.lineId)) + '</b><svg class="ic"><use href="#i-arrow"></use></svg><span>' + esc(h.focus) + '</span>';
      }).join('') + '<svg class="ic"><use href="#i-arrow"></use></svg><b>' + esc(line.name) + '</b></div>';
    }

    var rows = line.stations.map(function (s, i) {
      var others = stationLines(s.name).filter(function (l) { return l.id !== line.id; });
      var isFocus = state.focusStation === s.name;
      return '<div class="station-row ' + (s.transfer ? 'is-transfer ' : '') + (isFocus ? 'is-focus' : '') + '" data-station="' + esc(s.name) + '" data-line="' + line.id + '" role="button" tabindex="0" aria-label="' + esc(s.name) + (others.length ? '，换乘站' : '') + '">' +
        '<span class="station-index">' + pad2(i + 1) + '</span>' +
        '<span class="station-node"></span>' +
        '<span class="station-name">' + esc(s.name) + '</span>' +
        '<span class="station-chips">' + others.map(function (l) { return miniLine(l.id); }).join('') + '</span>' +
        (others.length ? '<button class="station-live" type="button" data-live-station="' + esc(s.name) + '" data-live-line="' + line.id + '" aria-label="查看实时到站"><svg class="ic"><use href="#i-clock"></use></svg></button>' : '<span class="station-live" style="opacity:.22"><svg class="ic"><use href="#i-clock"></use></svg></span>') +
        '</div>';
    }).join('');

    refs.lineDetail.innerHTML =
      '<button class="line-back" type="button" id="lineBackBtn"><svg class="ic"><use href="#i-chevron"></use></svg>返回线路列表</button>' +
      crumb +
      '<div class="line-detail-head" style="--c:' + line.color + '">' +
      '<div class="line-detail-kicker"><span class="line-dot"></span><span>LINE ' + line.id + ' · ' + line.stations.length + ' STATIONS</span></div>' +
      '<h2>' + esc(line.name) + '</h2>' +
      '<div class="line-detail-terminals">' + esc(line.stations[0].name) + '<svg class="ic" style="width:11px;height:11px"><use href="#i-transfer"></use></svg>' + esc(line.stations[line.stations.length - 1].name) + '</div>' +
      '<div class="line-detail-stats">' +
      '<div><b>' + line.stations.length + '</b>车站</div>' +
      '<div><b>' + Math.round(line.totalTime / 60) + ' 分</b>全程约</div>' +
      '<div><b>' + line.headway + ' 分</b>发车间隔</div>' +
      '<div><b>06:00</b>首班</div>' +
      '</div>' +
      '</div>' +
      '<div class="line-actions"><button class="ghost-btn" type="button" id="lineAllBtn"><svg class="ic"><use href="#i-map"></use></svg>查看全网</button><button class="ghost-btn" type="button" id="lineLiveBtn"><svg class="ic"><use href="#i-clock"></use></svg>本线实时</button></div>' +
      '<div class="station-list" style="--c:' + line.color + '">' + rows + '</div>' +
      '<div class="line-note">' + (line.loop ? '8 号线为环线，列车按环线方向运行；建议按站台导向选择方向。' : '点击换乘站可查看相接线路并直接切换高亮；点击时钟查看实时到站。') + '</div>';

    var focusEl = refs.lineDetail.querySelector('.station-row.is-focus');
    if (focusEl) {
      requestAnimationFrame(function () {
        focusEl.scrollIntoView({ block: 'center', behavior: 'smooth' });
      });
    }
  }

  function selectLine(lineId, opts) {
    opts = opts || {};
    if (!LINE_BY_ID[lineId]) return;
    state.selectedLineId = lineId;
    state.focusStation = opts.station || null;
    state.mapMode = 'line';
    if (!opts.keepHistory) state.exploreHistory = [];
    renderExplore();
    applyMapMode('line', true);
    activateTab('explore', { keepMap: true, expand: true });
    if (state.tab === 'explore') {
      refs.panelScroll.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }

  function switchLineAtStation(station, newLineId) {
    var old = state.selectedLineId;
    if (!LINE_BY_ID[newLineId] || old === newLineId) return;
    if (old) state.exploreHistory.push({ lineId: old, focus: station });
    state.selectedLineId = newLineId;
    state.focusStation = station;
    state.mapMode = 'line';
    renderExplore();
    applyMapMode('line', true);
    activateTab('explore', { keepMap: true, expand: true });
    requestAnimationFrame(function () {
      var el = refs.lineDetail.querySelector('.station-row.is-focus');
      if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
    mapToast('已在 ' + station + ' 切换至 ' + lineName(newLineId));
  }

  function goBackLine() {
    var prev = state.exploreHistory.pop();
    if (!prev) return;
    state.selectedLineId = prev.lineId;
    state.focusStation = prev.focus;
    state.mapMode = 'line';
    renderExplore();
    applyMapMode('line', true);
    requestAnimationFrame(function () {
      var el = refs.lineDetail.querySelector('.station-row.is-focus');
      if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
  }

  function toggleTransferChoice(row) {
    var station = row.getAttribute('data-station');
    var existing = refs.lineDetail.querySelector('.transfer-choice');
    if (existing) {
      var same = existing.getAttribute('data-choice-for') === station;
      existing.remove();
      if (same) return;
    }
    var others = stationLines(station).filter(function (l) { return l.id !== state.selectedLineId; });
    if (!others.length) return;
    var choice = document.createElement('div');
    choice.className = 'transfer-choice';
    choice.setAttribute('data-choice-for', station);
    choice.innerHTML = '<div class="transfer-choice-head"><svg class="ic"><use href="#i-transfer"></use></svg>在 <b>' + esc(station) + '</b> 可换乘</div>' +
      '<div class="transfer-choice-actions">' + others.map(function (l) {
        return '<button class="transfer-pick" type="button" data-switch-line="' + l.id + '" data-station="' + esc(station) + '" style="--c:' + l.color + ';--tc:' + contrastText(l.color) + '">' + esc(l.short) + '</button>';
      }).join('') +
      '<button class="transfer-pick is-live" type="button" data-live-station="' + esc(station) + '" data-live-line="' + state.selectedLineId + '"><svg class="ic"><use href="#i-clock"></use></svg>实时到站</button>' +
      '</div>';
    row.insertAdjacentElement('afterend', choice);
    requestAnimationFrame(function () {
      choice.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
  }

  /* ------------------------------------------------------------------ */
  /* live arrivals                                                      */
  /* ------------------------------------------------------------------ */
  function openLive(stationName, lineId, opts) {
    opts = opts || {};
    if (!model.stationMap.has(stationName)) return;
    state.liveStation = stationName;
    var lineIds = stationLines(stationName).map(function (l) { return l.id; });
    state.liveLineId = lineId && lineIds.indexOf(lineId) !== -1 ? lineId : lineIds[0];
    refs.liveSearch.value = stationName;
    hideLiveSuggest();
    activateTab('live', { keepMap: true, expand: true });
    state.mapMode = 'live';
    applyMapMode('live', true);
    refs.panelScroll.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function renderLive() {
    renderLiveContent();
  }

  function renderLiveContent() {
    refs.viewLive.classList.toggle('has-station', !!state.liveStation);
    if (!state.liveStation) {
      state.board = null;
      var hot = HOT_STATIONS.filter(function (n) { return model.stationMap.has(n); });
      refs.liveContent.innerHTML =
        '<div class="hot-stations">' +
        '<div class="hot-title"><span class="eyebrow">POPULAR STATIONS</span><span>热门车站</span></div>' +
        '<div class="hot-grid">' + hot.map(function (name) {
          var ls = stationLines(name);
          return '<button class="hot-station" type="button" data-live-station="' + esc(name) + '"><strong>' + esc(name) + '</strong><span>' + ls.map(function (l) {
            return '<i class="mini-line" style="--c:' + l.color + ';--tc:' + contrastText(l.color) + '">' + esc(l.id) + '</i>';
          }).join('') + '</span></button>';
        }).join('') + '</div>' +
        '</div>' +
        '<div class="live-empty-note"><strong style="color:var(--ink-2)">按运行图模拟。</strong>选择车站后，系统会按当前北京时间、发车间隔与首末班推算后续列车，每秒刷新。该数据不是西安地铁官方实时到站数据。</div>';
      return;
    }

    var station = model.stationMap.get(state.liveStation);
    if (!station) { state.liveStation = null; renderLiveContent(); return; }
    var stationLineIds = station.lines.map(function (x) { return x.line.id; });
    if (stationLineIds.indexOf(state.liveLineId) === -1) state.liveLineId = stationLineIds[0];
    var board = Core.boardFor(model, state.liveStation, state.liveLineId, nowSeconds(), 3);
    state.board = board;
    var line = LINE_BY_ID[state.liveLineId];

    var heroLines = station.lines.length === 1
      ? '<div class="station-hero-lines">' + station.lines.map(function (x) {
        return '<span class="line-tag" style="--c:' + x.line.color + ';--tc:' + contrastText(x.line.color) + '">' + esc(x.line.short) + '</span>';
      }).join('') + '</div>'
      : '';
    var hero = '<div class="station-hero">' +
      '<div class="eyebrow">NOW ARRIVING</div>' +
      '<h2>' + esc(state.liveStation) + '</h2>' +
      heroLines +
      '<div class="station-hero-foot"><span>北京时间 <b class="js-live-clock">' + clockText() + '</b></span><span>运营 06:00 — 23:30</span></div>' +
      '</div>';

    var tabs = station.lines.length > 1
      ? '<div class="line-tabs">' + station.lines.map(function (x) {
        return '<button class="line-tab ' + (x.line.id === state.liveLineId ? 'is-active' : '') + '" type="button" data-live-line="' + x.line.id + '" style="--c:' + x.line.color + '"><span class="line-dot"></span>' + esc(x.line.short) + '</button>';
      }).join('') + '</div>'
      : '';

    var cards = (board ? board.directions : []).map(function (dir) {
      var first = dir.arrivals[0];
      var running = dir.serviceState === 'running' || dir.serviceState === 'before';
      var statusText = dir.serviceState === 'before' ? '首班未发' : (dir.serviceState === 'after' ? '运营结束' : '运行中');
      var statusClass = dir.serviceState === 'before' ? 'is-before' : (dir.serviceState === 'after' ? 'is-after' : '');
      var countdown = first && running ? formatCountdown(first.inSeconds) : '--:--';
      var firstAbs = first ? first.clock : '—';
      var rest = dir.arrivals.slice(1).map(function (a, idx) {
        return '<div class="arrival-row"><span>第 ' + (idx + 2) + ' 班</span><b>' + a.clock + '</b><em>约 ' + Math.max(0, Math.round(a.inSeconds / 60)) + ' 分</em></div>';
      }).join('');
      return '<div class="arrival-card" style="--c:' + line.color + '">' +
        '<div class="arrival-head"><div class="arrival-dir"><span class="dir-mark"></span>' + esc(dir.label) + '</div><span class="arrival-status ' + statusClass + '">' + statusText + '</span></div>' +
        '<div class="arrival-main">' +
        '<span class="arrival-count ' + (first && first.inSeconds <= 60 && running ? 'is-soon' : '') + '" data-countdown-at="' + (first && running ? first.at : '') + '">' + countdown + '</span>' +
        '<span class="arrival-unit">' + (running ? '后到站' : (dir.serviceState === 'before' ? '后发首班' : '今日已收班')) + '</span>' +
        '<span class="arrival-abs">' + firstAbs + '</span>' +
        '</div>' +
        (rest ? '<div class="arrival-list">' + rest + '</div>' : '') +
        '<div class="arrival-foot"><span>首班 <b>' + dir.first + '</b> · 末班 <b>' + dir.last + '</b></span><span>间隔约 <b>' + dir.headway + ' 分</b></span></div>' +
        '</div>';
    }).join('');

    var otherLines = station.lines.filter(function (x) { return x.line.id !== state.liveLineId; });
    var transferAt = otherLines.length
      ? '<div class="transfer-at"><div class="eyebrow">同站换乘</div><div class="transfer-at-list">' + otherLines.map(function (x) {
        return '<button type="button" data-live-line="' + x.line.id + '"><span class="line-dot" style="background:' + x.line.color + '"></span>' + esc(x.line.name) + '</button>';
      }).join('') + '</div></div>'
      : '';

    refs.liveContent.innerHTML = hero + tabs +
      '<div class="board-time"><span>下一班列车</span><b class="js-live-clock">' + clockText() + '</b></div>' +
      '<div class="arrival-cards">' + cards + '</div>' +
      transferAt +
      '<div class="live-note"><strong>模拟实时 · </strong>按运行图和北京时间推算，发车间隔约 ' + line.headway + ' 分钟；实际到站可能受运营调整影响。</div>';
  }

  /* ------------------------------------------------------------------ */
  /* line-map sync                                                      */
  /* ------------------------------------------------------------------ */
  function updateNetworkMeta() {
    var updated = (DATA.meta && DATA.meta.updated) || '';
    var month = updated ? updated.slice(0, 7).replace('-', '.') : '';
    if (refs.statLines) refs.statLines.textContent = LINES.length;
    if (refs.statStations) refs.statStations.textContent = model.stationMap.size;
    if (refs.mapMeta && month) refs.mapMeta.textContent = 'NETWORK MAP · ' + month;
    if (refs.dataNoteDate && month) refs.dataNoteDate.textContent = month;
  }

  function refreshAfterSync() {
    updateNetworkMeta();
    if (state.liveStation) renderLiveContent();
    if (state.tab === 'explore' && state.selectedLineId) renderExplore();
  }

  function applySyncedNetwork(incoming) {
    if (!incoming || !incoming.meta || !Array.isArray(incoming.lines) || !incoming.lines.length) {
      throw new Error('invalid network payload');
    }
    var hadRoute = !!state.route;
    var prevMode = state.mapMode;
    var prevLine = state.selectedLineId;
    var prevLive = state.liveStation;
    var prevLiveLine = state.liveLineId;

    DATA = incoming;
    model = Core.build(DATA);
    LINES = model.lines;
    LINE_BY_ID = model.lineMap;
    ALL_LINE_IDS = LINES.map(function (l) { return l.id; });

    state.route = null;
    state.routeOptions = [];
    state.activeRoute = 0;
    state.board = null;
    state.selectedLineId = prevLine && LINE_BY_ID[prevLine] ? prevLine : null;
    state.focusStation = state.focusStation && model.stationMap.has(state.focusStation) ? state.focusStation : null;
    state.exploreHistory = state.exploreHistory.filter(function (h) {
      return LINE_BY_ID[h.lineId] && model.stationMap.has(h.focus);
    });
    state.liveStation = prevLive && model.stationMap.has(prevLive) ? prevLive : null;
    if (state.liveStation) {
      var liveIds = stationLines(state.liveStation).map(function (l) { return l.id; });
      state.liveLineId = liveIds.indexOf(prevLiveLine) !== -1 ? prevLiveLine : liveIds[0];
    } else {
      state.liveLineId = null;
    }
    if (state.userLocation) {
      state.nearbyList = findNearbyStations(state.userLocation.lat, state.userLocation.lon, 3);
      state.nearest = state.nearbyList[0] || null;
    }
    if (prevMode === 'nearby' && state.userLocation && state.nearest) {
      state.mapMode = 'nearby';
      renderNearbyCard();
    } else {
      state.mapMode = state.selectedLineId ? 'line' : (state.liveStation ? 'live' : 'all');
      if (refs.nearbyCard) refs.nearbyCard.hidden = true;
    }

    buildLineRibbon();
    updateNetworkMeta();
    renderRouteResult();
    renderExplore();
    renderLiveContent();
    var prevAnim = state.animateMap;
    state.animateMap = false;
    setupProjection();
    renderMapStatic();
    state.animateMap = prevAnim;
    if (state.tab === 'route') {
      if (hadRoute) {
        refs.routeFeedback.textContent = '线网已更新，请重新生成导航路线。';
        refs.routeFeedback.hidden = false;
      } else {
        refs.routeFeedback.hidden = true;
      }
    }
  }

  function fetchSyncJson(url) {
    return fetch(url, {
      cache: 'no-store',
      credentials: 'same-origin',
      headers: { 'Accept': 'application/json' }
    }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    });
  }

  function syncNetwork() {
    if (syncBusy) return;
    syncBusy = true;
    refs.syncBtn.classList.remove('is-done');
    refs.syncBtn.classList.add('is-syncing');
    refs.syncBtn.setAttribute('aria-busy', 'true');
    var label = refs.syncBtn.querySelector('.sync-label');
    if (label) label.textContent = '同步中';

    var stamp = Date.now();
    fetchSyncJson(SYNC_API + (SYNC_API.indexOf('?') === -1 ? '?' : '&') + '_ts=' + stamp)
      .then(function (payload) { return { payload: payload, online: true }; })
      .catch(function () {
        return fetchSyncJson(SYNC_URL + (SYNC_URL.indexOf('?') === -1 ? '?' : '&') + '_ts=' + stamp)
          .then(function (payload) { return { payload: payload, online: false }; });
      })
      .then(function (result) {
        var payload = result.payload;
        var incoming = payload && payload.data ? payload.data : payload;
        var changed = JSON.stringify(incoming) !== JSON.stringify(DATA);
        var updated = (incoming.meta && incoming.meta.updated) || (DATA.meta && DATA.meta.updated) || '最新版本';
        if (changed) {
          applySyncedNetwork(incoming);
          mapToast((result.online ? '已联网同步 · 西安地铁官网 · ' : '已同步本地线网 · ') + updated);
        } else {
          refreshAfterSync();
          mapToast((result.online ? '已联网检查 · 已是最新 · ' : '已是最新线网 · ') + updated + ' · 到站顺序已刷新');
        }
        refs.syncBtn.dataset.source = result.online ? 'online' : 'local';
      })
      .catch(function () {
        refreshAfterSync();
        mapToast(location.protocol === 'file:'
          ? '未连接同步服务 · 已刷新内置线网与到站顺序'
          : '未连接同步服务 · 使用内置线网与到站顺序');
        refs.syncBtn.dataset.source = 'offline';
      })
      .then(function () {
        syncBusy = false;
        refs.syncBtn.classList.remove('is-syncing');
        refs.syncBtn.removeAttribute('aria-busy');
        refs.syncBtn.classList.add('is-done');
        if (label) label.textContent = '实时同步';
        refs.syncBtn.title = (refs.syncBtn.dataset.source === 'online' ? '上次联网同步 ' : '上次同步 ') + clockText();
        setTimeout(function () { refs.syncBtn.classList.remove('is-done'); }, 1400);
      });
  }

  /* ------------------------------------------------------------------ */
  /* geolocation + nearest entrance                                     */
  /* ------------------------------------------------------------------ */
  function requestLocation() {
    if (state.locating) return;
    if (!navigator.geolocation) {
      state.geoError = '当前浏览器不支持定位，请手动搜索车站。';
      renderNearbyCard();
      return;
    }
    state.locating = true;
    state.geoError = null;
    refs.locateBtn.classList.add('is-locating');
    refs.locateBtn.classList.remove('is-active');
    refs.locateBtn.setAttribute('aria-busy', 'true');
    renderNearbyCard();

    navigator.geolocation.getCurrentPosition(function (position) {
      state.locating = false;
      refs.locateBtn.classList.remove('is-locating');
      refs.locateBtn.classList.add('is-active');
      refs.locateBtn.removeAttribute('aria-busy');
      var lat = position.coords.latitude;
      var lon = position.coords.longitude;
      state.userLocation = {
        lat: lat,
        lon: lon,
        accuracy: position.coords.accuracy || 0,
        at: Date.now()
      };
      state.nearbyList = findNearbyStations(lat, lon, 3);
      state.nearest = state.nearbyList[0] || null;
      state.geoError = null;
      renderNearbyCard();
      state.mapMode = 'nearby';
      applyMapMode('nearby', false);
      fitNearbyView(true);
    }, function (error) {
      state.locating = false;
      refs.locateBtn.classList.remove('is-locating');
      refs.locateBtn.classList.remove('is-active');
      refs.locateBtn.removeAttribute('aria-busy');
      var msg = '定位失败，请稍后重试。';
      if (error && error.code === 1) msg = '定位权限被拒绝，请在浏览器设置中允许位置权限后重试。';
      else if (error && error.code === 2) msg = '暂时无法获取位置，请检查系统定位服务。';
      else if (error && error.code === 3) msg = '定位超时，请到开阔处重试。';
      state.geoError = msg;
      state.userLocation = null;
      state.nearest = null;
      state.nearbyList = [];
      renderNearbyCard();
      renderMarkers();
      mapToast(msg);
    }, { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 });
  }

  function clearLocation() {
    var wasNearby = state.mapMode === 'nearby';
    state.userLocation = null;
    state.nearest = null;
    state.nearbyList = [];
    state.geoError = null;
    state.locating = false;
    refs.locateBtn.classList.remove('is-active', 'is-locating');
    refs.locateBtn.removeAttribute('aria-busy');
    refs.nearbyCard.hidden = true;
    refs.nearbyCard.innerHTML = '';
    refs.userLayer.innerHTML = '';
    if (wasNearby) {
      state.mapMode = 'all';
      applyMapMode('all', true);
    } else {
      renderMarkers();
      updateMapHeader();
      renderLabels();
    }
  }

  function setNearbyMapHeader() {
    if (!state.nearest) return;
    refs.mapTitle.textContent = '最近入站口 · ' + state.nearest.name;
    refs.mapSubtitle.textContent = '当前位置 · ' + formatMeters(state.nearest.meters) + ' · 步行约 ' + walkMinutes(state.nearest.meters) + ' 分钟';
  }

  function fitNearbyView(animate) {
    if (!state.userLocation || !state.nearest || !state.projection) return;
    var doFit = function () {
      if (!state.userLocation || !state.nearest) return;
      var p1 = state.projection.project(state.userLocation.lon, state.userLocation.lat);
      var p2 = state.projectedStations.get(state.nearest.name);
      fitPoints(p2 ? [p1, p2] : [p1], 3.2, 95, animate !== false);
      setNearbyMapHeader();
    };
    if (window.innerWidth <= 860 && !state.sheetCollapsed) {
      setSheetCollapsed(true, true);
      setTimeout(doFit, 330);
    } else {
      doFit();
    }
  }

  function selectNearby(name) {
    var found = state.nearbyList.filter(function (x) { return x.name === name; })[0];
    if (!found) return;
    state.nearest = found;
    renderNearbyCard();
    state.mapMode = 'nearby';
    applyMapMode('nearby', false);
    fitNearbyView(true);
  }

  function renderNearbyCard() {
    var card = refs.nearbyCard;
    if (!state.userLocation && !state.geoError && !state.locating) {
      card.hidden = true;
      card.innerHTML = '';
      return;
    }
    card.hidden = false;    if (state.locating) {
      card.innerHTML = '<div class="nearby-head"><span class="eyebrow">LOCATING</span><button class="nearby-close" type="button" data-nearby-close aria-label="关闭"><svg class="ic"><use href="#i-close"></use></svg></button></div>' +
        '<div class="nearby-title"><i></i>正在获取位置</div>' +
        '<div class="nearby-station">定位中…</div>' +
        '<div class="nearby-note">首次使用需要浏览器授权位置权限。</div>';
      return;
    }
    if (state.geoError) {
      card.innerHTML = '<div class="nearby-head"><span class="eyebrow">LOCATION</span><button class="nearby-close" type="button" data-nearby-close aria-label="关闭"><svg class="ic"><use href="#i-close"></use></svg></button></div>' +
        '<div class="nearby-title"><i style="background:#d87343;box-shadow:0 0 0 4px rgba(216,115,67,.12)"></i>无法定位</div>' +
        '<div class="nearby-error"><p>' + esc(state.geoError) + '</p><button class="nearby-btn is-primary" type="button" data-nearby-retry>重新定位</button></div>';
      return;
    }
    var nearest = state.nearest;
    if (!nearest) { card.hidden = true; return; }
    var others = state.nearbyList.filter(function (x) { return x.name !== nearest.name; }).slice(0, 2);
    var accuracy = state.userLocation.accuracy ? '定位精度 ±' + Math.round(state.userLocation.accuracy) + ' 米' : '直线距离估算';
    var exitUrl = 'https://map.baidu.com/search/' + encodeURIComponent('西安地铁' + nearest.name + '站 出入口');
    card.innerHTML =
      '<div class="nearby-head"><span class="eyebrow">NEARBY · 入站口</span><button class="nearby-close" type="button" data-nearby-close aria-label="关闭定位"><svg class="ic"><use href="#i-close"></use></svg></button></div>' +
      '<div class="nearby-title"><i></i>最近地铁入站口</div>' +
      '<div class="nearby-station">' + esc(nearest.name) + '</div>' +
      '<div class="nearby-meta"><b>' + formatMeters(nearest.meters) + '</b><i></i><span>步行约 ' + walkMinutes(nearest.meters) + ' 分钟</span><i></i><span>' + directionName(nearest.bearing) + '方向</span></div>' +
      '<div class="nearby-lines">' + nearest.lines.map(function (l) {
        return '<span class="line-tag" style="--c:' + l.color + ';--tc:' + contrastText(l.color) + '">' + esc(l.short) + '</span>';
      }).join('') + '</div>' +
      '<div class="nearby-actions">' +
      '<button class="nearby-btn is-primary" type="button" data-nearby-action="origin"><svg class="ic"><use href="#i-route"></use></svg>设为起点</button>' +
      '<button class="nearby-btn" type="button" data-nearby-action="live"><svg class="ic"><use href="#i-clock"></use></svg>实时到站</button>' +
      '<a class="nearby-exit-link" href="' + exitUrl + '" target="_blank" rel="noopener"><svg class="ic"><use href="#i-pin"></use></svg>在百度地图查看出入口</a>' +
      '</div>' +
      (others.length ? '<div class="nearby-alt"><span>附近还有</span>' + others.map(function (x) {
        return '<button type="button" data-nearby-alt="' + esc(x.name) + '">' + esc(x.name) + ' ' + formatMeters(x.meters) + '</button>';
      }).join('') + '</div>' : '') +
      '<div class="nearby-note">' + accuracy + '。按车站中心点直线距离估算；具体出入口位置及开放情况以现场标识为准。</div>';
  }

  function useNearbyAsOrigin() {
    if (!state.nearest) return;
    var name = state.nearest.name;
    refs.fromInput.value = name;
    updateInputClearButtons();
    activateTab('route', { expand: true });
    var to = resolveStation(refs.toInput.value);
    if (to && to !== name) {
      planRoute(name, to);
    } else {
      refs.toInput.focus();
    }
    mapToast('已将 ' + name + ' 设为起点 · 步行约 ' + walkMinutes(state.nearest.meters) + ' 分钟');
  }

  function renderUserLayer() {
    if (!state.userLocation || !state.projection) {
      refs.userLayer.innerHTML = '';
      return;
    }
    var p = state.projection.project(state.userLocation.lon, state.userLocation.lat);
    var accuracy = state.userLocation.accuracy || 40;
    var accuracyBase = accuracy / 111320 * state.projection.scale;
    var minScreenBase = 10 / Math.max(0.5, state.map.scale);
    var r = clamp(Math.max(accuracyBase, minScreenBase), 0.4, 95);
    var svg = '<circle class="user-accuracy" cx="' + p.x.toFixed(1) + '" cy="' + p.y.toFixed(1) + '" r="' + r.toFixed(1) + '"/>';
    if (state.nearest) {
      var target = state.projectedStations.get(state.nearest.name);
      if (target) {
        svg += '<line class="user-route-line" x1="' + p.x.toFixed(1) + '" y1="' + p.y.toFixed(1) + '" x2="' + target.x.toFixed(1) + '" y2="' + target.y.toFixed(1) + '" vector-effect="non-scaling-stroke"/>';
      }
    }
    refs.userLayer.innerHTML = svg;
  }

  /* ------------------------------------------------------------------ */
  /* map projection                                                     */
  /* ------------------------------------------------------------------ */
  function setupProjection() {
    var rect = refs.mapCanvas.getBoundingClientRect();
    if (rect.width < 20 || rect.height < 20) return;
    var W = Math.round(rect.width);
    var H = Math.round(rect.height);
    state.map.W = W;
    state.map.H = H;
    refs.svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    refs.svg.setAttribute('preserveAspectRatio', 'none');

    var minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
    model.stationMap.forEach(function (s) {
      minLon = Math.min(minLon, s.lon); maxLon = Math.max(maxLon, s.lon);
      minLat = Math.min(minLat, s.lat); maxLat = Math.max(maxLat, s.lat);
    });
    var latMid = (minLat + maxLat) / 2;
    var cosLat = Math.cos(latMid * Math.PI / 180);
    var xSpan = (maxLon - minLon) * cosLat;
    var ySpan = (maxLat - minLat);
    var pad = Math.max(34, Math.min(62, Math.min(W, H) * 0.075));
    var scale = Math.min((W - pad * 2) / xSpan, (H - pad * 2) / ySpan);
    var offsetX = (W - xSpan * scale) / 2;
    var offsetY = (H - ySpan * scale) / 2;
    state.projection = {
      minLon: minLon, maxLon: maxLon, minLat: minLat, maxLat: maxLat,
      cosLat: cosLat, scale: scale, offsetX: offsetX, offsetY: offsetY,
      project: function (lon, lat) {
        return {
          x: offsetX + (lon - minLon) * cosLat * scale,
          y: offsetY + (maxLat - lat) * scale
        };
      }
    };
    state.projectedLines = LINES.map(function (line) {
      return {
        line: line,
        points: line.stations.map(function (s) { return state.projection.project(s.lon, s.lat); }),
        path: line.path.map(function (c) { return state.projection.project(c[0], c[1]); })
      };
    });
    state.projectedStations = new Map();
    model.stationMap.forEach(function (entry) {
      var p = state.projection.project(entry.lon, entry.lat);
      state.projectedStations.set(entry.name, { entry: entry, x: p.x, y: p.y });
    });
    state.map.scale = 1;
    state.map.tx = 0;
    state.map.ty = 0;
  }

  function renderMapStatic() {
    if (!state.projection) return;
    renderContext();
    renderLines();
    renderStations();
    applyView();
    applyMapMode(state.mapMode, false);
    fitForMode();
  }

  function renderContext() {
    var p = state.projection;
    if (!p) return;
    var river = [[108.55, 34.392], [108.66, 34.414], [108.78, 34.437], [108.90, 34.449], [109.02, 34.451], [109.13, 34.462], [109.25, 34.486], [109.32, 34.503]].map(function (c) {
      return p.project(c[0], c[1]);
    });
    var d = river.map(function (pt, i) { return (i ? 'L' : 'M') + pt.x.toFixed(1) + ' ' + pt.y.toFixed(1); }).join(' ');
    var cities = [
      ['咸阳', 108.700, 34.350], ['西咸', 108.775, 34.300], ['西安', 108.960, 34.340],
      ['浐灞', 109.045, 34.355], ['曲江', 108.985, 34.190], ['临潼', 109.205, 34.365],
      ['机场', 108.710, 34.452]
    ];
    refs.contextLayer.innerHTML = '<path d="' + d + '" fill="none" stroke="#d8e9e8" stroke-width="12" stroke-linecap="round" opacity=".6"/>' +
      '<path d="' + d + '" fill="none" stroke="#c9e1e1" stroke-width="1.2" stroke-linecap="round" opacity=".65"/>' +
      cities.map(function (c) {
        var pt = p.project(c[1], c[2]);
        return '<text x="' + pt.x.toFixed(1) + '" y="' + pt.y.toFixed(1) + '" text-anchor="middle" font-size="9" font-weight="600" letter-spacing="2" fill="#a9b7ae" opacity=".62">' + c[0] + '</text>';
      }).join('') +
      (function () {
        var pt = p.project(108.86, 34.451);
        return '<text x="' + pt.x.toFixed(1) + '" y="' + (pt.y - 9).toFixed(1) + '" text-anchor="middle" font-size="8" fill="#a2bdc0" letter-spacing="3" opacity=".8">渭 河</text>';
      })();
  }

  function pathData(points) {
    return points.map(function (pt, i) {
      return (i ? 'L' : 'M') + pt.x.toFixed(1) + ' ' + pt.y.toFixed(1);
    }).join(' ');
  }

  function renderLines() {
    refs.lineLayer.innerHTML = state.projectedLines.map(function (pl) {
      var d = pathData(pl.path);
      return '<g class="line-group" data-line="' + pl.line.id + '" style="--c:' + pl.line.color + '">' +
        '<path class="line-casing" d="' + d + '" vector-effect="non-scaling-stroke"/>' +
        '<path class="line-stroke" d="' + d + '" vector-effect="non-scaling-stroke"/>' +
        '<path class="line-hit" d="' + d + '" vector-effect="non-scaling-stroke"><title>' + esc(pl.line.name) + '</title></path>' +
        '</g>';
    }).join('');
  }

  function renderStations() {
    var html = '';
    state.projectedStations.forEach(function (ps, name) {
      var entry = ps.entry;
      var lines = entry.lines.map(function (x) { return x.line; });
      var primary = lines[0];
      var isTransfer = lines.length > 1;
      var inv = 1 / state.map.scale;
      html += '<g class="station-group" data-station="' + esc(name) + '" data-lines="' + lines.map(function (l) { return l.id; }).join(',') + '" transform="translate(' + ps.x.toFixed(1) + ' ' + ps.y.toFixed(1) + ')">' +
        '<title>' + esc(name) + (isTransfer ? '（换乘站）' : '') + '</title>' +
        '<g class="station-art" transform="scale(' + inv.toFixed(4) + ')">' +
        '<circle class="station-halo" r="8"/>';
      if (isTransfer) {
        html += '<circle class="station-transfer" r="5.1"/>';
      } else {
        html += '<circle class="station-dot" r="2.9" style="stroke:' + primary.color + '"/>';
      }
      html += '<circle r="11" fill="transparent"/></g></g>';
    });
    refs.stationLayer.innerHTML = html;
  }

  /* ------------------------------------------------------------------ */
  /* map view                                                           */
  /* ------------------------------------------------------------------ */
  function applyView() {
    var m = state.map;
    refs.mapRoot.setAttribute('transform', 'translate(' + m.tx.toFixed(2) + ' ' + m.ty.toFixed(2) + ') scale(' + m.scale.toFixed(4) + ')');
    if (refs.contextLayer) refs.contextLayer.style.opacity = m.scale > 1.6 ? '0.24' : '1';
    updateInverseScale();
  }

  function updateInverseScale() {
    var s = state.map.scale;
    var inv = (1 / s).toFixed(4);
    $all('.station-art', refs.stationLayer).forEach(function (el) {
      el.setAttribute('transform', 'scale(' + inv + ')');
    });
    $all('[data-inverse="1"]', refs.labelLayer).forEach(function (el) {
      var x = el.getAttribute('data-x');
      var y = el.getAttribute('data-y');
      el.setAttribute('transform', 'translate(' + x + ' ' + y + ') scale(' + inv + ')');
    });
    $all('[data-screen-marker="1"]', refs.markerLayer).forEach(function (el) {
      var x = el.getAttribute('data-x');
      var y = el.getAttribute('data-y');
      el.setAttribute('transform', 'translate(' + x + ' ' + y + ') scale(' + inv + ')');
    });
  }

  function scheduleLabels() {
    updateInverseScale();
    if (labelRaf) return;
    labelRaf = requestAnimationFrame(function () {
      labelRaf = 0;
      renderLabels();
    });
  }

  function clampView() {
    var m = state.map;
    var bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    state.projectedStations.forEach(function (ps) {
      bounds.minX = Math.min(bounds.minX, ps.x); bounds.maxX = Math.max(bounds.maxX, ps.x);
      bounds.minY = Math.min(bounds.minY, ps.y); bounds.maxY = Math.max(bounds.maxY, ps.y);
    });
    if (!isFinite(bounds.minX)) return;
    var keep = 54;
    var minTx = keep - bounds.maxX * m.scale;
    var maxTx = m.W - keep - bounds.minX * m.scale;
    var minTy = keep - bounds.maxY * m.scale;
    var maxTy = m.H - keep - bounds.minY * m.scale;
    if (minTx > maxTx) { var cx = m.W / 2; minTx = maxTx = cx - ((bounds.minX + bounds.maxX) / 2) * m.scale; }
    if (minTy > maxTy) { var cy = m.H / 2; minTy = maxTy = cy - ((bounds.minY + bounds.maxY) / 2) * m.scale; }
    m.tx = clamp(m.tx, minTx, maxTx);
    m.ty = clamp(m.ty, minTy, maxTy);
  }

  function zoomAt(px, py, factor) {
    var m = state.map;
    var next = clamp(m.scale * factor, 0.6, 4.5);
    if (Math.abs(next - m.scale) < 0.0005) return;
    cancelViewAnimation();
    var ratio = next / m.scale;
    m.tx = px - (px - m.tx) * ratio;
    m.ty = py - (py - m.ty) * ratio;
    m.scale = next;
    clampView();
    applyView();
    scheduleLabels();
  }

  function cancelViewAnimation() {
    if (viewAnimation) {
      cancelAnimationFrame(viewAnimation);
      viewAnimation = 0;
    }
  }

  function animateViewTo(targetScale, targetTx, targetTy, duration) {
    cancelViewAnimation();
    var start = { scale: state.map.scale, tx: state.map.tx, ty: state.map.ty };
    var end = { scale: targetScale, tx: targetTx, ty: targetTy };
    if (Math.abs(start.scale - end.scale) < 0.001 && Math.abs(start.tx - end.tx) < 1 && Math.abs(start.ty - end.ty) < 1) {
      state.map.scale = targetScale; state.map.tx = targetTx; state.map.ty = targetTy;
      applyView();
      renderLabels();
      return;
    }
    var startTime = performance.now();
    var dur = duration || 480;
    function ease(t) { return t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }
    function step(now) {
      var t = clamp((now - startTime) / dur, 0, 1);
      var e = ease(t);
      state.map.scale = start.scale + (end.scale - start.scale) * e;
      state.map.tx = start.tx + (end.tx - start.tx) * e;
      state.map.ty = start.ty + (end.ty - start.ty) * e;
      applyView();
      if (t < 1) {
        viewAnimation = requestAnimationFrame(step);
      } else {
        viewAnimation = 0;
        renderLabels();
      }
    }
    viewAnimation = requestAnimationFrame(step);
  }

  function fitPoints(points, maxScale, padding, animate) {
    if (!points.length || !state.map.W) return;
    var region = visibleRegion();
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    points.forEach(function (p) {
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    });
    var w = Math.max(4, maxX - minX);
    var h = Math.max(4, maxY - minY);
    var availW = Math.max(80, region.right - region.left);
    var availH = Math.max(80, region.bottom - region.top);
    var s = Math.min(availW / (w + (padding || 20)), availH / (h + (padding || 20)), maxScale || 2.2);
    s = clamp(s, 0.55, 4.5);
    var cx = (minX + maxX) / 2;
    var cy = (minY + maxY) / 2;
    var targetTx = region.left + availW / 2 - cx * s;
    var targetTy = region.top + availH / 2 - cy * s;
    var saved = { scale: state.map.scale, tx: state.map.tx, ty: state.map.ty };
    state.map.scale = s;
    state.map.tx = targetTx;
    state.map.ty = targetTy;
    clampView();
    targetTx = state.map.tx;
    targetTy = state.map.ty;
    state.map.scale = saved.scale;
    state.map.tx = saved.tx;
    state.map.ty = saved.ty;
    var shouldAnimate = animate === undefined ? state.animateMap : animate;
    if (shouldAnimate && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      animateViewTo(s, targetTx, targetTy, 480);
    } else {
      cancelViewAnimation();
      state.map.scale = s;
      state.map.tx = targetTx;
      state.map.ty = targetTy;
      applyView();
      renderLabels();
    }
  }

  function visibleRegion() {
    var W = state.map.W, H = state.map.H;
    var mobile = window.innerWidth <= 860;
    var top = mobile ? 78 : 98;
    var sheetH = 0;
    if (mobile) {
      sheetH = refs.sidePanel.getBoundingClientRect().height;
      if (state.sheetCollapsed) sheetH = 76;
    }
    var bottom = mobile ? H - sheetH - 60 : H - 68;
    var left = mobile ? 14 : 42;
    var right = W - (mobile ? 14 : 42);
    if (mobile && state.userLocation && refs.nearbyCard && !refs.nearbyCard.hidden) {
      var cardRect = refs.nearbyCard.getBoundingClientRect();
      var canvasRect = refs.mapCanvas.getBoundingClientRect();
      top = Math.max(top, cardRect.bottom - canvasRect.top + 12);
    }
    if (bottom - top < 130) bottom = Math.min(H - 40, top + 130);
    return { left: left, right: right, top: top, bottom: bottom };
  }

  function fitForMode(animate) {
    if (!state.projection) return;
    if (state.mapMode === 'nearby' && state.userLocation && state.nearest) {
      var p1 = state.projection.project(state.userLocation.lon, state.userLocation.lat);
      var p2 = state.projectedStations.get(state.nearest.name);
      fitPoints(p2 ? [p1, p2] : [p1], 3.2, 95, animate);
    } else if (state.mapMode === 'route' && state.route) {
      var pts = [];
      state.route.segments.forEach(function (seg) {
        var line = LINE_BY_ID[seg.lineId];
        seg.stations.forEach(function (name) {
          var ps = state.projectedStations.get(name);
          if (ps) pts.push(ps);
        });
      });
      fitPoints(pts, 3.1, 34, animate);
    } else if (state.mapMode === 'line' && state.selectedLineId) {
      var line = LINE_BY_ID[state.selectedLineId];
      var lpts = line.stations.map(function (s) { return state.projectedStations.get(s.name); }).filter(Boolean);
      fitPoints(lpts, 2.7, 32, animate);
    } else if (state.mapMode === 'live' && state.liveStation) {
      focusStationOnMap(state.liveStation, animate);
    } else {
      var all = [];
      state.projectedStations.forEach(function (ps) { all.push(ps); });
      fitPoints(all, 1.35, 18, animate);
    }
  }

  function focusStationOnMap(name, animate) {
    var ps = state.projectedStations.get(name);
    if (!ps) return;
    var region = visibleRegion();
    var s = Math.max(state.map.scale, 2.25);
    s = clamp(s, 0.8, 3.5);
    var targetTx = (region.left + region.right) / 2 - ps.x * s;
    var targetTy = (region.top + region.bottom) / 2 - ps.y * s;
    var shouldAnimate = animate === undefined ? state.animateMap : animate;
    if (shouldAnimate) {
      animateViewTo(s, targetTx, targetTy, 460);
    } else {
      cancelViewAnimation();
      state.map.scale = s;
      state.map.tx = targetTx;
      state.map.ty = targetTy;
      clampView();
      applyView();
      renderLabels();
    }
  }
  /* ------------------------------------------------------------------ */
  /* map labels and pills                                               */
  /* ------------------------------------------------------------------ */
  function stationLabelLayout(name) {
    var ls = stationLines(name);
    var focusLine = null;
    if (state.selectedLineId && ls.some(function (l) { return l.id === state.selectedLineId; })) {
      focusLine = LINE_BY_ID[state.selectedLineId];
    } else if (state.route) {
      var routeLineId = null;
      state.route.segments.forEach(function (s) {
        if (s.stations.indexOf(name) !== -1 && !routeLineId) routeLineId = s.lineId;
      });
      if (routeLineId) focusLine = LINE_BY_ID[routeLineId];
    }
    if (!focusLine) focusLine = ls[0];
    if (!focusLine) return { anchor: 'start', dx: 6, dy: -6 };
    var idx = -1;
    for (var i = 0; i < focusLine.stations.length; i++) {
      if (focusLine.stations[i].name === name) { idx = i; break; }
    }
    var pl = state.projectedLines.filter(function (x) { return x.line.id === focusLine.id; })[0];
    if (!pl || idx < 0) return { anchor: 'start', dx: 6, dy: -6 };
    var prev = pl.points[idx - 1];
    var next = pl.points[idx + 1];
    if (!prev && focusLine.loop) prev = pl.points[pl.points.length - 1];
    if (!next && focusLine.loop) next = pl.points[0];
    if (prev && next) {
      var vx = next.x - prev.x;
      var vy = next.y - prev.y;
      if (Math.abs(vx) >= Math.abs(vy) * 1.12) {
        return { anchor: 'middle', dx: 0, dy: idx % 2 ? 13 : -7 };
      }
      var anchor = vx >= 0 ? 'start' : 'end';
      var p = state.projectedStations.get(name);
      if (anchor === 'start' && p && p.x > state.map.W - 82) anchor = 'end';
      return { anchor: anchor, dx: anchor === 'start' ? 7 : -7, dy: 3 };
    }
    return { anchor: 'start', dx: 6, dy: -6 };
  }

  function renderLabels() {
    if (!state.projection) return;
    var m = state.map;
    var s = m.scale;
    var html = '';
    var occupied = [];

    /* line pills (desktop / tablet labels only; the mobile ribbon carries this) */
    if (m.W >= 560 && state.mapMode === 'all' && s <= 1.7) state.projectedLines.forEach(function (pl) {
      var line = pl.line;
      var pts = pl.points;
      if (!pts.length) return;
      if (state.mapMode === 'line' && state.selectedLineId !== line.id) return;
      if (state.mapMode === 'route' && state.route && state.route.lineIds.indexOf(line.id) === -1) return;
      if (state.mapMode === 'live' && state.liveStation && stationLines(state.liveStation).every(function (l) { return l.id !== line.id; })) return;
      var center = { x: m.W / 2, y: m.H / 2 };
      var first = pts[0], last = pts[pts.length - 1];
      var dFirst = Math.hypot(first.x - center.x, first.y - center.y);
      var dLast = Math.hypot(last.x - center.x, last.y - center.y);
      var anchorPoint = dFirst >= dLast ? first : last;
      var vx = anchorPoint.x - center.x;
      var vy = anchorPoint.y - center.y;
      var len = Math.hypot(vx, vy) || 1;
      var px = anchorPoint.x + vx / len * 19;
      var py = anchorPoint.y + vy / len * 19;
      var label = line.short;
      var width = Math.max(30, label.length * 7.8 + 12);
      px = clamp(px, width / 2 + 5, m.W - width / 2 - 5);
      py = clamp(py, 76, m.H - 28);
      var tx = -width / 2;
      var color = line.color;
      var textColor = contrastText(color);
      var dim = (state.mapMode === 'line' && state.selectedLineId !== line.id) ||
        (state.mapMode === 'route' && state.route && state.route.lineIds.indexOf(line.id) === -1) ||
        (state.mapMode === 'live' && state.liveStation && stationLines(state.liveStation).every(function (l) { return l.id !== line.id; }));
      var opacity = dim ? 0.16 : 1;
      if (state.mapMode === 'route' && state.route && state.route.lineIds.indexOf(line.id) !== -1) opacity = 1;
      html += '<g class="map-line-pill" data-inverse="1" data-x="' + px.toFixed(1) + '" data-y="' + py.toFixed(1) + '" transform="translate(' + px.toFixed(1) + ' ' + py.toFixed(1) + ') scale(' + (1 / s).toFixed(4) + ')" opacity="' + opacity + '">' +
        '<rect x="' + tx.toFixed(1) + '" y="-8" width="' + width.toFixed(1) + '" height="16" rx="5" fill="' + color + '"/>' +
        '<text x="0" y="3.2" text-anchor="middle" fill="' + textColor + '">' + esc(label) + '</text>' +
        '</g>';
      occupied.push({ x: px - width / 2, y: py - 8, w: width, h: 16 });
    });

    /* reserve room for route endpoint names drawn with the markers */
    if (state.mapMode === 'route' && state.route) {
      var rtFirst = state.route.segments[0];
      var rtLast = state.route.segments[state.route.segments.length - 1];
      [rtFirst && rtFirst.board, rtLast && rtLast.alight].forEach(function (name) {
        if (!name) return;
        var ps = state.projectedStations.get(name);
        if (!ps) return;
        var sx = ps.x * s + m.tx;
        var sy = ps.y * s + m.ty;
        var w = estimateTextWidth(name, 9.5) + 5;
        occupied.push({ x: sx - w / 2, y: sy - 25, w: w, h: 14 });
      });
    }

    /* station labels */
    var candidates = [];
    var routeNames = new Set();
    if (state.route) {
      state.route.segments.forEach(function (seg) {
        seg.stations.forEach(function (name) { routeNames.add(name); });
      });
    }
    var selectedLine = state.selectedLineId ? LINE_BY_ID[state.selectedLineId] : null;
    var selectedNames = new Set();
    if (selectedLine) selectedLine.stations.forEach(function (st) { selectedNames.add(st.name); });

    state.projectedStations.forEach(function (ps, name) {
      var entry = ps.entry;
      var isTransfer = entry.lines.length > 1;
      var isKey = KEY_STATIONS.indexOf(name) !== -1;
      var inRoute = routeNames.has(name);
      var inLine = selectedNames.has(name);
      var show = false;
      var priority = 0;
      var cls = '';
      if (state.nearest && name === state.nearest.name) {
        show = true;
        priority = 2600;
        cls = 'is-route is-key';
      } else if (state.mapMode === 'route' && state.route) {
        if (inRoute) { show = true; priority = isTransfer ? 1300 : 1200; cls = 'is-route'; }
        else if (isKey && s > 1.7) { show = true; priority = 40; }
      } else if (state.mapMode === 'line' && selectedLine) {
        if (inLine) { show = true; priority = isTransfer ? 1200 : 1000; }
        else if (isKey && s > 2.0) { show = true; priority = 30; }
      } else if (state.mapMode === 'nearby' && state.nearest) {
        if (isKey) { show = true; priority = 900; }
      } else if (state.mapMode === 'live' && state.liveStation) {
        if (name === state.liveStation) { show = true; priority = 2400; cls = 'is-route is-key'; }
        else if (isKey && s > 1.25) { show = true; priority = 900; }
      } else {
        if (isKey) { show = true; priority = 1000; }
        else if (isTransfer && (state.labelAll || s > 1.14)) { show = true; priority = 650; }
        else if (state.labelAll || s > 1.8) { show = true; priority = 100; }
      }
      if (state.labelAll) show = true;
      if (!show) return;
      if (state.mapMode === 'route' && state.route) {
        var rtFirst = state.route.segments[0];
        var rtLast = state.route.segments[state.route.segments.length - 1];
        if ((rtFirst && rtFirst.board === name) || (rtLast && rtLast.alight === name)) return;
      }
      if (isTransfer) cls += ' is-transfer';
      if (isKey) cls += ' is-key';
      candidates.push({
        name: name, x: ps.x, y: ps.y, priority: priority, cls: cls.trim(), isTransfer: isTransfer
      });
    });

    candidates.sort(function (a, b) { return b.priority - a.priority; });
    var shown = 0;
    for (var i = 0; i < candidates.length && shown < 95; i++) {
      var c = candidates[i];
      var layout = stationLabelLayout(c.name);
      var screenX = c.x * s + m.tx;
      var screenY = c.y * s + m.ty;
      var fontSize = c.cls.indexOf('is-key') !== -1 ? 10.5 : 9.5;
      var textW = estimateTextWidth(c.name, fontSize);
      var boxW = textW + 3;
      var boxH = fontSize + 4;
      var left = layout.anchor === 'middle' ? screenX + layout.dx - boxW / 2 : (layout.anchor === 'end' ? screenX + layout.dx - boxW : screenX + layout.dx);
      var top = screenY + layout.dy - fontSize + 1;
      var box = { x: left, y: top, w: boxW, h: boxH };
      if (box.x < 4 || box.x + box.w > m.W - 4 || box.y < 58 || box.y + box.h > m.H - 4) continue;
      var collides = false;
      for (var j = 0; j < occupied.length; j++) {
        var o = occupied[j];
        if (box.x < o.x + o.w + 2 && box.x + box.w + 2 > o.x && box.y < o.y + o.h + 1 && box.y + box.h + 1 > o.y) {
          collides = true; break;
        }
      }
      if (collides) continue;
      occupied.push(box);
      shown++;
      var anchor = layout.anchor;
      html += '<g class="map-label ' + c.cls + '" data-inverse="1" data-x="' + c.x.toFixed(1) + '" data-y="' + c.y.toFixed(1) + '" transform="translate(' + c.x.toFixed(1) + ' ' + c.y.toFixed(1) + ') scale(' + (1 / s).toFixed(4) + ')">' +
        '<text x="' + layout.dx + '" y="' + layout.dy + '" text-anchor="' + anchor + '">' + esc(c.name) + '</text>' +
        '</g>';
    }

    refs.labelLayer.innerHTML = html;
    updateInverseScale();
  }

  function estimateTextWidth(text, fontSize) {
    var w = 0;
    for (var i = 0; i < text.length; i++) {
      var ch = text.charCodeAt(i);
      if (ch >= 0x4e00) w += fontSize;
      else if (ch >= 0x30 && ch <= 0x7a) w += fontSize * .56;
      else w += fontSize * .72;
    }
    return w;
  }

  /* ------------------------------------------------------------------ */
  /* map mode + overlays                                                */
  /* ------------------------------------------------------------------ */
  function resetLineDraw() {
    lineDrawTimers.forEach(function (t) { clearTimeout(t); });
    lineDrawTimers = [];
    lineDrawFrames.forEach(function (f) { cancelAnimationFrame(f); });
    lineDrawFrames = [];
    $all('.line-group', refs.lineLayer).forEach(function (g) {
      g.classList.remove('is-drawing');
      var p = g.querySelector('.line-stroke');
      if (!p) return;
      p.style.transition = '';
      p.style.opacity = '';
      if (p.__fullPath) {
        p.setAttribute('d', p.__fullPath);
        delete p.__fullPath;
      }
    });
  }

  function drawLineIn(lineId, delay) {
    var t = setTimeout(function () {
      var g = refs.lineLayer.querySelector('.line-group[data-line="' + lineId + '"]');
      if (!g) return;
      var p = g.querySelector('.line-stroke');
      if (!p) return;
      var len = 0;
      try { len = p.getTotalLength(); } catch (e) { len = 0; }
      if (!len) return;
      p.__fullPath = p.getAttribute('d');
      var sampleCount = Math.max(36, Math.min(120, Math.round(len / 7)));
      var samples = [];
      for (var i = 0; i <= sampleCount; i++) {
        var pt = p.getPointAtLength(len * i / sampleCount);
        samples.push([pt.x, pt.y]);
      }
      function partialPath(ratio) {
        var n = Math.max(1, Math.floor(samples.length * ratio));
        var parts = ['M' + samples[0][0].toFixed(1) + ' ' + samples[0][1].toFixed(1)];
        for (var j = 1; j < n; j++) parts.push('L' + samples[j][0].toFixed(1) + ' ' + samples[j][1].toFixed(1));
        return parts.join(' ');
      }
      g.classList.add('is-drawing');
      p.style.transition = '';
      p.style.opacity = '';
      var began = performance.now();
      var duration = 700;
      function frame(now) {
        var t2 = Math.min(1, (now - began) / duration);
        var eased = 1 - Math.pow(1 - t2, 3);
        p.setAttribute('d', partialPath(Math.max(0.002, eased)));
        if (t2 < 1) {
          lineDrawFrames.push(requestAnimationFrame(frame));
        } else {
          p.setAttribute('d', p.__fullPath);
          delete p.__fullPath;
          g.classList.remove('is-drawing');
        }
      }
      lineDrawFrames.push(requestAnimationFrame(frame));
    }, delay || 0);
    lineDrawTimers.push(t);
  }

  function animateActiveLines() {
    resetLineDraw();
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    /* only a deliberate single-line switch gets the draw-in effect */
    if (state.mapMode !== 'line' || !state.selectedLineId) return;
    var ids = [state.selectedLineId];
    ids.forEach(function (id) {
      var g = refs.lineLayer.querySelector('.line-group[data-line="' + id + '"]');
      var p = g && g.querySelector('.line-stroke');
      if (!p) return;
      p.style.transition = 'none';
      p.style.opacity = '0';
    });
    ids.forEach(function (id, i) { drawLineIn(id, 40 + i * 60); });
  }

  function applyMapMode(mode, fit) {
    state.mapMode = mode;
    var routeLineIds = state.route ? state.route.lineIds : [];
    var liveLineIds = state.liveStation ? stationLines(state.liveStation).map(function (l) { return l.id; }) : [];
    var nearbyLineIds = state.nearest ? state.nearest.lines.map(function (l) { return l.id; }) : [];
    var routeNames = new Set();
    if (state.route) {
      state.route.segments.forEach(function (seg) {
        seg.stations.forEach(function (name) { routeNames.add(name); });
      });
    }
    $all('.line-group', refs.lineLayer).forEach(function (el) {
      var id = el.getAttribute('data-line');
      var dim = false;
      var selected = false;
      if (mode === 'line' && state.selectedLineId) {
        dim = id !== state.selectedLineId;
        selected = id === state.selectedLineId;
      } else if (mode === 'route' && state.route) {
        dim = routeLineIds.indexOf(id) === -1;
        selected = false;
      } else if (mode === 'live' && state.liveStation) {
        dim = liveLineIds.indexOf(id) === -1;
        selected = false;
      } else if (mode === 'nearby' && state.nearest) {
        dim = nearbyLineIds.indexOf(id) === -1;
        selected = false;
      }
      el.classList.toggle('is-dim', dim);
      el.classList.toggle('is-selected', selected);
      el.classList.toggle('is-route', mode === 'route' && !dim);
    });

    $all('.station-group', refs.stationLayer).forEach(function (el) {
      var name = el.getAttribute('data-station');
      var ls = stationLines(name).map(function (l) { return l.id; });
      var muted = false;
      if (mode === 'line' && state.selectedLineId) {
        muted = ls.indexOf(state.selectedLineId) === -1;
      } else if (mode === 'route' && state.route) {
        muted = !routeNames.has(name);
      } else if (mode === 'live' && state.liveStation) {
        muted = name !== state.liveStation && !ls.some(function (id) { return liveLineIds.indexOf(id) !== -1; });
      } else if (mode === 'nearby' && state.nearest) {
        muted = name !== state.nearest.name && !ls.some(function (id) { return nearbyLineIds.indexOf(id) !== -1; });
      }
      el.classList.toggle('is-muted', muted);
      el.classList.toggle('is-route', mode === 'route' && routeNames.has(name));
      el.classList.toggle('is-selected', (mode === 'live' && state.liveStation === name) || (mode === 'line' && state.focusStation === name) || (mode === 'nearby' && state.nearest && state.nearest.name === name));
    });

    renderRouteOverlay();
    renderMarkers();
    renderLabels();
    updateMapHeader();
    updateRibbon();
    if (fit) {
      fitForMode();
      animateActiveLines();
    } else {
      resetLineDraw();
      updateInverseScale();
    }
  }

  function renderRouteOverlay() {
    if (state.mapMode !== 'route' || !state.route) {
      refs.routeLayer.innerHTML = '';
      return;
    }
    var html = '';
    state.route.segments.forEach(function (seg) {
      var line = LINE_BY_ID[seg.lineId];
      var pts = seg.stations.map(function (name) {
        var idx = -1;
        for (var i = 0; i < line.stations.length; i++) if (line.stations[i].name === name) { idx = i; break; }
        if (idx < 0) return null;
        return state.projection.project(line.stations[idx].lon, line.stations[idx].lat);
      }).filter(Boolean);
      if (pts.length < 2) return;
      var d = pathData(pts);
      html += '<path class="route-casing" d="' + d + '" vector-effect="non-scaling-stroke"/>' +
        '<path class="route-line" d="' + d + '" stroke="' + line.color + '" vector-effect="non-scaling-stroke"/>' +
        '<path class="route-dash" d="' + d + '" vector-effect="non-scaling-stroke"/>';
    });
    refs.routeLayer.innerHTML = html;
  }

  function renderMarkers() {
    var html = '';
    var s = state.map.scale;
    if (state.mapMode === 'route' && state.route) {
      /* transfer markers */
      state.route.transfers.forEach(function (t) {
        var ps = state.projectedStations.get(t.station);
        if (!ps) return;
        html += screenRing(ps.x, ps.y, 6.2, '#ffffff', '#183229', 2);
      });
      var first = state.route.segments[0];
      var last = state.route.segments[state.route.segments.length - 1];
      if (first && last) {
        var a = state.projectedStations.get(first.board);
        var b = state.projectedStations.get(last.alight);
        if (a) html += screenMarker(a.x, a.y, '起', '#0f6b55', first.board);
        if (b) html += screenMarker(b.x, b.y, '终', '#d87343', last.alight);
      }
    } else if (state.mapMode === 'line' && state.focusStation) {
      var fp = state.projectedStations.get(state.focusStation);
      if (fp) html += focusRing(fp.x, fp.y, LINE_BY_ID[state.selectedLineId] ? LINE_BY_ID[state.selectedLineId].color : '#0f6b55');
    } else if (state.mapMode === 'live' && state.liveStation) {
      var lp = state.projectedStations.get(state.liveStation);
      if (lp) html += focusRing(lp.x, lp.y, '#0f6b55');
    }
    if (state.userLocation) {
      var up = state.projection.project(state.userLocation.lon, state.userLocation.lat);
      html += '<g data-screen-marker="1" data-x="' + up.x.toFixed(1) + '" data-y="' + up.y.toFixed(1) + '" transform="translate(' + up.x.toFixed(1) + ' ' + up.y.toFixed(1) + ') scale(' + (1 / state.map.scale).toFixed(4) + ')" pointer-events="none">' +
        '<circle class="user-dot-pulse" r="15"/>' +
        '<circle class="user-dot" r="5.8"/>' +
        '</g>';
      if (state.nearest) {
        var np = state.projectedStations.get(state.nearest.name);
        if (np) html += focusRing(np.x, np.y, '#0f6b55');
      }
    }
    refs.markerLayer.innerHTML = html;
    renderUserLayer();
    updateInverseScale();
  }

  function screenMarker(x, y, text, color, name) {
    return '<g data-screen-marker="1" data-x="' + x.toFixed(1) + '" data-y="' + y.toFixed(1) + '" transform="translate(' + x.toFixed(1) + ' ' + y.toFixed(1) + ') scale(' + (1 / state.map.scale).toFixed(4) + ')" pointer-events="none">' +
      '<circle r="9" fill="' + color + '" stroke="#fff" stroke-width="2.4"/>' +
      '<text y="3.1" text-anchor="middle" font-size="8" font-weight="700" fill="#fff">' + text + '</text>' +
      (name ? '<text y="-15" text-anchor="middle" font-size="9.5" font-weight="700" fill="#17352a" stroke="#f2f5f0" stroke-width="3" paint-order="stroke" stroke-linejoin="round">' + esc(name) + '</text>' : '') +
      '</g>';
  }

  function screenRing(x, y, r, fill, stroke, width) {
    return '<g data-screen-marker="1" data-x="' + x.toFixed(1) + '" data-y="' + y.toFixed(1) + '" transform="translate(' + x.toFixed(1) + ' ' + y.toFixed(1) + ') scale(' + (1 / state.map.scale).toFixed(4) + ')" pointer-events="none">' +
      '<circle r="' + r + '" fill="' + fill + '" stroke="' + stroke + '" stroke-width="' + width + '"/>' +
      '</g>';
  }

  function focusRing(x, y, color) {
    return '<g data-screen-marker="1" data-x="' + x.toFixed(1) + '" data-y="' + y.toFixed(1) + '" transform="translate(' + x.toFixed(1) + ' ' + y.toFixed(1) + ') scale(' + (1 / state.map.scale).toFixed(4) + ')" pointer-events="none">' +
      '<circle class="focus-ring" r="13" fill="none" stroke="' + color + '" stroke-width="1.6" opacity=".45"/>' +
      '<circle r="5.2" fill="#fff" stroke="' + color + '" stroke-width="2.4"/>' +
      '</g>';
  }

  function updateMapHeader() {
    if (state.mapMode === 'nearby' && state.nearest) {
      refs.mapTitle.textContent = '最近入站口 · ' + state.nearest.name;
      refs.mapSubtitle.textContent = '当前位置 · ' + formatMeters(state.nearest.meters) + ' · 步行约 ' + walkMinutes(state.nearest.meters) + ' 分钟';
    } else if (state.mapMode === 'route' && state.route) {
      refs.mapTitle.textContent = state.route.from + ' → ' + state.route.to;
      refs.mapSubtitle.textContent = state.route.durationMin + ' 分钟 · ' + (state.route.transferCount ? state.route.transferCount + ' 次换乘' : '无需换乘') + ' · ' + state.route.fare + ' 元 · 点击站点查看实时到站';
    } else if (state.mapMode === 'line' && state.selectedLineId) {
      var l = LINE_BY_ID[state.selectedLineId];
      refs.mapTitle.textContent = l.name;
      refs.mapSubtitle.textContent = l.stations[0].name + ' ↔ ' + l.stations[l.stations.length - 1].name + ' · ' + l.stations.length + ' 站 · 间隔约 ' + l.headway + ' 分';
    } else if (state.mapMode === 'live' && state.liveStation) {
      refs.mapTitle.textContent = state.liveStation + ' · 实时到站';
      refs.mapSubtitle.textContent = '模拟运行图 · 每秒刷新 · 点击其他车站切换';
    } else {
      refs.mapTitle.textContent = '西安轨道交通线网';
      refs.mapSubtitle.textContent = LINES.length + ' 条线路 · ' + model.stationMap.size + ' 座车站 · 点击线路进入详情';
    }
  }

  function updateRibbon() {
    refs.allLinesBtn.classList.toggle('is-active', state.mapMode === 'all' || state.mapMode === 'live');
    var nearbyIds = state.nearest ? state.nearest.lines.map(function (l) { return l.id; }) : [];
    $all('.ribbon-line', refs.lineRibbon).forEach(function (btn) {
      var id = btn.getAttribute('data-line');
      var active = false;
      if (state.mapMode === 'line' && state.selectedLineId === id) active = true;
      if (state.mapMode === 'route' && state.route && state.route.lineIds.indexOf(id) !== -1) active = true;
      if (state.mapMode === 'nearby' && nearbyIds.indexOf(id) !== -1) active = true;
      btn.classList.toggle('is-active', active);
    });
  }

  /* ------------------------------------------------------------------ */
  /* interactions                                                       */
  /* ------------------------------------------------------------------ */
  function activateTab(tab, opts) {
    opts = opts || {};
    if (state.userLocation && refs.nearbyCard && !refs.nearbyCard.hidden) refs.nearbyCard.hidden = true;
    state.tab = tab;
    $all('.tab').forEach(function (btn) {
      var on = btn.getAttribute('data-tab') === tab;
      btn.classList.toggle('is-active', on);
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    $all('.panel-view').forEach(function (view) {
      var on = view.id === 'view-' + tab;
      view.classList.toggle('is-active', on);
      view.hidden = !on;
    });
    if (tab === 'explore') renderExplore();
    if (tab === 'live') renderLive();
    if (tab === 'route') renderRouteResult();
    if (opts.expand) setSheetCollapsed(false);
    if (!opts.keepMap) {
      if (tab === 'route' && state.route) applyMapMode('route', true);
      else if (tab === 'explore' && state.selectedLineId) applyMapMode('line', true);
      else if (tab === 'live' && state.liveStation) {
        state.mapMode = 'live';
        applyMapMode('live', true);
      } else {
        state.mapMode = 'all';
        applyMapMode('all', true);
      }
    }
    if (!opts.keepScroll) refs.panelScroll.scrollTop = 0;
  }

  function setSheetCollapsed(collapsed, skipFit) {
    var changed = state.sheetCollapsed !== collapsed;
    state.sheetCollapsed = collapsed;
    refs.sidePanel.classList.toggle('is-collapsed', collapsed);
    refs.lineRibbonWrap.classList.toggle('is-collapsed', collapsed);
    refs.sheetToggle.setAttribute('aria-label', collapsed ? '展开面板' : '收起面板');
    if (!changed || skipFit) return;
    setTimeout(function () {
      if (state.mapMode === 'all' || state.mapMode === 'line' || state.mapMode === 'route' || state.mapMode === 'live') {
        fitForMode(true);
      }
    }, 300);
  }

  function showAllMap() {
    state.mapMode = 'all';
    state.selectedLineId = null;
    state.focusStation = null;
    state.exploreHistory = [];
    if (refs.nearbyCard) refs.nearbyCard.hidden = true;
    if (state.tab === 'explore') renderExplore();
    applyMapMode('all', true);
  }

  function openHelp() {
    refs.helpModal.hidden = false;
    var btn = refs.helpModal.querySelector('[data-close-modal]');
    if (btn) btn.focus();
  }
  function closeHelp() { refs.helpModal.hidden = true; refs.helpBtn.focus(); }

  /* ------------------------------------------------------------------ */
  /* init                                                               */
  /* ------------------------------------------------------------------ */
  function cacheRefs() {
    refs = {
      topClock: $('#topClock'),
      sidePanel: $('#sidePanel'),
      panelScroll: $('#panelScroll'),
      lineRibbonWrap: $('#lineRibbonWrap'),
      lineRibbon: $('#lineRibbon'),
      allLinesBtn: $('#allLinesBtn'),
      sheetToggle: $('#sheetToggle'),
      tabs: $('#tabs'),
      syncBtn: $('#syncBtn'),
      statLines: $('#statLines'),
      statStations: $('#statStations'),
      mapMeta: $('#mapMeta'),
      dataNoteDate: $('#dataNoteDate'),
      viewRoute: $('#view-route'),
      viewExplore: $('#view-explore'),
      viewLive: $('#view-live'),
      fromInput: $('#fromInput'),
      toInput: $('#toInput'),
      routeForm: $('#routeForm'),
      swapBtn: $('#swapBtn'),
      stationSuggest: $('#stationSuggest'),
      routeFeedback: $('#routeFeedback'),
      routeResult: $('#routeResult'),
      routeWelcome: $('#routeWelcome'),
      planBtn: $('#planBtn'),
      lineGrid: $('#lineGrid'),
      lineDetail: $('#lineDetail'),
      liveSearch: $('#liveSearch'),
      liveSuggest: $('#liveSuggest'),
      liveContent: $('#liveContent'),
      mapShell: $('#mapShell'),
      mapCanvas: $('#mapCanvas'),
      svg: $('#metroSvg'),
      mapRoot: $('#mapRoot'),
      contextLayer: $('#contextLayer'),
      lineLayer: $('#lineLayer'),
      routeLayer: $('#routeLayer'),
      userLayer: $('#userLayer'),
      stationLayer: $('#stationLayer'),
      labelLayer: $('#labelLayer'),
      markerLayer: $('#markerLayer'),
      nearbyCard: $('#nearbyCard'),
      locateBtn: $('#locateBtn'),
      mapTitle: $('#mapTitle'),
      mapSubtitle: $('#mapSubtitle'),
      mapTooltip: $('#mapTooltip'),
      mapToast: $('#mapToast'),
      labelBtn: $('#labelBtn'),
      fitBtn: $('#fitBtn'),
      zoomIn: $('#zoomIn'),
      zoomOut: $('#zoomOut'),
      helpBtn: $('#helpBtn'),
      helpModal: $('#helpModal')
    };
    refs.mapToast = document.createElement('div');
    refs.mapToast.className = 'map-toast';
    refs.mapToast.hidden = true;
    refs.mapCanvas.appendChild(refs.mapToast);
  }

  function buildLineRibbon() {
    refs.lineRibbon.innerHTML = LINES.map(function (l) {
      return '<button class="ribbon-line" type="button" data-line="' + l.id + '" style="--c:' + l.color + ';--tc:' + contrastText(l.color) + '"><span class="rdot"></span>' + esc(l.short) + '</button>';
    }).join('');
  }

  function bindStaticEvents() {
    refs.tabs.addEventListener('click', function (e) {
      var btn = e.target.closest('.tab');
      if (!btn) return;
      activateTab(btn.getAttribute('data-tab'), { expand: true });
    });

    refs.routeForm.addEventListener('submit', function (e) {
      e.preventDefault();
      planRoute(refs.fromInput.value, refs.toInput.value);
    });

    refs.fromInput.addEventListener('focus', function () { openSuggest('from'); });
    refs.toInput.addEventListener('focus', function () { openSuggest('to'); });
    refs.fromInput.addEventListener('input', function () {
      updateInputClearButtons();
      if (suggestState.field !== 'from') openSuggest('from');
      else openSuggest('from');
    });
    refs.toInput.addEventListener('input', function () {
      updateInputClearButtons();
      if (suggestState.field !== 'to') openSuggest('to');
      else openSuggest('to');
    });
    [refs.fromInput, refs.toInput].forEach(function (input) {
      input.addEventListener('keydown', function (e) {
        if (refs.stationSuggest.hidden) return;
        var items = $all('.suggest-item', refs.stationSuggest);
        if (!items.length) return;
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          suggestState.index = (suggestState.index + 1) % items.length;
          items.forEach(function (el, i) { el.classList.toggle('is-active', i === suggestState.index); });
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          suggestState.index = (suggestState.index - 1 + items.length) % items.length;
          items.forEach(function (el, i) { el.classList.toggle('is-active', i === suggestState.index); });
        } else if (e.key === 'Enter') {
          if (suggestState.index >= 0) {
            e.preventDefault();
            var name = items[suggestState.index].getAttribute('data-suggest-station');
            pickStation(suggestState.field, name);
          }
        } else if (e.key === 'Escape') {
          closeSuggest();
        }
      });
    });

    $all('.od-clear').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var field = btn.getAttribute('data-clear');
        if (field === 'from') refs.fromInput.value = '';
        else refs.toInput.value = '';
        updateInputClearButtons();
        if (field === 'from') refs.fromInput.focus();
        else refs.toInput.focus();
        openSuggest(field);
      });
    });

    refs.swapBtn.addEventListener('click', function () {
      var a = refs.fromInput.value;
      refs.fromInput.value = refs.toInput.value;
      refs.toInput.value = a;
      updateInputClearButtons();
      if (resolveStation(refs.fromInput.value) && resolveStation(refs.toInput.value)) {
        planRoute(refs.fromInput.value, refs.toInput.value);
      }
    });

    refs.routeWelcome.addEventListener('click', function (e) {
      var btn = e.target.closest('.example-route');
      if (!btn) return;
      var from = btn.getAttribute('data-from');
      var to = btn.getAttribute('data-to');
      refs.fromInput.value = from;
      refs.toInput.value = to;
      updateInputClearButtons();
      planRoute(from, to);
    });

    refs.lineGrid.addEventListener('click', function (e) {
      var card = e.target.closest('[data-card-line]');
      if (!card) return;
      selectLine(card.getAttribute('data-card-line'));
    });

    refs.lineDetail.addEventListener('click', function (e) {
      var live = e.target.closest('[data-live-station]');
      if (live) {
        e.stopPropagation();
        openLive(live.getAttribute('data-live-station'), live.getAttribute('data-live-line'));
        return;
      }
      var sw = e.target.closest('[data-switch-line]');
      if (sw) {
        e.stopPropagation();
        var swRow = sw.closest('.station-row');
        var swStation = sw.getAttribute('data-station') || (swRow && swRow.getAttribute('data-station')) || state.focusStation;
        if (swStation) switchLineAtStation(swStation, sw.getAttribute('data-switch-line'));
        return;
      }
      if (e.target.closest('#lineBackBtn')) { goBackLine(); return; }
      if (e.target.closest('#lineAllBtn')) { showAllMap(); return; }
      if (e.target.closest('#lineLiveBtn')) {
        var line = LINE_BY_ID[state.selectedLineId];
        var target = state.focusStation || (line ? line.stations[0].name : null);
        if (target) openLive(target, state.selectedLineId);
        return;
      }
      var row = e.target.closest('.station-row');
      if (row) {
        var others = stationLines(row.getAttribute('data-station')).filter(function (l) { return l.id !== state.selectedLineId; });
        if (others.length) toggleTransferChoice(row);
        else openLive(row.getAttribute('data-station'), state.selectedLineId);
      }
    });
    refs.lineDetail.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      if (e.target.closest('button')) return;
      var row = e.target.closest('.station-row');
      if (!row) return;
      e.preventDefault();
      var others = stationLines(row.getAttribute('data-station')).filter(function (l) { return l.id !== state.selectedLineId; });
      if (others.length) toggleTransferChoice(row);
      else openLive(row.getAttribute('data-station'), state.selectedLineId);
    });

    refs.liveSearch.addEventListener('focus', openLiveSuggest);
    refs.liveSearch.addEventListener('input', openLiveSuggest);
    refs.liveSearch.addEventListener('keydown', function (e) {
      if (refs.liveSuggest.hidden) return;
      var items = $all('.suggest-item', refs.liveSuggest);
      if (!items.length) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        liveSuggestState.index = (liveSuggestState.index + 1) % items.length;
        items.forEach(function (el, i) { el.classList.toggle('is-active', i === liveSuggestState.index); });
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        liveSuggestState.index = (liveSuggestState.index - 1 + items.length) % items.length;
        items.forEach(function (el, i) { el.classList.toggle('is-active', i === liveSuggestState.index); });
      } else if (e.key === 'Enter' && liveSuggestState.index >= 0) {
        e.preventDefault();
        var name = items[liveSuggestState.index].getAttribute('data-suggest-station');
        refs.liveSearch.value = name;
        hideLiveSuggest();
        openLive(name);
      } else if (e.key === 'Escape') {
        hideLiveSuggest();
      }
    });

    refs.liveContent.addEventListener('click', function (e) {
      var lineBtn = e.target.closest('[data-live-line]');
      if (lineBtn) {
        var id = lineBtn.getAttribute('data-live-line');
        if (model.lineMap[id]) {
          state.liveLineId = id;
          renderLiveContent();
        }
        return;
      }
      var st = e.target.closest('[data-live-station]');
      if (st) {
        openLive(st.getAttribute('data-live-station'), st.getAttribute('data-live-line'));
      }
    });

    refs.lineRibbon.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-line]');
      if (!btn) return;
      selectLine(btn.getAttribute('data-line'));
    });
    refs.allLinesBtn.addEventListener('click', function () {
      showAllMap();
    });

    refs.sheetToggle.addEventListener('click', function () {
      setSheetCollapsed(!state.sheetCollapsed);
    });
    $('#sheetBar').addEventListener('click', function (e) {
      if (e.target.closest('.sheet-toggle')) return;
      setSheetCollapsed(!state.sheetCollapsed);
    });

    refs.labelBtn.addEventListener('click', function () {
      state.labelAll = !state.labelAll;
      refs.labelBtn.classList.toggle('is-active', state.labelAll);
      refs.labelBtn.setAttribute('aria-pressed', state.labelAll ? 'true' : 'false');
      renderLabels();
    });
    refs.locateBtn.addEventListener('click', function () {
      if (state.userLocation && state.nearest && !state.locating) {
        renderNearbyCard();
        if (state.mapMode !== 'nearby') {
          state.mapMode = 'nearby';
          applyMapMode('nearby', false);
        } else {
          renderMarkers();
        }
        fitNearbyView(true);
      } else {
        requestLocation();
      }
    });
    refs.nearbyCard.addEventListener('click', function (e) {
      if (e.target.closest('[data-nearby-close]')) { clearLocation(); return; }
      if (e.target.closest('[data-nearby-retry]')) { requestLocation(); return; }
      var alt = e.target.closest('[data-nearby-alt]');
      if (alt) { selectNearby(alt.getAttribute('data-nearby-alt')); return; }
      var action = e.target.closest('[data-nearby-action]');
      if (!action) return;
      if (action.getAttribute('data-nearby-action') === 'origin') useNearbyAsOrigin();
      if (action.getAttribute('data-nearby-action') === 'live') {
        var nearest = state.nearest;
        if (nearest) openLive(nearest.name, nearest.lines[0] ? nearest.lines[0].id : null);
      }
    });
    refs.fitBtn.addEventListener('click', function () { fitForMode(); });
    refs.zoomIn.addEventListener('click', function () { zoomAt(state.map.W / 2, state.map.H / 2, 1.3); });
    refs.zoomOut.addEventListener('click', function () { zoomAt(state.map.W / 2, state.map.H / 2, 1 / 1.3); });
    refs.syncBtn.addEventListener('click', syncNetwork);

    refs.helpBtn.addEventListener('click', openHelp);
    refs.helpModal.addEventListener('click', function (e) {
      if (e.target.closest('[data-close-modal]')) closeHelp();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        if (!refs.helpModal.hidden) closeHelp();
        closeSuggest();
        hideLiveSuggest();
      }
    });
    document.addEventListener('click', function (e) {
      if (!e.target.closest('.od-card') && !e.target.closest('#fromInput') && !e.target.closest('#toInput')) closeSuggest();
      if (!e.target.closest('.live-search-wrap')) hideLiveSuggest();
    });

    bindMapEvents();
  }

  function bindMapEvents() {
    refs.svg.addEventListener('wheel', function (e) {
      e.preventDefault();
      cancelViewAnimation();
      var rect = refs.svg.getBoundingClientRect();
      var x = e.clientX - rect.left;
      var y = e.clientY - rect.top;
      var factor = Math.exp(-e.deltaY * 0.0014);
      zoomAt(x, y, factor);
    }, { passive: false });

    refs.svg.addEventListener('dblclick', function (e) {
      /* station / line double activation is handled from click timing below,
         so never zoom when a double click lands on a map object */
      if (e.target.closest('.line-group') || e.target.closest('.station-group')) {
        e.preventDefault();
        return;
      }
      cancelViewAnimation();
      var rect = refs.svg.getBoundingClientRect();
      zoomAt(e.clientX - rect.left, e.clientY - rect.top, 1.55);
    });

    refs.svg.addEventListener('click', function (e) {
      if (performance.now() < state.suppressClickUntil) return;
      var unit = e.target.closest('[data-station]');
      if (unit) {
        openLive(unit.getAttribute('data-station'));
        return;
      }
      unit = e.target.closest('[data-line]');
      if (unit) {
        selectLine(unit.getAttribute('data-line'));
      }
    });

    refs.svg.addEventListener('pointerover', function (e) {
      if (state.dragging) return;
      var station = e.target.closest('.station-group');
      if (station) {
        var name = station.getAttribute('data-station');
        refs.mapTooltip.innerHTML = esc(name) + '<small>' + stationSubLabel(name) + '</small>';
        refs.mapTooltip.hidden = false;
        moveTooltip(e);
        return;
      }
      var line = e.target.closest('.line-group');
      if (line) {
        var lid = line.getAttribute('data-line');
        refs.mapTooltip.innerHTML = esc(lineName(lid)) + '<small>' + esc(LINE_BY_ID[lid].stations[0].name + ' ↔ ' + LINE_BY_ID[lid].stations[LINE_BY_ID[lid].stations.length - 1].name) + ' · 点击进入</small>';
        refs.mapTooltip.hidden = false;
        moveTooltip(e);
        return;
      }
      refs.mapTooltip.hidden = true;
    });
    refs.svg.addEventListener('pointermove', function (e) {
      if (!refs.mapTooltip.hidden) moveTooltip(e);
    });
    refs.svg.addEventListener('pointerleave', function () { refs.mapTooltip.hidden = true; });

    var pointers = new Map();
    var panStart = null;
    var pinchStart = null;
    var moved = 0;

    refs.svg.addEventListener('pointerdown', function (e) {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      cancelViewAnimation();
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      refs.svg.setPointerCapture(e.pointerId);
      state.dragging = true;
      refs.svg.classList.add('is-dragging');
      if (pointers.size === 1) {
        panStart = { x: e.clientX, y: e.clientY, tx: state.map.tx, ty: state.map.ty };
        moved = 0;
      } else if (pointers.size === 2) {
        var arr = Array.from(pointers.values());
        var dx = arr[0].x - arr[1].x;
        var dy = arr[0].y - arr[1].y;
        pinchStart = {
          dist: Math.hypot(dx, dy),
          midX: (arr[0].x + arr[1].x) / 2,
          midY: (arr[0].y + arr[1].y) / 2,
          scale: state.map.scale,
          tx: state.map.tx,
          ty: state.map.ty
        };
        panStart = null;
      }
    });

    refs.svg.addEventListener('pointermove', function (e) {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2 && pinchStart) {
        var arr = Array.from(pointers.values());
        var dx = arr[0].x - arr[1].x;
        var dy = arr[0].y - arr[1].y;
        var dist = Math.hypot(dx, dy);
        var rect = refs.svg.getBoundingClientRect();
        var midX = (arr[0].x + arr[1].x) / 2 - rect.left;
        var midY = (arr[0].y + arr[1].y) / 2 - rect.top;
        var startMidX = pinchStart.midX - rect.left;
        var startMidY = pinchStart.midY - rect.top;
        var nextScale = clamp(pinchStart.scale * (dist / Math.max(1, pinchStart.dist)), 0.6, 4.5);
        var contentX = (startMidX - pinchStart.tx) / pinchStart.scale;
        var contentY = (startMidY - pinchStart.ty) / pinchStart.scale;
        state.map.scale = nextScale;
        state.map.tx = midX - contentX * nextScale;
        state.map.ty = midY - contentY * nextScale;
        clampView();
        applyView();
        scheduleLabels();
        moved = 10;
        return;
      }
      if (panStart && pointers.size === 1) {
        var ddx = e.clientX - panStart.x;
        var ddy = e.clientY - panStart.y;
        if (Math.abs(ddx) + Math.abs(ddy) > 4) moved = Math.max(moved, Math.abs(ddx) + Math.abs(ddy));
        state.map.tx = panStart.tx + ddx;
        state.map.ty = panStart.ty + ddy;
        clampView();
        applyView();
      }
    });

    function endPointer(e) {
      pointers.delete(e.pointerId);
      if (pointers.size === 0) {
        state.dragging = false;
        refs.svg.classList.remove('is-dragging');
        if (moved > 6) state.suppressClickUntil = performance.now() + 350;
        panStart = null;
        pinchStart = null;
        moved = 0;
        scheduleLabels();
      } else if (pointers.size === 1) {
        pinchStart = null;
        var rest = Array.from(pointers.values())[0];
        panStart = { x: rest.x, y: rest.y, tx: state.map.tx, ty: state.map.ty };
      }
    }
    refs.svg.addEventListener('pointerup', endPointer);
    refs.svg.addEventListener('pointercancel', endPointer);
  }

  function moveTooltip(e) {
    var rect = refs.mapCanvas.getBoundingClientRect();
    refs.mapTooltip.style.left = (e.clientX - rect.left) + 'px';
    refs.mapTooltip.style.top = (e.clientY - rect.top) + 'px';
  }

  function handleResize() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      var prev = state.animateMap;
      state.animateMap = false;
      cancelViewAnimation();
      setupProjection();
      renderMapStatic();
      state.animateMap = prev;
    }, 150);
  }

  function init() {
    cacheRefs();
    buildLineRibbon();
    updateNetworkMeta();
    bindStaticEvents();
    state.animateMap = false;
    setupProjection();
    renderMapStatic();
    state.animateMap = true;
    tickClock();
    setInterval(tickClock, 1000);
    if (window.ResizeObserver) {
      var ro = new ResizeObserver(function () { handleResize(); });
      ro.observe(refs.mapCanvas);
    } else {
      window.addEventListener('resize', handleResize);
    }
    window.addEventListener('resize', handleResize);

    refs.fromInput.value = '北大街';
    refs.toInput.value = '大雁塔';
    updateInputClearButtons();
    planRoute('北大街', '大雁塔', { initial: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
