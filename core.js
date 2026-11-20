/* 吃药打卡 · 核心逻辑(纯函数,无界面依赖;浏览器和 node 测试共用) */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Core = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var pad = function (n) { return String(n).padStart(2, '0'); };
  var dstr = function (d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
  var dparse = function (s) { var p = s.split('-').map(Number); return new Date(p[0], p[1] - 1, p[2]); };
  var addDays = function (s, n) { var d = dparse(s); d.setDate(d.getDate() + n); return dstr(d); };
  var diffDays = function (a, b) {
    var x = dparse(a), y = dparse(b);
    return Math.round((Date.UTC(x.getFullYear(), x.getMonth(), x.getDate()) - Date.UTC(y.getFullYear(), y.getMonth(), y.getDate())) / 864e5);
  };
  var atTime = function (day, hm) {
    var p = hm.split(':').map(Number), d = dparse(day);
    d.setHours(p[0], p[1], 0, 0);
    return d.getTime();
  };
  var mdText = function (day) { var d = dparse(day); return (d.getMonth() + 1) + '月' + d.getDate() + '日'; };

  function defaults(today) {
    return {
      v: 1,
      setup: false,
      cfgAt: 0,      // 参数(设置+药品名/粒数/周期)最后一次修改的时间(毫秒),手机和管理端按它谁新听谁的
      applied: [],   // 已经处理过的管理端指令 id
      first: today,
      settings: {
        hint: '早饭后',
        alarmMode: true,
        snoozeMin: 10,
        remindTime: '08:00',
        followMin: 15,
        followMax: 3,
        eveRemind: true,
        eveTime: '20:00',
        refillDays: 4,
        refillTime: '09:00',
        onDays: 21,
        offDays: 7,
        cycleStarts: ['2026-11-03']
      },
      drugs: [
        { id: 'letrozole', name: '来曲唑', qty: 1, cyclic: false, stock: null, color: '#9AD3FF' },
        { id: 'ribociclib', name: '瑞波西利', qty: 2, cyclic: true, stock: null, color: '#FFD9A8' }
      ],
      logs: {}
    };
  }

  function normalize(s, today) {
    var d = defaults(today);
    if (!s || typeof s !== 'object') return d;
    var out = Object.assign({}, d, s);
    out.settings = Object.assign({}, d.settings, s.settings || {});
    out.drugs = (Array.isArray(s.drugs) && s.drugs.length) ? s.drugs : d.drugs;
    out.logs = s.logs || {};
    out.first = s.first || today;
    return out;
  }

  /* ───── 周期 ───── */
  // 某天处于用药期还是停药期。第一个起始日之前视为“周期未开始”(不吃周期药)。
  function phase(S, day) {
    var starts = S.settings.cycleStarts.slice().sort();
    var prior = starts.filter(function (x) { return x <= day; });
    if (!prior.length) return { on: false, cycleDay: null, before: true };
    var s = prior[prior.length - 1];
    var total = S.settings.onDays + S.settings.offDays;
    var diff = diffDays(day, s);
    var j = Math.floor(diff / total);
    var later = starts.filter(function (x) { return x > day; });
    if (later.length) {
      // 后面记录了新的起始日:这个周期不再自动重复,用药期过后一直停药到新起始日(医生推迟恢复)
      var n = Math.floor(diffDays(later[0], s) / total);
      j = Math.min(j, Math.max(n - 1, 0));
    }
    var k = diff - j * total;
    return { on: k < S.settings.onDays, cycleDay: k + 1, before: false };
  }

  // day 与 day+1 之间的切换:'off' = 明天开始停药,'on' = 明天开始(恢复)用药
  function transition(S, day) {
    var a = phase(S, day), b = phase(S, addDays(day, 1));
    if (a.on && !b.on) return 'off';
    if (!a.on && b.on) return 'on';
    return null;
  }

  function nextEvents(S, today) {
    var offStart = null, onStart = null;
    for (var i = 0; i < 400 && !(offStart && onStart); i++) {
      var d = addDays(today, i), t = transition(S, d);
      if (t === 'off' && !offStart) offStart = addDays(d, 1);
      if (t === 'on' && !onStart) onStart = addDays(d, 1);
    }
    return { offStart: offStart, onStart: onStart };
  }

  function nextOnAfter(S, from) {
    for (var i = 0; i < 120; i++) { var d = addDays(from, i); if (phase(S, d).on) return d; }
    return null;
  }

  /* ───── 今日服药 / 打卡 ───── */
  function isDue(S, drug, day) { return !drug.cyclic || phase(S, day).on; }
  function dueDrugs(S, day) { return S.drugs.filter(function (d) { return isDue(S, d, day); }); }
  function isTaken(S, day) {
    var due = dueDrugs(S, day), lg = S.logs[day] || {};
    return due.length > 0 && due.every(function (d) { return lg[d.id]; });
  }

  function checkin(S, day, ts) {
    var lg = (S.logs[day] = S.logs[day] || {});
    dueDrugs(S, day).forEach(function (d) {
      if (lg[d.id]) return;
      var ded = 0;
      if (d.stock != null) { ded = Math.min(d.stock, d.qty); d.stock -= ded; }
      lg[d.id] = { qty: d.qty, ded: ded, ts: ts };
    });
  }

  function undo(S, day) {
    var lg = S.logs[day];
    if (!lg) return;
    S.drugs.forEach(function (d) { if (lg[d.id] && d.stock != null) d.stock += (lg[d.id].ded || 0); });
    delete S.logs[day];
  }

  /* ───── 与管理端同步 ───── */
  var clone = function (o) { return JSON.parse(JSON.stringify(o)); };

  // 参数部分:设置 + 每种药的名字/每次几粒/是否周期药(不含药量,药量以手机为准)
  function cfgOf(S) {
    return { settings: clone(S.settings), drugs: S.drugs.map(function (d) { return { id: d.id, name: d.name, qty: d.qty, cyclic: !!d.cyclic, color: d.color }; }) };
  }

  function applyCfg(S, cfg, at) {
    if (!cfg) return;
    if (cfg.settings) S.settings = Object.assign({}, S.settings, clone(cfg.settings));
    (cfg.drugs || []).forEach(function (c) {
      var d = S.drugs.filter(function (x) { return x.id === c.id; })[0];
      if (!d) return;
      d.name = c.name; d.qty = c.qty; d.cyclic = !!c.cyclic;
      if (c.color) d.color = c.color;
    });
    S.cfgAt = at || S.cfgAt;
  }

  // 管理端发来的指令:setStock / addStock / setLog,每条只执行一次(按 id 记账)。
  // 返回 { changed, days:[{day,taken}] },days 是被改过打卡的日子,调用方据此同步“今天已吃”标记。
  function applyOps(S, ops, nowText) {
    var done = {}, res = { changed: false, days: [] };
    (S.applied = S.applied || []).forEach(function (id) { done[id] = 1; });
    (ops || []).slice().sort(function (a, b) { return (a.t || 0) - (b.t || 0); }).forEach(function (op) {
      if (!op || !op.id || done[op.id]) return;
      var d = S.drugs.filter(function (x) { return x.id === op.drug; })[0];
      if (op.type === 'setStock' && d) { d.stock = op.value == null ? null : Math.max(0, Math.floor(op.value)); }
      else if (op.type === 'addStock' && d) { d.stock = (d.stock || 0) + Math.floor(op.n || 0); }
      else if (op.type === 'setLog' && op.day) {
        if (op.taken && !isTaken(S, op.day)) { checkin(S, op.day, nowText || '后台补记'); res.days.push({ day: op.day, taken: true }); }
        else if (!op.taken && S.logs[op.day]) { undo(S, op.day); res.days.push({ day: op.day, taken: false }); }
      }
      S.applied.push(op.id); done[op.id] = 1; res.changed = true;
    });
    if (S.applied.length > 300) S.applied = S.applied.slice(-300);
    return res;
  }

  /* ───── 药量预测 ───── */
  // 从 fromDay 起,按现有片数能吃几个用药日,哪天第一次吃不上
  function leftFrom(S, drug, fromDay, stock) {
    var day = fromDay, n = 0;
    for (var i = 0; i < 800; i++) {
      if (isDue(S, drug, day)) {
        if (stock < drug.qty) return { runOut: day, doseDays: n };
        stock -= drug.qty; n++;
      }
      day = addDays(day, 1);
    }
    return { runOut: null, doseDays: n };
  }

  function drugStatuses(S, today) {
    var taken = isTaken(S, today);
    return S.drugs.map(function (d) {
      var base = { id: d.id, name: d.name, color: d.color, qty: d.qty, cyclic: !!d.cyclic, stock: d.stock, tracked: d.stock != null, dueToday: isDue(S, d, today) };
      if (d.stock == null) return Object.assign(base, { doseDays: null, runOut: null, low: false });
      var from = (taken || !base.dueToday) && taken ? addDays(today, 1) : today;
      var left = leftFrom(S, d, from, d.stock);
      return Object.assign(base, { doseDays: left.doseDays, runOut: left.runOut, low: left.doseDays <= S.settings.refillDays });
    });
  }

  // 未来 horizon 天里,哪些天处于“药快不够了”状态(假设按时吃药)
  function lowDays(S, today, horizon) {
    var out = {}, takenToday = isTaken(S, today);
    S.drugs.forEach(function (drug) {
      if (drug.stock == null) return;
      var stock = drug.stock;
      for (var i = 0; i <= horizon; i++) {
        var d = addDays(today, i), skipToday = (i === 0 && takenToday);
        var left = leftFrom(S, drug, skipToday ? addDays(today, 1) : d, stock);
        if (left.doseDays <= S.settings.refillDays) (out[d] = out[d] || []).push({ drug: drug, left: left, stock: stock });
        if (!skipToday && isDue(S, drug, d)) stock = Math.max(0, stock - drug.qty);
      }
    });
    return out;
  }

  function firstLowDay(S, today) {
    var low = lowDays(S, today, 60), keys = Object.keys(low).sort();
    return keys.length ? keys[0] : null;
  }

  /* ───── 文案 ───── */
  function doseList(ds) { return ds.map(function (x) { return x.name + ' ' + x.qty + ' 粒'; }).join('、'); }

  function remindText(S, day) {
    var due = dueDrugs(S, day), idle = S.drugs.filter(function (d) { return due.indexOf(d) < 0; });
    var t = (S.settings.hint || '现在') + '吃:' + doseList(due) + '。';
    if (idle.length) t += '\n(今天' + idle.map(function (d) { return d.name; }).join('、') + '不用吃)';
    return t;
  }

  function cycNames(S) { var n = S.drugs.filter(function (d) { return d.cyclic; }).map(function (d) { return d.name; }); return n.join('、') || '周期药'; }
  function otherNames(S) { return S.drugs.filter(function (d) { return !d.cyclic; }).map(function (d) { return d.name; }).join('、'); }

  /* ───── 视图数据 ───── */
  function weekView(S, today) {
    var out = [];
    for (var i = 0; i < 7; i++) {
      var d = addDays(today, i), ph = phase(S, d);
      out.push({ day: d, i: i, on: ph.on, before: ph.before, cycleDay: ph.cycleDay, due: dueDrugs(S, d), taken: i === 0 ? isTaken(S, d) : null });
    }
    return out;
  }

  function monthView(S, ym, today) {
    var p = ym.split('-').map(Number), y = p[0], m = p[1];
    var first = ym + '-01', n = new Date(y, m, 0).getDate();
    var offset = (dparse(first).getDay() + 6) % 7; // 周一开头
    var refillDay = firstLowDay(S, today);
    var cells = [];
    for (var i = 1; i <= n; i++) {
      var day = ym + '-' + pad(i), ph = phase(S, day), due = dueDrugs(S, day), chips = [];
      var t = transition(S, day);
      if (t === 'off') chips.push({ k: 'off', t: '明天停药' });
      if (t === 'on') chips.push({ k: 'on', t: '明天吃药' });
      if (refillDay && day === refillDay) chips.push({ k: 'refill', t: '去开药' });
      var mark = null;
      if (day >= S.first && due.length) {
        if (day < today) mark = isTaken(S, day) ? 'yes' : 'miss';
        else if (day === today && isTaken(S, day)) mark = 'yes';
      }
      cells.push({ day: day, on: ph.on, before: ph.before, cycleDay: ph.cycleDay, due: due, chips: chips, mark: mark });
    }
    return { offset: offset, cells: cells };
  }

  /* ───── 提醒计划:交给安卓原生去排闹钟 ───── */
  function buildPlan(S, now, horizon) {
    horizon = horizon || 30;
    var st = S.settings, today = dstr(new Date(now)), alarms = [];
    var low = lowDays(S, today, horizon);
    for (var i = 0; i <= horizon; i++) {
      var d = addDays(today, i), at;

      var due = dueDrugs(S, d);
      if (due.length && !(i === 0 && isTaken(S, d))) {
        at = atTime(d, st.remindTime);
        if (at > now) alarms.push({ id: 'remind:' + d, kind: 'remind', day: d, at: at, title: '💊 该吃药了', text: remindText(S, d) });
      }

      if (st.eveRemind) {
        var tr = transition(S, d);
        if (tr) {
          at = atTime(d, st.eveTime);
          if (at > now) {
            var title, text, cyc = cycNames(S), oth = otherNames(S);
            if (tr === 'off') {
              var back = nextOnAfter(S, addDays(d, 1));
              title = '📅 明天开始停药';
              text = '明天起' + cyc + '停药' + (back ? '(' + mdText(back) + '恢复)' : '') + (oth ? ',期间只吃' + oth + '。' : '。');
            } else {
              title = '📅 明天恢复用药';
              text = '明天恢复吃' + doseList(S.drugs.filter(function (x) { return x.cyclic; })) + '。';
            }
            alarms.push({ id: 'eve:' + d, kind: 'eve', day: d, at: at, title: title, text: text });
          }
        }
      }

      if (low[d]) {
        at = atTime(d, st.refillTime);
        if (at > now) {
          var lines = low[d].map(function (x) {
            if (x.left.doseDays === 0) return x.drug.name + '已经不够吃了';
            return x.drug.name + '还剩' + x.stock + '粒' + (x.left.runOut ? '，约' + mdText(x.left.runOut) + '用完' : '');
          });
          alarms.push({ id: 'refill:' + d, kind: 'refill', day: d, at: at, title: '💊 药快吃完，该去开药啦', text: lines.join('\n') + '\n请提前挂号。' });
        }
      }
    }
    return { followMin: st.followMin, followMax: st.followMax, alarmMode: st.alarmMode !== false, snoozeMin: st.snoozeMin || 10, alarms: alarms };
  }

  return {
    pad: pad, dstr: dstr, dparse: dparse, addDays: addDays, diffDays: diffDays, atTime: atTime, mdText: mdText,
    defaults: defaults, normalize: normalize, phase: phase, transition: transition, nextEvents: nextEvents, nextOnAfter: nextOnAfter,
    cfgOf: cfgOf, applyCfg: applyCfg, applyOps: applyOps,
    isDue: isDue, dueDrugs: dueDrugs, isTaken: isTaken, checkin: checkin, undo: undo,
    leftFrom: leftFrom, drugStatuses: drugStatuses, lowDays: lowDays, firstLowDay: firstLowDay,
    doseList: doseList, remindText: remindText, cycNames: cycNames, otherNames: otherNames,
    weekView: weekView, monthView: monthView, buildPlan: buildPlan
  };
});
