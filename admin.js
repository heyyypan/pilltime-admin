/* 家人用药 · 管理端(网页)。数据只通过 Gitee 私有仓库里的两个文件和手机交换:
   client.json 手机写、这里读;admin.json 这里写、手机读。 */
(function () {
  'use strict';
  var C = window.Core, VER = '1.0';
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  var WD = '日一二三四五六';
  var today = function () { return C.dstr(new Date()); };

  /* ───── 连接信息(只存在这台设备的浏览器里) ───── */
  var DEF_API = 'https://gitee.com/api/v5';
  var conn = null;
  try { conn = JSON.parse(localStorage.getItem('pa_conn') || 'null'); } catch (e) {}
  var client = null, adminDoc = null, S = null, loadedAt = 0, err = '', busy = !!conn, booting = !!conn, dirty = false, formStarts = [], timer = null;

  /* ───── Gitee 接口 ───── */
  function b64e(s) { return btoa(unescape(encodeURIComponent(s))); }
  function b64d(s) { s = String(s == null ? '' : s).replace(/\s/g, ''); return s ? decodeURIComponent(escape(atob(s))) : ''; }
  function url(path) { return (conn.api || DEF_API).replace(/\/$/, '') + '/repos/' + conn.repo + '/contents/' + path; }
  function httpErr(r, body) { var e = new Error('HTTP ' + r.status); e.status = r.status; e.body = body; return e; }
  function describe(e) {
    if (e && e.status === 401) return '令牌不对或已过期(401)。到 Gitee「设置 → 私人令牌」重新生成,并勾选 projects。';
    if (e && e.status === 403) return '没有权限(403)。令牌需要勾选 projects 权限。';
    if (e && e.status === 404) return '找不到这个仓库(404)。检查「用户名/仓库名」,仓库要存在,令牌要属于仓库的主人或协作者。';
    if (e instanceof TypeError) return '浏览器连不上 Gitee 接口。可能是网络不通,或浏览器的跨域限制拦住了。请看部署文档「常见问题」里的“跨域”一条。';
    return (e && e.message) || String(e);
  }
  async function readFile(path) {
    var r = await fetch(url(path) + '?access_token=' + encodeURIComponent(conn.token) + '&_=' + Date.now());
    if (r.status === 404) return null;
    if (!r.ok) throw httpErr(r, await r.text());
    var j = await r.json();
    // Gitee 文件不存在时返回 200 + [](不是 404);空数组、没有 content 都当作“文件不存在”
    if (!j || Array.isArray(j) || typeof j.content !== 'string' || !j.content.replace(/\s/g, '')) return null;
    return { content: b64d(j.content), sha: j.sha };
  }
  async function writeFile(path, text, sha) {
    var body = { access_token: conn.token, content: b64e(text), message: 'admin ' + path };
    if (sha) body.sha = sha;
    var r = await fetch(url(path), { method: sha ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) throw httpErr(r, await r.text());
  }
  // 读-改-写 admin.json;冲突就重试一次。顺便清掉手机已经确认处理过的指令。
  async function mutateAdmin(fn) {
    for (var i = 0; i < 2; i++) {
      try {
        var f = await readFile('admin.json'), doc = f ? JSON.parse(f.content) : {};
        doc.ops = doc.ops || []; doc.cfgAt = doc.cfgAt || 0;
        var applied = (S && S.applied) || [];
        doc.ops = doc.ops.filter(function (o) { return applied.indexOf(o.id) < 0; });
        fn(doc); doc.v = 1;
        await writeFile('admin.json', JSON.stringify(doc, null, 1), f && f.sha);
        return;
      } catch (e) { if (i === 1 || [400, 409, 422].indexOf(e.status) < 0) throw e; }
    }
  }

  /* ───── 读数据 ───── */
  async function refresh(silent) {
    if (!conn) return render();
    busy = true; if (!silent) render();
    try {
      var r = await Promise.all([readFile('client.json'), readFile('admin.json')]);
      client = r[0] ? JSON.parse(r[0].content) : null;
      adminDoc = r[1] ? JSON.parse(r[1].content) : { cfg: null, cfgAt: 0, ops: [] };
      adminDoc.ops = adminDoc.ops || []; adminDoc.cfgAt = adminDoc.cfgAt || 0;
      S = C.normalize(client && client.state, today());
      err = ''; loadedAt = Date.now();
      formStarts = null;
    } catch (e) { err = describe(e); }
    busy = false; booting = false; render();
  }

  var pendingOps = function () { var ap = (S && S.applied) || []; return (adminDoc ? adminDoc.ops : []).filter(function (o) { return ap.indexOf(o.id) < 0; }); };
  var cfgPending = function () { return !!(adminDoc && adminDoc.cfg && adminDoc.cfgAt > (S.adminSeen !== undefined ? S.adminSeen : (S.cfgAt || 0))); };
  function ago(ms) {
    var m = Math.round((Date.now() - ms) / 60000);
    if (m < 1) return '刚刚'; if (m < 60) return m + ' 分钟前';
    var h = Math.round(m / 60); if (h < 48) return h + ' 小时前';
    return Math.round(h / 24) + ' 天前';
  }
  var md = function (d) { return C.mdText(d); };
  var wk = function (d) { return '周' + WD[C.dparse(d).getDay()]; };
  function firstTs(day) { var lg = S.logs[day] || {}, ts = ''; Object.keys(lg).forEach(function (k) { if (!ts && lg[k] && lg[k].ts) ts = lg[k].ts; }); return ts; }

  /* ───── 界面 ───── */
  var LOGO = '<svg width="26" height="26" viewBox="0 0 72 72"><g transform="translate(36 36) rotate(-45)"><rect x="-26" y="-12" width="52" height="24" rx="12" fill="#FFC83D"/><clipPath id="lc"><rect x="-28" y="-14" width="28" height="28"/></clipPath><rect x="-26" y="-12" width="52" height="24" rx="12" fill="#6C43F0" clip-path="url(#lc)"/></g></svg>';
  var ICON_R = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 4v5h-5"/></svg>';
  var ICON_X = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5M21 12H9"/></svg>';

  function renderLoading() {
    return '<div class="loading"><div class="spin"></div><div>正在读取数据…</div></div>';
  }
  function renderLogin() {
    var c = conn || { repo: '', token: '', api: DEF_API };
    return '<div class="login"><div class="card"><div class="logo">' + LOGO + '</div><h1>家人用药 · 管理端</h1>' +
      '<p class="t">远程查看打卡、调整药量和用量。数据只经过你自己的 Gitee 私有仓库。</p>' +
      '<div class="lab">数据仓库(私有)</div><input id="lg_repo" class="wide" type="text" value="' + esc(c.repo) + '" placeholder="用户名/pilltime-data" autocapitalize="off" autocorrect="off" spellcheck="false">' +
      '<div class="lab">Gitee 私人令牌</div><input id="lg_tok" class="wide" type="password" value="' + esc(c.token) + '" placeholder="粘贴令牌" autocapitalize="off" autocorrect="off" spellcheck="false">' +
      '<details><summary>高级:接口地址</summary><input id="lg_api" class="wide" type="text" style="margin-top:8px" value="' + esc(c.api || DEF_API) + '" autocapitalize="off" spellcheck="false"></details>' +
      (err ? '<div class="err">' + esc(err) + '</div>' : '') +
      '<button class="btn full" style="margin-top:16px" data-act="login">' + (busy ? '连接中…' : '连接') + '</button>' +
      '<div class="sub" style="text-align:center">令牌只保存在这台设备的浏览器里,不会写进页面或仓库。</div></div></div>';
  }

  function summary() {
    var t = today(), due = C.dueDrugs(S, t), taken = C.isTaken(S, t), ts = firstTs(t), ph = C.phase(S, t), ev = C.nextEvents(S, t), cyc = C.cycNames(S);
    var a, b, c;
    // 今日打卡
    if (!client) a = ['等待手机同步', 'a', '手机端还没有上传过数据'];
    else if (!due.length) a = ['今天没有要吃的药', 'p', '无需打卡'];
    else if (taken) a = ['已打卡 ✓', 'g', '打卡时间:' + (ts || '—') + ' · ' + C.doseList(due)];
    else a = ['未打卡(等待中)', 'a', '应吃:' + C.doseList(due)];
    // 周期
    if (ph.before) b = ['周期还没开始', 'p', cyc + ' 从 ' + md(S.settings.cycleStarts.slice().sort()[0] || t) + ' 开始'];
    else if (ph.on) b = [cyc + '·第<span class="nn">' + ph.cycleDay + '</span>天(用药期)', 'p', ev.offStart ? (C.diffDays(ev.offStart, t) === 1 ? '明天就是停药休息期哦(' + md(ev.offStart) + ')' : '还有 ' + C.diffDays(ev.offStart, t) + ' 天进入停药休息期(' + md(ev.offStart) + ')') : '用药期'];
    else b = [cyc + '·停药期·第<span class="nn">' + (ph.cycleDay - S.settings.onDays) + '</span>天', 'g', ev.onStart ? md(ev.onStart) + ' 恢复用药(还有 ' + C.diffDays(ev.onStart, t) + ' 天)' : '停药期'];
    // 拿药
    var st = C.drugStatuses(S, t), low = st.filter(function (x) { return x.tracked && x.low; }), tr = st.filter(function (x) { return x.tracked; });
    if (low.length) c = ['⚠ 需提前去医院开药', 'r', low.map(function (x) { return x.name + (x.doseDays ? '仅剩 ' + x.doseDays + ' 天药量' : '已经不够吃'); }).join(';')];
    else if (tr.length) c = ['药量充足 ✓', 'g', tr.map(function (x) { return x.name + '够吃 ' + x.doseDays + ' 天'; }).join(';')];
    else c = ['没有记录药量', 'a', '在下面「药量」里填一下现有药量'];
    return [['今日家人打卡状态', a], ['当前用药周期阶段', b], ['处方拿药预警', c]].map(function (x) {
      return '<div class="card s"><div class="k">' + x[0] + '</div><div class="big ' + x[1][1] + '">' + (x[1][0].indexOf('<span class="nn">') >= 0 ? x[1][0].replace(/<span class="nn">(\d+)<\/span>/, '\u0001$1\u0002').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/\u0001/g, '<span class="nn">').replace(/\u0002/g, '</span>') : esc(x[1][0])) + '</div><div class="sub">' + esc(x[1][2]) + '</div></div>';
    }).join('');
  }

  function logTable() {
    var t = today(), pend = pendingOps().filter(function (o) { return o.type === 'setLog'; }), rows = '';
    for (var i = 0; i < 7; i++) {
      var d = C.addDays(t, -i), pre = d < (S.first || t);
      var due = C.dueDrugs(S, d), taken = C.isTaken(S, d), p = pend.filter(function (o) { return o.day === d; }).pop();
      var tag, btn = '';
      if (!due.length) tag = '<span class="tag none">' + (pre ? '无记录' : '无需服药') + '</span>';
      else if (taken) tag = '<span class="tag ok">已打卡' + (firstTs(d) ? ' ' + esc(firstTs(d)) : '') + '</span>';
      else if (pre) tag = '<span class="tag none">无记录</span>';
      else if (d === t) tag = '<span class="tag wait">未打卡</span>';
      else tag = '<span class="tag miss">漏服</span>';
      if (due.length) btn = '<button class="btn g sm" data-act="toggle" data-day="' + d + '" data-to="' + (taken ? 0 : 1) + '">' + (taken ? '撤销打卡' : '补记打卡') + '</button>';
      if (p) tag += '<span class="pend">待手机同步:' + (p.taken ? '已打卡' : '未打卡') + '</span>';
      rows += '<tr><td class="dc"><b>' + (i === 0 ? '今天' : i === 1 ? '昨天' : md(d)) + '</b><div class="sub" style="margin:2px 0 0;white-space:nowrap">' + md(d) + ' ' + wk(d) + '</div><div class="sub" style="margin:3px 0 0">' + (due.length ? esc(due.map(function (x) { return x.name + x.qty + '粒'; }).join('、')) : '今天不用吃药') + '</div></td><td>' + tag + (btn ? '<div style="margin-top:8px">' + btn + '</div>' : '') + '</td></tr>';
    }
    return '<div class="card"><h2><i></i>最近七天打卡记录</h2><div class="note">家人忘了点或点错了,可以在这里直接改。改完等手机同步后生效(药量会自动加减)。</div>' +
      '<div style="overflow-x:auto"><table class="tbl"><thead><tr><th>日期 / 应服药</th><th style="text-align:left;border-radius:0 12px 12px 0">状态 / 调整</th></tr></thead><tbody>' + rows + '</tbody></table></div></div>';
  }

  function stockCard() {
    var t = today(), st = C.drugStatuses(S, t), pend = pendingOps().filter(function (o) { return o.type === 'setStock' || o.type === 'addStock'; });
    var h = '<div class="card"><h2><i></i>药量</h2><div class="note">直接填「现在家里还有多少粒」,或填「这次拿回多少粒」补货。药量以手机为准,每次打卡手机会自动扣减。</div>';
    st.forEach(function (x) {
      var p = pend.filter(function (o) { return o.drug === x.id; });
      h += '<div class="drug"><h3><span class="dot" style="background:' + esc(x.color || '#9AD3FF') + '"></span>' + esc(x.name) + '</h3>' +
        '<div class="stockline">' + (x.tracked ? '现有 <b>' + x.stock + '</b> 粒 · 够吃 ' + x.doseDays + ' 天' + (x.runOut ? ',约 ' + md(x.runOut) + ' 用完' : '') + (x.low ? ' <span class="tag miss">该开药了</span>' : '') : '没有记录药量') + '</div>' +
        (p.length ? '<div class="stockline">' + p.map(function (o) { return '<span class="pend">待手机同步:' + (o.type === 'setStock' ? '设为 ' + o.value + ' 粒' : '补货 +' + o.n + ' 粒') + '</span>'; }).join('') + '</div>' : '') +
        '<div class="ops"><input id="st_' + esc(x.id) + '" type="number" inputmode="numeric" placeholder="现有多少粒"><button class="btn g sm" data-act="setstock" data-id="' + esc(x.id) + '">设为这个数</button></div>' +
        '<div class="ops"><input id="ad_' + esc(x.id) + '" type="number" inputmode="numeric" placeholder="拿回多少粒"><button class="btn g sm" data-act="addstock" data-id="' + esc(x.id) + '">补货</button></div></div>';
    });
    return h + '</div>';
  }

  function baseCfg() {
    var c = cfgPending() ? { settings: Object.assign({}, S.settings, adminDoc.cfg.settings), drugs: S.drugs.map(function (d) { var a = (adminDoc.cfg.drugs || []).filter(function (x) { return x.id === d.id; })[0] || d; return { id: d.id, name: a.name, qty: a.qty, cyclic: !!a.cyclic, color: d.color }; }) } : C.cfgOf(S);
    return c;
  }
  var num = function (k, v, min, max, unit) { return '<input type="number" inputmode="numeric" data-s="' + k + '" data-min="' + min + '" data-max="' + max + '" value="' + v + '">'; };
  function row(label, sub, ctl) { return '<div class="row"><label>' + label + (sub ? '<small>' + sub + '</small>' : '') + '</label>' + ctl + '</div>'; }
  function startsBox() {
    return '<div class="starts">' + formStarts.map(function (x) { return '<span>' + x.replace(/-/g, '/') + ' ' + wk(x) + '<button data-act="rmstart" data-d="' + x + '">×</button></span>'; }).join('') + '</div>' +
      '<div class="ops"><input id="newStart" type="date" style="text-align:left"><button class="btn g sm" data-act="addstart">添加起始日</button></div>';
  }
  function cfgCard() {
    var c = baseCfg(), s = c.settings;
    if (!formStarts) formStarts = s.cycleStarts.slice().sort();
    var h = '<div class="card"><h2><i></i>用量与提醒参数</h2><div class="note">' + (cfgPending() ? '<span class="pend" style="margin:0 6px 0 0">有修改等手机同步</span>' : '') + '改完点最下面的按钮。手机同步后,提醒会按新参数重新安排。</div><div id="cfgform">';
    c.drugs.forEach(function (d) {
      h += '<div class="drug"><h3><span class="dot" style="background:' + esc(d.color || '#9AD3FF') + '"></span>' + esc(d.name) + '</h3>' +
        row('每天吃几粒', '', '<input type="number" inputmode="numeric" data-d="qty" data-id="' + esc(d.id) + '" data-min="1" data-max="20" value="' + d.qty + '">') +
        row('按周期吃', '开:按下面的用药期/停药期,停药期不吃', '<input type="checkbox" data-d="cyclic" data-id="' + esc(d.id) + '"' + (d.cyclic ? ' checked' : '') + '>') + '</div>';
    });
    h += row('提醒时间', '每天第一次提醒', '<input type="time" data-s="remindTime" value="' + esc(s.remindTime) + '">') +
      row('提醒文字', '例如:早饭后', '<input type="text" data-s="hint" value="' + esc(s.hint) + '">') +
      row('闹钟式强提醒', '锁屏响铃 + 屏幕中间弹窗', '<input type="checkbox" data-s="alarmMode"' + (s.alarmMode ? ' checked' : '') + '>') +
      row('没吃药追问间隔', '分钟', num('followMin', s.followMin, 1, 120)) + row('最多追问几次', '', num('followMax', s.followMax, 0, 10)) +
      row('点「稍后吃」后再提醒', '分钟', num('snoozeMin', s.snoozeMin, 1, 60)) +
      row('停药/恢复前一晚提醒', '', '<input type="checkbox" data-s="eveRemind"' + (s.eveRemind ? ' checked' : '') + '>') + row('前一晚提醒时间', '', '<input type="time" data-s="eveTime" value="' + esc(s.eveTime) + '">') +
      row('药只够吃几天时提醒开药', '天', num('refillDays', s.refillDays, 1, 30)) + row('开药提醒时间', '', '<input type="time" data-s="refillTime" value="' + esc(s.refillTime) + '">') +
      row('用药期(天)', '', num('onDays', s.onDays, 1, 60)) + row('停药期(天)', '', num('offDays', s.offDays, 0, 30)) +
      '<div class="k" style="margin-top:12px">周期起始日(医生推迟恢复时,在这里加新的一天)</div><div id="startsBox">' + startsBox() + '</div></div>' +
      '<button class="btn full" style="margin-top:14px" data-act="savecfg">保存参数并同步至家人端</button></div>';
    return h;
  }

  function monthCard() {
    var t = today(), days = [], need = {}, nd = {}, qd = {}, offs = [], ons = [], prev = null, i, d, ph;
    var st = C.drugStatuses(S, t);
    for (i = 0; i < 30; i++) {
      d = C.addDays(t, i); ph = C.phase(S, d);
      days.push({ d: d, st: ph.before ? 'n' : ph.on ? 'on' : 'off' });
      if (prev && prev !== 'n') { if (prev === 'on' && days[i].st === 'off') offs.push(d); if (prev === 'off' && days[i].st === 'on') ons.push(d); }
      prev = days[i].st;
      if (i === 0 && C.isTaken(S, d)) continue;
      C.dueDrugs(S, d).forEach(function (x) { need[x.id] = (need[x.id] || 0) + x.qty; nd[x.id] = (nd[x.id] || 0) + 1; qd[x.id] = x.qty; });
    }
    var h = '<div class="card"><h2><i></i>未来一个月用药情况</h2><div class="note">从今天起 30 天。紫色是用药日,绿色是停药休息日。</div>';
    h += '<div class="mgrid">' + '一二三四五六日'.split('').map(function (x) { return '<div class="wh">' + x + '</div>'; }).join('');
    var off = (C.dparse(days[0].d).getDay() + 6) % 7;
    for (i = 0; i < off; i++) h += '<div></div>';
    days.forEach(function (x) {
      var mk = offs.indexOf(x.d) >= 0 ? '<em>停药</em>' : ons.indexOf(x.d) >= 0 ? '<em>恢复</em>' : '';
      h += '<div class="md ' + x.st + (x.d === t ? ' today' : '') + '"><b>' + Number(x.d.slice(8)) + '</b>' + mk + '</div>';
    });
    h += '</div><div class="legend"><span><i class="lg on"></i>用药</span><span><i class="lg off"></i>停药</span></div>';
    var ev = [], evs = [];
    offs.forEach(function (x, k) { evs.push({ d: x, off: true, next: k > 0 }); });
    ons.forEach(function (x) { evs.push({ d: x, off: false }); });
    evs.sort(function (a, b) { return a.d < b.d ? -1 : a.d > b.d ? 1 : 0; });
    evs.forEach(function (x) {
      var tom = C.diffDays(x.d, t) === 1 ? ' 明天' : '';
      ev.push((x.next ? '下一个停药期 ' : '') + '<b>' + md(x.d) + '</b>' + tom + (x.off ? ' 开始停药休息' : ' 恢复用药'));
    });
    if (ev.length) h += '<div class="sub" style="color:var(--ink)">' + ev.join('<br>') + '</div>';
    h += '<div class="note" style="margin-top:14px">停药休息的日子不吃瑞波西利,所以不是整整 30 天都要吃;今天如果已经打卡,今天就不再算。</div><div class="lab" style="margin-top:0">要准备多少药(按今天起 30 天算)</div>';
    st.forEach(function (x) {
      var n = need[x.id] || 0, ok = x.tracked ? x.stock >= n : null;
      h += row(esc(x.name), '', '<div class="need"><div>每天 ' + (qd[x.id] || x.qty) + ' 粒 × ' + (nd[x.id] || 0) + ' 个吃药日 = <b>' + n + '</b> 粒</div><div>' + (x.tracked ? '家里现有 ' + x.stock + ' 粒 ' + (ok ? '<span class="tag ok">够吃</span>' : '<span class="tag miss">还差 ' + (n - x.stock) + ' 粒,要去开药</span>') : '<span class="tag none">还没填现有药量</span>') + '</div></div>');
    });
    return h + '</div>';
  }

  function syncCard() {
    var po = pendingOps(), at = client && client.at ? Date.parse(client.at) : 0;
    return '<div class="card"><h2><i></i>同步状态</h2>' +
      row('手机最后同步', '', '<b>' + (at ? ago(at) : '还没有') + '</b>') +
      row('手机 App 版本', '', '<b>' + esc((client && client.app) || '—') + '</b>') +
      row('等手机确认的修改', '手机打开 App 或后台同步时会收到', '<b>' + (po.length + (cfgPending() ? 1 : 0)) + ' 项</b>') +
      row('本页刷新于', '每分钟自动刷新', '<b>' + (loadedAt ? ago(loadedAt) : '—') + '</b>') + '</div>';
  }

  function renderMain() {
    var at = client && client.at ? Date.parse(client.at) : 0, stale = at && Date.now() - at > 6 * 3600 * 1000;
    return '<header><div class="brand"><div class="logo">' + LOGO + '</div><div><h1>家人用药 · 管理端</h1><small>' + esc(conn.repo) + '</small></div></div>' +
      '<div class="tools"><span class="chip ' + (!at ? 'bad' : stale ? 'warn' : 'ok') + '">' + (!at ? '手机还没同步过' : '手机同步于 ' + ago(at)) + '</span>' +
      '<button class="icon-btn" title="刷新" data-act="refresh">' + ICON_R + '</button><button class="icon-btn" title="退出" data-act="logout">' + ICON_X + '</button></div></header>' +
      (err ? '<div class="err stale">' + esc(err) + '</div>' : '') +
      (!client && !err ? '<div class="card stale"><div class="big a">等待手机第一次同步</div><div class="sub">在家人手机 App 的「设置 → 与后台同步」里填同一个仓库和令牌,点「保存并同步」,这里就会出现数据。</div></div>' : '') +
      (stale ? '<div class="card stale"><div class="sub" style="margin:0">手机已经 ' + ago(at) + ' 没同步了(可能没开 App 或没网),下面是它上次同步时的数据。</div></div>' : '') +
      '<div class="cards3">' + summary() + '</div>' +
      '<div class="two"><div>' + logTable() + syncCard() + monthCard() + '</div><div>' + stockCard() + cfgCard() + '</div></div>' +
      '<div class="foot">管理端 v' + VER + ' · 数据存放在你的 Gitee 私有仓库</div>';
  }

  function render() {
    var app = $('app');
    app.innerHTML = (conn && S) ? renderMain() : booting ? renderLoading() : renderLogin();
  }

  /* ───── 操作 ───── */
  function toast(m) { var t = $('toast'); t.textContent = m; t.hidden = false; clearTimeout(toast._t); toast._t = setTimeout(function () { t.hidden = true; }, 2600); }
  var newId = function () { return 'o' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); };
  async function push(op, okMsg) {
    try { await mutateAdmin(function (doc) { op.id = newId(); op.t = Date.now(); doc.ops.push(op); }); toast(okMsg || '已提交,等手机同步'); await refresh(true); }
    catch (e) { toast('提交失败:' + describe(e)); }
  }
  function readCfg() {
    var c = baseCfg(), s = c.settings, bad = null;
    document.querySelectorAll('#cfgform [data-s]').forEach(function (el) {
      var k = el.dataset.s, v;
      if (el.type === 'checkbox') v = el.checked;
      else if (el.type === 'number') {
        v = Number(el.value);
        if (!isFinite(v) || Math.floor(v) !== v || v < Number(el.dataset.min) || v > Number(el.dataset.max)) bad = bad || ('请填 ' + el.dataset.min + ' ~ ' + el.dataset.max + ' 之间的整数');
      } else { v = el.value.trim(); if (el.type === 'time' && !v) bad = bad || '时间不能为空'; }
      s[k] = v;
    });
    document.querySelectorAll('#cfgform [data-d]').forEach(function (el) {
      var d = c.drugs.filter(function (x) { return x.id === el.dataset.id; })[0]; if (!d) return;
      if (el.dataset.d === 'qty') { var q = Number(el.value); if (!isFinite(q) || Math.floor(q) !== q || q < 1 || q > 20) bad = bad || '每天吃几粒:请填 1 ~ 20 的整数'; d.qty = q; }
      else d.cyclic = el.checked;
    });
    s.cycleStarts = formStarts.slice().sort();
    if (!s.cycleStarts.length) bad = bad || '至少要有一个周期起始日';
    return bad ? { bad: bad } : { cfg: c };
  }
  var ACT = {
    login: async function () {
      var repo = $('lg_repo').value.trim(), tok = $('lg_tok').value.trim(), api = ($('lg_api').value.trim() || DEF_API);
      if (!/^[\w.\-]+\/[\w.\-]+$/.test(repo)) { err = '仓库格式:用户名/仓库名'; return render(); }
      if (!tok) { err = '请粘贴令牌'; return render(); }
      conn = { repo: repo, token: tok, api: api };
      try { localStorage.setItem('pa_conn', JSON.stringify(conn)); } catch (e) {}
      err = ''; S = null; await refresh(false);
    },
    logout: function () { if (!confirm('退出后需要重新输入令牌,确定吗?')) return; try { localStorage.removeItem('pa_conn'); } catch (e) {} conn = null; S = null; client = null; err = ''; render(); },
    refresh: function () { dirty = false; refresh(false); },
    toggle: function (b) {
      var day = b.dataset.day, to = b.dataset.to === '1';
      if (!confirm((to ? '把 ' : '把 ') + md(day) + (to ? ' 补记为「已打卡」?药量会自动扣减。' : ' 改成「未打卡」?药量会自动加回。'))) return;
      push({ type: 'setLog', day: day, taken: to });
    },
    setstock: function (b) {
      var v = $('st_' + b.dataset.id).value;
      if (v === '' || !(Number(v) >= 0) || Math.floor(Number(v)) !== Number(v)) return toast('请填整数');
      push({ type: 'setStock', drug: b.dataset.id, value: Number(v) });
    },
    addstock: function (b) {
      var v = $('ad_' + b.dataset.id).value;
      if (!(Number(v) > 0) || Math.floor(Number(v)) !== Number(v)) return toast('请填大于 0 的整数');
      push({ type: 'addStock', drug: b.dataset.id, n: Number(v) });
    },
    addstart: function () {
      var v = $('newStart').value; if (!v) return toast('先选一个日期');
      if (formStarts.indexOf(v) < 0) formStarts.push(v); formStarts.sort(); dirty = true; $('startsBox').innerHTML = startsBox();
    },
    rmstart: function (b) { formStarts = formStarts.filter(function (x) { return x !== b.dataset.d; }); dirty = true; $('startsBox').innerHTML = startsBox(); },
    savecfg: async function () {
      var r = readCfg(); if (r.bad) return toast(r.bad);
      try {
        await mutateAdmin(function (doc) { doc.cfg = r.cfg; doc.cfgAt = Math.max(Date.now(), (doc.cfgAt || 0) + 1, ((S && S.cfgAt) || 0) + 1); });
        dirty = false; formStarts = null; toast('已保存,等手机同步后生效'); await refresh(true);
      } catch (e) { toast('保存失败:' + describe(e)); }
    }
  };

  document.addEventListener('click', function (e) {
    var b = e.target.closest('[data-act]');
    if (b && ACT[b.dataset.act]) ACT[b.dataset.act](b);
  });
  document.addEventListener('input', function (e) { if (e.target.closest && e.target.closest('#cfgform')) dirty = true; });

  // 每分钟自动刷新;正在改参数或输入时不刷新,免得把输入冲掉
  timer = setInterval(function () {
    if (!conn || !S || busy || dirty || document.hidden) return;
    var a = document.activeElement; if (a && /^(INPUT|TEXTAREA)$/.test(a.tagName)) return;
    refresh(true);
  }, 60000);
  document.addEventListener('visibilitychange', function () { if (!document.hidden && conn && S && !dirty) refresh(true); });

  if (conn) refresh(false); else render();
})();
