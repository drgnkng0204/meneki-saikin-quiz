import { firebaseConfig } from './firebase-config.js';

const FB_VER = '10.14.1';
const SUBJ = { imm: '基礎免疫学', bac: '細菌学' };
const USER_IDS = Array.from({ length: 8 }, (_, i) => 'user' + (i + 1));
const NEED_AFTER_MISS = 2; // 不正解後、あと2回正解で「正解扱い」
const $app = document.getElementById('app');

let bank = null, past = null, bugs = [];
const bugById = {};
const S = { user: lsGet('quiz:user'), subject: null, route: 'users', sess: null, exam: null };
const names = lsGet('quiz:names', {});
const store = {}; // store[user][subject] = {items:{}, past:{}}

// ---------- 小物 ----------
function lsGet(k, d = null) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } }
function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 容量/プライベートモード */ } }
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const shuffle = a => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const uname = u => names[u] || 'ユーザー' + u.replace('user', '');
const CIR = '①②③④⑤⑥⑦⑧⑨⑩';
const pct = (a, b) => b ? Math.round(a / b * 100) : 0;

function data(u = S.user, s = S.subject) {
  store[u] ??= {};
  if (!store[u][s]) store[u][s] = lsGet(`quiz:d:${u}:${s}`, { items: {}, past: {} });
  return store[u][s];
}
function saveLocal(u, s) { lsSet(`quiz:d:${u}:${s}`, store[u][s]); }

// ---------- クラウド(Firestore) ----------
const cloud = { state: firebaseConfig ? 'connecting' : 'local', fs: null, db: null, pending: 0 };
async function initCloud() {
  if (!firebaseConfig) return;
  try {
    const base = `https://www.gstatic.com/firebasejs/${FB_VER}/`;
    const [{ initializeApp }, fs] = await Promise.all([import(base + 'firebase-app.js'), import(base + 'firebase-firestore.js')]);
    const app = initializeApp(firebaseConfig);
    let db;
    try { db = fs.initializeFirestore(app, { localCache: fs.persistentLocalCache({ tabManager: fs.persistentMultipleTabManager() }) }); }
    catch { db = fs.getFirestore(app); }
    cloud.fs = fs; cloud.db = db; cloud.state = 'ok';
  } catch (e) { console.warn('Firebase init failed', e); cloud.state = 'offline'; }
  paintSync();
  syncNames();
}
function paintSync() {
  const el = document.getElementById('sync'); if (!el) return;
  const m = { local: ['この端末のみ保存', ''], connecting: ['接続中…', 'pend'], offline: ['オフライン', 'pend'], ok: [cloud.pending ? '送信待ち…' : '☁ 同期済み', cloud.pending ? 'pend' : 'ok'] }[cloud.state];
  el.textContent = m[0]; el.className = 'sync ' + m[1];
}
async function pushCloud(u, s, patch) {
  if (!cloud.db) return;
  const { doc, setDoc, serverTimestamp } = cloud.fs;
  cloud.pending++; paintSync();
  try {
    await setDoc(doc(cloud.db, 'progress', `${u}_${s}`), { user: u, subject: s, name: uname(u), updatedAt: serverTimestamp(), ...patch }, { merge: true });
    cloud.state = 'ok';
  } catch (e) { console.warn('push failed', e); cloud.state = 'offline'; }
  cloud.pending = Math.max(0, cloud.pending - 1); paintSync();
}
async function pullCloud(u, s) {
  if (!cloud.db) return;
  try {
    const { doc, getDoc } = cloud.fs;
    const snap = await getDoc(doc(cloud.db, 'progress', `${u}_${s}`));
    if (!snap.exists()) return;
    const c = snap.data(), d = data(u, s);
    for (const k of ['items', 'past']) for (const [id, v] of Object.entries(c[k] || {})) {
      const mine = d[k][id]; if (!mine || (v.t || 0) > (mine.t || 0)) d[k][id] = v;
    }
    saveLocal(u, s);
  } catch (e) { console.warn('pull failed', e); }
}
const dirty = new Set(lsGet('quiz:namesDirty', []));
async function pushNames(u) {
  if (u) { dirty.add(u); lsSet('quiz:namesDirty', [...dirty]); }
  if (!cloud.db) return;
  const { doc, setDoc } = cloud.fs;
  for (const k of [...dirty]) {
    try { await setDoc(doc(cloud.db, 'profiles', k), { name: uname(k) }, { merge: true }); dirty.delete(k); lsSet('quiz:namesDirty', [...dirty]); }
    catch (e) { console.warn('name push failed', e); }
  }
}
async function syncNames() {
  if (!cloud.db) return;
  await pushNames();
  try {
    const snap = await cloud.fs.getDocs(cloud.fs.collection(cloud.db, 'profiles'));
    let ch = false;
    snap.forEach(d => { const n = d.data().name; if (n && !dirty.has(d.id) && names[d.id] !== n) { names[d.id] = n; ch = true; } });
    if (ch) { lsSet('quiz:names', names); if (S.route === 'users' || S.route === 'home') render(); }
  } catch (e) { console.warn('name pull failed', e); }
}
async function fetchCompare(s) {
  const { collection, getDocs, query, where } = cloud.fs;
  const [a, b] = await Promise.all([getDocs(query(collection(cloud.db, 'progress'), where('subject', '==', s))), getDocs(collection(cloud.db, 'profiles'))]);
  const prof = {}; b.forEach(d => prof[d.id] = d.data().name);
  const rows = []; a.forEach(d => { const v = d.data(); rows.push({ user: v.user, name: prof[v.user] || v.name || uname(v.user), items: v.items || {}, past: v.past || {}, updatedAt: v.updatedAt?.toMillis?.() || 0 }); });
  return rows;
}

// ---------- 学習ロジック ----------
function record(qid, correct) {
  const d = data(), t = Date.now();
  const it = d.items[qid] || { a: 0, c: 0, w: 0, need: 0, m: 0, f: null, t: 0 };
  const first = it.a === 0;
  it.a++; it.t = t;
  if (correct) {
    it.c++;
    if (first) { it.f = 1; it.m = 1; it.need = 0; }
    else if (it.need > 0) { it.need--; if (it.need === 0) it.m = 1; }
  } else {
    it.w++; if (first) it.f = 0;
    it.m = 0; it.need = NEED_AFTER_MISS;
  }
  d.items[qid] = it; saveLocal(S.user, S.subject);
  pushCloud(S.user, S.subject, { items: { [qid]: it } });
  return it;
}
function recordPast(qid, correct) {
  const d = data(), t = Date.now();
  const it = d.past[qid] || { a: 0, c: 0, last: 0, t: 0 };
  it.a++; if (correct) it.c++; it.last = correct ? 1 : 0; it.t = t;
  d.past[qid] = it; saveLocal(S.user, S.subject);
  pushCloud(S.user, S.subject, { past: { [qid]: it } });
}
function judge(q, sel) {
  const a = [...q.ans].sort(), s = [...sel].sort();
  if (q.kind === 'multiany') return s.length === q.need && s.every(x => a.includes(x));
  return a.length === s.length && a.every((x, i) => x === s[i]);
}
function statsFor(items, qs) {
  let answered = 0, mastered = 0, attempts = 0, correct = 0, firstN = 0, firstOk = 0;
  for (const q of qs) {
    const it = items[q.id]; if (!it || !it.a) continue;
    answered++; attempts += it.a; correct += it.c; if (it.m) mastered++;
    if (it.f !== null && it.f !== undefined) { firstN++; firstOk += it.f; }
  }
  return { answered, mastered, attempts, correct, firstN, firstOk, total: qs.length };
}

// ---------- 画面共通 ----------
function header(title, back) {
  return `<header class="top">${back ? `<button class="chip" data-act="back" data-to="${back}">‹ 戻る</button>` : ''}<h1>${esc(title)}</h1>
  ${S.user ? `<button class="chip" data-act="switch-user">👤 ${esc(uname(S.user))}</button>` : ''}</header>
  <div class="sync" id="sync" style="text-align:right;margin:-8px 0 8px"></div>`;
}
function go(route, extra = {}) { Object.assign(S, extra, { route }); render(); window.scrollTo(0, 0); }
function render() {
  const r = { bugQ: vBugQ, bugDetail: vBugDetail, bugList: vBugList, users: vUsers, home: vHome, menu: vMenu, setup: vSetup, play: vPlay, summary: vSummary, pastList: vPastList, pastQ: vPastQ, compare: vCompare }[S.route];
  $app.innerHTML = r();
  paintSync();
  if (S.route === 'compare') loadCompare();
}

// ---------- ユーザー ----------
function vUsers() {
  return `<header class="top"><h1>ユーザーを選択</h1></header><div class="sync" id="sync" style="text-align:right;margin:-8px 0 8px"></div>
  <p class="note">成績はユーザーごとに記録され、他のユーザーと比較できます。名前の横の ✎ で変更できます。</p>
  <div class="grid">${USER_IDS.map(u => `<div class="big ${u === S.user ? 'me' : ''}" data-act="pick-user" data-u="${u}" role="button" tabindex="0"><b>${esc(uname(u))}</b><small>タップして開始</small>
    <button class="chip" data-act="rename" data-u="${u}" style="margin-top:6px">✎ 名前</button></div>`).join('')}</div>`;
}
function vHome() {
  const cards = Object.keys(SUBJ).map(s => {
    const qs = bank[s].qs, st = statsFor(data(S.user, s).items, qs);
    return `<button class="big" data-act="subject" data-s="${s}"><b>${SUBJ[s]}</b><small>予想問題 正解扱い ${st.mastered} / ${st.total}</small><div class="bar"><i style="width:${pct(st.mastered, st.total)}%"></i></div></button>`;
  }).join('');
  return `${header('免疫・細菌学 演習')}<p class="note">科目を選んでください。</p><div class="grid">${cards}</div>
  <div style="height:12px"></div><button class="btn sec" data-act="compare" data-s="imm">📊 成績を比較する</button>`;
}
function vMenu() {
  const s = S.subject, st = statsFor(data().items, bank[s].qs);
  return `${header(SUBJ[s], 'home')}
  <div class="card"><h2>あなたの進み具合(予想問題)</h2><div>正解扱い <b>${st.mastered}</b> / ${st.total} 問　・　回答済み ${st.answered} 問</div><div class="bar"><i style="width:${pct(st.mastered, st.total)}%"></i></div></div>
  <button class="big" data-act="setup"><b>📝 予想問題を解く</b><small>ランダム出題 / 章ごと・続きから・復習</small></button><div style="height:10px"></div>
  <button class="big" data-act="past-list"><b>📚 過去問を演習する</b><small>年度を選んで1問ずつ「回答する」→解答・解説</small></button><div style="height:10px"></div>
  ${s === 'bac' && bugs.length ? `<button class="big" data-act="bug-start" data-m="easy"><b>🦠 細菌当てクイズ【簡単モード】</b><small>岩谷先生「細菌学まとめ」(22-1028)に載っている${bugs.filter(b => b.easy).length}菌のみ</small></button><div style="height:10px"></div>
  <button class="big" data-act="bug-start" data-m="all"><b>🦠 細菌当てクイズ【すべてモード】</b><small>講義全体の${bugs.length}菌 ・ 特徴を1つずつ表示 → 菌名を当てる</small></button><div style="height:10px"></div>
  <button class="big" data-act="bug-list"><b>📖 細菌一覧(詳細・類似菌)</b><small>${bugs.length}菌 ・ 同じ特徴の菌・対照的な菌をまとめて確認</small></button><div style="height:10px"></div>` : ''}
  <button class="big" data-act="compare" data-s="${s}"><b>📊 成績を比較する</b><small>他のユーザーとの比較</small></button>`;
}

// ---------- 出題設定 ----------
function scopeQs() {
  const B = bank[S.subject];
  return S.setup.scope === 'all' ? B.qs : B.qs.filter(q => S.setup.chs.includes(q.ch));
}
function startPool(mode) {
  const it = data().items, qs = scopeQs();
  if (mode === 'continue') return qs.filter(q => !it[q.id]?.a);
  if (mode === 'review') return qs.filter(q => it[q.id]?.a && !it[q.id].m);
  return qs;
}
function vSetup() {
  S.setup ??= { scope: 'all', chs: [], mode: 'continue' };
  const B = bank[S.subject], it = data().items, su = S.setup;
  const chList = B.chapters.map(c => {
    const qs = B.qs.filter(q => q.ch === c.id), st = statsFor(it, qs);
    return `<label class="pick"><input type="checkbox" data-act="ch" value="${c.id}" ${su.chs.includes(c.id) ? 'checked' : ''}><span>${esc(c.name)}<small>${qs.length}問 ・ 正解扱い ${st.mastered}</small></span></label>`;
  }).join('');
  const cnt = m => startPool(m).length;
  const radio = (v, label, sub) => `<label class="pick"><input type="radio" name="mode" data-act="mode" value="${v}" ${su.mode === v ? 'checked' : ''}><span>${label}<small>${sub} ・ ${cnt(v)}問</small></span></label>`;
  const n = startPool(su.mode).length;
  return `${header(SUBJ[S.subject] + ' 予想問題', 'menu')}
  <div class="card"><h2>① 出題範囲</h2>
    <label class="pick"><input type="radio" name="scope" data-act="scope" value="all" ${su.scope === 'all' ? 'checked' : ''}><span>すべての問題からランダム<small>${B.qs.length}問</small></span></label>
    <label class="pick"><input type="radio" name="scope" data-act="scope" value="ch" ${su.scope === 'ch' ? 'checked' : ''}><span>章ごとに選ぶ<small>複数選択可</small></span></label>
    ${su.scope === 'ch' ? `<div style="margin:6px 0 0 30px">${chList}</div>` : ''}</div>
  <div class="card"><h2>② 始め方</h2>
    ${radio('continue', '以前始めたところから', '以前答えた問題はスキップ(未回答のみ)')}
    ${radio('fresh', '初めから', '範囲内の全問題')}
    ${radio('review', '間違えた問題の復習', '「正解扱い」になっていない問題だけ')}</div>
  <p class="note">※ 間違えた問題は、あと2回正解すると「正解扱い」になります。出題中に間違えた問題は、少し後でもう一度出題されます。</p>
  <div class="sticky"><button class="btn" data-act="start" ${n === 0 || (su.scope === 'ch' && !su.chs.length) ? 'disabled' : ''}>${n}問で開始</button></div>`;
}
function startSession() {
  const su = S.setup, pool = shuffle(startPool(su.mode));
  S.sess = { queue: pool.map(q => q.id), n0: pool.length, done: 0, ok: 0, ng: 0, sel: [], shown: false, cur: null, wrongSet: new Set() };
  go('play');
}

// ---------- 出題 ----------
const qById = {};
function findQ(id) { return qById[id]; }
const ORD = {};
const REF = /[①-⑩]|すべて|全て|いずれも|どれも|上記/;
const canShuffle = q => !REF.test(q.opts.join('') + (q.expl || ''));
function reshuffle(q) { const idx = q.opts.map((_, i) => i); ORD[q.id] = canShuffle(q) ? shuffle(idx) : idx; }
function ordOf(q) { if (!ORD[q.id] || ORD[q.id].length !== q.opts.length) reshuffle(q); return ORD[q.id]; }
function oeHtml(q) {
  if (!q.oe) return '';
  const multi = q.kind === 'multiany';
  const rows = ordOf(q).map((i, pos) => {
    const isAns = q.ans.includes(i), lab = multi ? String.fromCharCode(97 + pos) : (q.opts.length <= 10 ? CIR[pos] : (pos + 1));
    const txt = (multi ? q.opts[i].replace(/^[a-z]\s/, '') : q.opts[i]);
    return `<div class="oe ${isAns ? 'a' : ''}"><div class="oh"><b>${lab}</b> ${isAns ? '<span class="mk">★ 正解の選択肢</span>' : '<span class="mk x">× 選ぶべきでない</span>'}</div><div class="ot">${esc(txt)}</div><div class="od">${esc(q.oe[i])}</div></div>`;
  }).join('');
  return `<div class="expl"><b>選択肢ごとの解説</b><div class="oes">${rows}</div></div>`;
}
function optsHtml(q, sel, shown, ok) {
  const chips = q.opts.length > 6 || q.kind === 'multiany';
  const lab = i => q.kind === 'multiany' ? String.fromCharCode(97 + i) : (q.opts.length <= 10 ? CIR[i] : '');
  const items = ordOf(q).map((i, pos) => {
    const o = q.opts[i];
    let cls = 'opt';
    const isAns = q.ans.includes(i), isSel = sel.includes(i);
    if (shown) { if (isAns && isSel) cls += ' right'; else if (isSel) cls += ' wrong'; else if (isAns) cls += ' missed'; }
    else if (isSel) cls += ' sel';
    const text = q.kind === 'multiany' ? o.replace(/^[a-z]\s/, '') : o;
    return `<button class="${cls}" data-act="opt" data-i="${i}" ${shown ? 'disabled' : ''}>${q.kind === 'multiany' || chips && q.opts.length > 10 ? '' : `<span class="n">${lab(pos)}</span>`}<span>${q.kind === 'multiany' ? `<b>${lab(pos)}</b> ` : ''}${esc(text)}</span></button>`;
  }).join('');
  return chips ? `<div class="chips">${items}</div>` : items;
}
function hintFor(q) {
  if (q.kind === 'multiany') return `${q.need}つ選ぶ`;
  return q.ans.length > 1 ? `${q.ans.length}つ選ぶ` : '1つ選ぶ';
}
function nextId() { return S.sess.queue[0]; }
function vPlay() {
  const s = S.sess;
  if (!s.queue.length && !s.cur) return vSummaryBody();
  if (!s.cur) { s.cur = s.queue.shift(); s.sel = []; s.shown = false; reshuffle(findQ(s.cur)); }
  const q = findQ(s.cur), it = data().items[q.id];
  const chName = bank[S.subject].chapters.find(c => c.id === q.ch)?.name || '';
  const left = s.queue.length + (s.shown ? 0 : 1);
  const qs = bank[S.subject].qs, gi = qs.findIndex(x => x.id === q.id) + 1;
  const ci = qs.filter(x => x.ch === q.ch).findIndex(x => x.id === q.id) + 1;
  let result = '';
  if (s.shown) {
    const it2 = data().items[q.id];
    const sub = it2.m ? '✅ この問題は「正解扱い」になりました' : `あと${it2.need}回正解すると「正解扱い」になります(この後もう一度出題されます)`;
    result = `<div class="result ${s.lastOk ? 'ok' : 'ng'}">${s.lastOk ? '⭕ 正解' : '❌ 不正解'}<small>${sub}</small></div>
    <div class="expl"><b>正解</b>${ordOf(q).filter(i => q.ans.includes(i)).map(i => esc(q.opts[i])).join(' / ')}</div>
    <div class="expl"><b>解説</b>${esc(q.expl)}${q.pp?.length ? `<br><span class="note">講義スライド ${q.pp.map(p => 'p.' + p).join('・')}</span>` : ''}</div>${oeHtml(q)}`;
  }
  return `${header(SUBJ[S.subject], 'quit')}
  <div class="meta"><span>残り ${left}問 / 全${s.n0}問</span><span>⭕ ${s.ok}　❌ ${s.ng}</span></div>
  <div class="bar"><i style="width:${pct(s.n0 - left + (s.shown ? 1 : 0), s.n0)}%"></i></div>
  <div class="meta" style="margin-top:10px"><span><b class="qno">No.${gi}</b> ${esc(chName)}（章内${ci}）${it?.a ? `<span class="tag">${it.m ? '正解扱い' : '復習中'}</span>` : '<span class="tag">未回答</span>'}</span><span>${hintFor(q)}</span></div>
  <div class="qtext">${esc(q.text)}</div>
  ${optsHtml(q, s.sel, s.shown)}
  ${result}
  <div class="sticky">${s.shown ? `<button class="btn" data-act="next">次の問題へ</button>` :
      `<div class="row"><button class="btn sec" data-act="dontknow">わからない</button><button class="btn" data-act="answer" ${s.sel.length ? '' : 'disabled'}>回答する</button></div>`}</div>`;
}
function answerCurrent(forceWrong) {
  const s = S.sess, q = findQ(s.cur);
  const ok = forceWrong ? false : judge(q, s.sel);
  const it = record(q.id, ok);
  s.shown = true; s.lastOk = ok;
  if (ok) s.ok++; else s.ng++;
  s.done++;
  // まだ「正解扱い」でない問題は、少し後でもう一度出題
  if (!it.m) { const pos = Math.min(s.queue.length, (ok ? 6 : 3) + Math.floor(Math.random() * 4)); s.queue.splice(pos, 0, q.id); s.n0++; }
  render();
}
function nextQuestion() { const s = S.sess; s.cur = null; s.shown = false; render(); window.scrollTo(0, 0); }
function vSummaryBody() {
  const s = S.sess, st = statsFor(data().items, bank[S.subject].qs);
  return `${header('今回の結果', 'menu')}
  <div class="card"><div style="font-size:22px;font-weight:700">${s.ok + s.ng}回答 ・ ⭕ ${s.ok} ・ ❌ ${s.ng}</div>
  <div class="note">正答率 ${pct(s.ok, s.ok + s.ng)}%</div>
  <div style="margin-top:12px">正解扱い <b>${st.mastered}</b> / ${st.total} 問</div><div class="bar"><i style="width:${pct(st.mastered, st.total)}%"></i></div></div>
  <button class="btn" data-act="setup">続けて出題する</button><div style="height:10px"></div>
  <button class="btn sec" data-act="compare" data-s="${S.subject}">📊 成績を比較する</button>`;
}
function vSummary() { return vSummaryBody(); }

// ---------- 過去問 ----------
function vPastList() {
  const exams = past[S.subject], pd = data().past;
  const cards = exams.map(e => {
    const done = e.qs.filter(q => pd[q.id]?.a).length, good = e.qs.filter(q => pd[q.id]?.last).length;
    return `<button class="big" data-act="open-exam" data-e="${e.id}"><b>${esc(e.label)}</b><small>${e.qs.length}問 ・ 回答済み ${done} ・ 前回正解 ${good}</small><div class="bar"><i style="width:${pct(done, e.qs.length)}%"></i></div></button>`;
  }).join('');
  return `${header(SUBJ[S.subject] + ' 過去問', 'menu')}
  <p class="note">年度を選んで演習します。記述式の問題は掲載していません(選択式・穴埋め選択のみ)。再現問題のため、一部の選択肢・解答は学生作成のものです。</p><div class="grid">${cards}</div>`;
}
function curExam() { return past[S.subject].find(e => e.id === S.exam.id); }
function vPastQ() {
  const e = curExam(), pd = data().past, x = S.exam, q = e.qs[x.i];
  const dots = e.qs.map((qq, i) => {
    const st = pd[qq.id]; const c = st?.a ? (st.last ? 'ok' : 'ng') : '';
    return `<button class="dot ${c} ${i === x.i ? 'cur' : ''}" data-act="goto" data-i="${i}">${esc(qq.label.replace('Q', ''))}</button>`;
  }).join('');
  const shown = x.shown[q.id];
  let result = '';
  if (shown) {
    result = `<div class="result ${shown.ok ? 'ok' : 'ng'}">${shown.ok ? '⭕ 正解' : '❌ 不正解'}</div>
    <div class="expl"><b>正解</b>${q.ans.map(i => esc(q.kind === 'multiany' ? q.opts[i] : q.opts[i])).join(' / ')}</div>
    <div class="expl"><b>解説</b>${esc(q.expl)}</div>${oeHtml(q)}`;
  }
  const sel = x.sel[q.id] || [];
  return `${header(e.label, 'pastList')}
  <div class="dots">${dots}</div>
  <div class="meta"><span>${esc(q.label)}${pd[q.id]?.a ? `<span class="tag">前回 ${pd[q.id].last ? '⭕' : '❌'}</span>` : ''}</span><span>${hintFor(q)}</span></div>
  ${q.ctx ? `<div class="ctx">${esc(q.ctx)}</div>` : ''}
  <div class="qtext">${esc(q.text)}</div>
  ${optsHtml(q, sel, !!shown)}
  ${result}
  <div class="sticky"><div class="row">
    <button class="btn sec" data-act="prevq" ${x.i === 0 ? 'disabled' : ''}>‹ 前へ</button>
    ${shown ? '' : `<button class="btn" data-act="past-answer" ${sel.length ? '' : 'disabled'}>回答する</button>`}
    <button class="btn sec" data-act="nextq" ${x.i === e.qs.length - 1 ? 'disabled' : ''}>次へ ›</button></div></div>`;
}


// ---------- 細菌当てクイズ ----------
const shuffleArr = a => { a = [...a]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const bugTags = b => [...new Set([...b.props, b.oxy])];
const inPool = b => S.bugMode !== 'easy' || b.easy;
function bugChip(id, why) {
  const b = bugById[id]; if (!b || !inPool(b)) return '';
  return `<button class="chip bchip" data-act="bug-open" data-id="${id}">${esc(b.name.replace(/\(.*$/, ''))}${why ? `<small>${esc(why)}</small>` : ''}</button>`;
}
function bugBadges(b) { return `<div class="bbadges"><span class="bb gram">${esc(b.gram)}</span><span class="bb oxy">${esc(b.oxy)}</span></div>`; }
function bugGroups(b) {
  const rows = bugTags(b).map(t => {
    const o = bugs.filter(x => x.id !== b.id && inPool(x) && bugTags(x).includes(t));
    return o.length ? `<div class="grp"><div class="gt">${esc(t)}<span class="tag">${o.length + 1}菌</span></div><div class="chips">${o.map(x => bugChip(x.id)).join('')}</div></div>` : '';
  }).join('');
  return `<div class="card"><h2>同じ特徴をもつ菌(タップで詳細)</h2>${rows || '<p class="note">なし</p>'}</div>`;
}
function bugRel(b) {
  const l = (arr, h) => (arr = arr.filter(([k]) => inPool(bugById[k]))).length ? `<div class="grp"><div class="gt">${h}</div><div class="chips">${arr.map(([k, w]) => bugChip(k, w)).join('')}</div></div>` : '';
  const s = l(b.con, '⇄ 対照的な菌(鑑別)') + l(b.rel, '🔗 関連する菌');
  return s ? `<div class="card"><h2>対照・関連</h2>${s}</div>` : '';
}
function vBugQ() {
  const q = S.bq, b = bugById[q.order[q.i]], n = b.hints.length;
  const hs = b.hints.slice(0, q.n).map((h, i) => `<li><span class="hn">${i + 1}</span>${esc(h)}</li>`).join('');
  let body = '';
  if (!q.reveal) {
    body = `${q.n < n ? `<button class="btn" data-act="bug-next">次の特徴を表示 (${q.n}/${n})</button><div style="height:10px"></div>` : ''}
    <button class="btn ${q.n < n ? 'sec' : ''}" data-act="bug-reveal">答えを表示</button>`;
  } else {
    body = `<div class="card ans"><div class="note">答え</div><div class="bname">${esc(b.name)}</div><div class="note">${esc(b.sci)}</div></div>
    ${q.graded === undefined ? `<div class="row"><button class="btn ok" data-act="bug-grade" data-v="1">⭕ 正解</button><button class="btn ng" data-act="bug-grade" data-v="0">❌ 不正解</button></div>` :
      `<div class="result ${q.graded ? 'ok' : 'ng'}">${q.graded ? '⭕ 正解として記録' : '❌ 不正解として記録'}</div>`}
    ${q.graded === undefined ? '' : `${bugGroups(b)}${bugRel(b)}
    <button class="btn sec" data-act="bug-open" data-id="${b.id}">この菌の詳細を見る</button><div style="height:10px"></div>
    <button class="btn" data-act="bug-nextq">${q.i + 1 < q.order.length ? '次の菌へ ›' : '終了'}</button>`}`;
  }
  return `${header('細菌当てクイズ', 'menu')}
  <div class="meta"><span>${S.bugMode === 'easy' ? '簡単モード' : 'すべてモード'} ${q.i + 1} / ${q.order.length}</span><span>特徴 ${q.n}/${n}</span></div>
  <div class="card">${bugBadges(b)}<ol class="hints">${hs}</ol></div>${body}`;
}
function vBugDetail() {
  const b = bugById[S.bugId];
  const rows = b.rows.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join('');
  return `${header(b.name, 'bugBack')}
  <div class="card">${bugBadges(b)}<div class="note" style="margin-top:6px">${esc(b.sci)} ・ ${esc(b.sec)}</div>
  <div class="chips" style="margin-top:8px">${b.props.map(p => `<span class="tag" style="margin:0">${esc(p)}</span>`).join('')}</div></div>
  <div class="card"><h2>特徴(出題順)</h2><ol class="hints">${b.hints.map((h, i) => `<li><span class="hn">${i + 1}</span>${esc(h)}</li>`).join('')}</ol></div>
  ${bugGroups(b)}${bugRel(b)}
  <div class="card scroll"><h2>詳細まとめ(講義スライドより)</h2><table class="cmp bt">${rows}</table></div>`;
}
function vBugList() {
  const secs = [...new Set(bugs.map(b => b.sec))];
  return `${header('細菌一覧', 'menu')}<p class="note">名前をタップすると詳細ページに移動します。</p>` + secs.map(s =>
    `<div class="card"><h2>${esc(s)}</h2><div class="chips">${bugs.filter(b => b.sec === s).map(b => bugChip(b.id)).join('')}</div></div>`).join('');
}

// ---------- 成績比較 ----------
function vCompare() {
  const s = S.cmpSubject || S.subject || 'imm';
  S.cmpSubject = s;
  return `${header('成績の比較', S.subject ? 'menu' : 'home')}
  <div class="row" style="margin-bottom:12px">${Object.keys(SUBJ).map(k => `<button class="btn ${k === s ? '' : 'sec'} small" data-act="cmp-subj" data-s="${k}">${SUBJ[k]}</button>`).join('')}</div>
  <div id="cmp"><p class="note">読み込み中…</p></div>`;
}
async function loadCompare() {
  const s = S.cmpSubject, box = document.getElementById('cmp'); if (!box) return;
  const qs = bank[s].qs;
  let rows = [];
  if (cloud.db) { try { rows = await fetchCompare(s); } catch (e) { console.warn(e); } }
  // 自分の最新(ローカル)を反映
  const mineLocal = data(S.user, s);
  const mi = rows.find(r => r.user === S.user);
  if (mi) { for (const k of ['items', 'past']) for (const [id, v] of Object.entries(mineLocal[k])) if (!mi[k][id] || (v.t || 0) >= (mi[k][id].t || 0)) mi[k][id] = v; }
  else if (Object.keys(mineLocal.items).length || Object.keys(mineLocal.past).length) rows.push({ user: S.user, name: uname(S.user), items: mineLocal.items, past: mineLocal.past, updatedAt: 0 });
  rows.sort((a, b) => a.user.localeCompare(b.user, 'en', { numeric: true }));
  if (!document.getElementById('cmp')) return;
  if (!rows.length) { box.innerHTML = `<div class="card"><p>まだ記録がありません。</p>${cloud.db ? '' : '<p class="note">クラウド同期が未設定のため、この端末の記録のみ表示されます。</p>'}</div>`; return; }
  const st = rows.map(r => ({ r, st: statsFor(r.items, qs) }));
  const th = '<th>ユーザー</th>' + st.map(x => `<th>${esc(x.r.name)}${x.r.user === S.user ? ' (あなた)' : ''}</th>`).join('');
  const tr = (label, f) => `<tr><td>${label}</td>${st.map(x => `<td>${f(x.st, x.r)}</td>`).join('')}</tr>`;
  const sum = `<div class="card scroll"><h2>${SUBJ[s]} 予想問題</h2><table class="cmp"><thead><tr>${th}</tr></thead><tbody>
    ${tr('正解扱い', x => `<b>${x.mastered}</b> / ${x.total}<div class="bar"><i style="width:${pct(x.mastered, x.total)}%"></i></div>`)}
    ${tr('回答済み', x => `${x.answered}問`)}
    ${tr('総回答数', x => x.attempts)}
    ${tr('正答率', x => x.attempts ? pct(x.correct, x.attempts) + '%' : '-')}
    ${tr('初回正解率', x => x.firstN ? pct(x.firstOk, x.firstN) + '%' : '-')}
  </tbody></table></div>`;
  const chRows = bank[s].chapters.map(c => {
    const cq = qs.filter(q => q.ch === c.id);
    return `<tr><td>${esc(c.name)}<div class="note">${cq.length}問</div></td>${st.map(x => { const z = statsFor(x.r.items, cq); return `<td>${z.answered ? pct(z.mastered, cq.length) + '%' : '-'}</td>`; }).join('')}</tr>`;
  }).join('');
  const chap = `<div class="card scroll"><h2>章ごとの正解扱い率</h2><table class="cmp"><thead><tr>${th}</tr></thead><tbody>${chRows}</tbody></table></div>`;
  const pRows = past[s].map(e => `<tr><td>${esc(e.label)}<div class="note">${e.qs.length}問</div></td>${st.map(x => { const n = e.qs.filter(q => x.r.past[q.id]?.a).length, g = e.qs.filter(q => x.r.past[q.id]?.last).length; return `<td>${n ? `${g}/${n}` : '-'}</td>`; }).join('')}</tr>`).join('');
  const pastT = `<div class="card scroll"><h2>過去問(直近の正解数/回答数)</h2><table class="cmp"><thead><tr>${th}</tr></thead><tbody>${pRows}</tbody></table></div>`;
  box.innerHTML = sum + chap + pastT + `<button class="btn sec" data-act="cmp-reload">↻ 最新の状態に更新</button>`;
}

// ---------- イベント ----------
document.addEventListener('click', async ev => {
  const t = ev.target.closest('[data-act]'); if (!t) return;
  const act = t.dataset.act;
  if (act === 'rename') {
    ev.stopPropagation(); const u = t.dataset.u;
    const v = prompt('表示名を入力(20文字まで)', uname(u)); if (v && v.trim()) { names[u] = v.trim().slice(0, 20); lsSet('quiz:names', names); render(); pushNames(u); }
    return;
  }
  if (act === 'pick-user') {
    S.user = t.dataset.u; lsSet('quiz:user', S.user);
    for (const s of Object.keys(SUBJ)) await pullCloud(S.user, s);
    pushNames(S.user); go('home'); return;
  }
  if (act === 'switch-user') { if (S.sess?.cur && !S.sess.shown && !confirm('出題を中断してユーザーを切り替えますか?')) return; go('users'); return; }
  if (act === 'subject') { S.subject = t.dataset.s; S.setup = null; await pullCloud(S.user, S.subject); go('menu'); return; }
  if (act === 'bug-start') { S.bugMode = t.dataset.m; S.bq = { order: shuffleArr(bugs.filter(inPool).map(b => b.id)), i: 0, n: 1, reveal: false }; return go('bugQ'); }
  if (act === 'bug-next') { S.bq.n++; return render(); }
  if (act === 'bug-reveal') { S.bq.reveal = true; return render(); }
  if (act === 'bug-grade') { const ok = t.dataset.v === '1'; S.bq.graded = ok; recordPast('bug-' + S.bq.order[S.bq.i], ok); return render(); }
  if (act === 'bug-nextq') { const q = S.bq; if (q.i + 1 >= q.order.length) { S.bq = null; return go('menu'); } q.i++; q.n = 1; q.reveal = false; q.graded = undefined; return go('bugQ'); }
  if (act === 'bug-list') { S.bugMode = 'all'; return go('bugList'); }
  if (act === 'bug-open') { S.bugBack = S.route === 'bugDetail' ? S.bugBack : S.route; S.bugId = t.dataset.id; return go('bugDetail'); }
  if (act === 'back') {
    if (t.dataset.to === 'bugBack') { const to = S.bugBack || 'bugList'; return go(to); }
    const to = t.dataset.to;
    if (to === 'quit') { if (S.sess && S.sess.queue.length + (S.sess.shown ? 0 : 1) > 0 && !confirm('出題を終了しますか?(ここまでの記録は保存されています)')) return; S.sess = null; return go('menu'); }
    if (to === 'home') S.subject = null;
    return go(to);
  }
  if (act === 'setup') { S.setup ??= { scope: 'all', chs: [], mode: 'continue' }; return go('setup'); }
  if (act === 'scope') { S.setup.scope = t.value; return render(); }
  if (act === 'mode') { S.setup.mode = t.value; return render(); }
  if (act === 'ch') { const v = t.value, a = S.setup.chs; if (t.checked) a.push(v); else a.splice(a.indexOf(v), 1); return render(); }
  if (act === 'start') return startSession();
  if (act === 'opt') {
    const i = +t.dataset.i;
    if (S.route === 'play') { const q = findQ(S.sess.cur); toggleSel(q, S.sess.sel, i); }
    else { const e = curExam(), q = e.qs[S.exam.i]; S.exam.sel[q.id] ??= []; toggleSel(q, S.exam.sel[q.id], i); }
    return render();
  }
  if (act === 'answer') return answerCurrent(false);
  if (act === 'dontknow') { S.sess.sel = []; return answerCurrent(true); }
  if (act === 'next') return nextQuestion();
  if (act === 'past-list') return go('pastList');
  if (act === 'open-exam') { S.exam = { id: t.dataset.e, i: 0, sel: {}, shown: {} }; for (const k in ORD) delete ORD[k]; return go('pastQ'); }
  if (act === 'goto') { S.exam.i = +t.dataset.i; return render(); }
  if (act === 'prevq') { S.exam.i--; return render(); }
  if (act === 'nextq') { S.exam.i++; window.scrollTo(0, 0); return render(); }
  if (act === 'past-answer') {
    const e = curExam(), q = e.qs[S.exam.i], sel = S.exam.sel[q.id] || [], ok = judge(q, sel);
    S.exam.shown[q.id] = { ok }; recordPast(q.id, ok); return render();
  }
  if (act === 'compare') { S.cmpSubject = t.dataset.s || S.subject; return go('compare'); }
  if (act === 'cmp-subj') { S.cmpSubject = t.dataset.s; return render(); }
  if (act === 'cmp-reload') { document.getElementById('cmp').innerHTML = '<p class="note">更新中…</p>'; return loadCompare(); }
});
function toggleSel(q, sel, i) {
  const single = q.kind !== 'multiany' && q.ans.length === 1;
  const at = sel.indexOf(i);
  if (single) { sel.length = 0; sel.push(i); return; }
  if (at >= 0) sel.splice(at, 1); else sel.push(i);
}
document.addEventListener('keydown', ev => { if ((ev.key === 'Enter' || ev.key === ' ') && ev.target.matches?.('[data-act="pick-user"]')) { ev.preventDefault(); ev.target.click(); } });

// ---------- 起動 ----------
async function boot() {
  try {
    [bank, past] = await Promise.all([fetch('data/bank.json?v=9').then(r => r.json()), fetch('data/past.json?v=9').then(r => r.json())]);
    try { bugs = await fetch('data/bugs.json?v=9').then(r => r.json()); for (const b of bugs) bugById[b.id] = b; } catch (e) { bugs = []; }
  } catch (e) { $app.innerHTML = '<p class="boot">問題データを読み込めませんでした。通信を確認して再読み込みしてください。</p>'; return; }
  for (const s of Object.keys(bank)) { for (const q of bank[s].qs) qById[q.id] = q; }
  render();
  initCloud();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => { });
  if (S.user && USER_IDS.includes(S.user)) go('home'); else go('users');
}
boot();
