/*
 * 推し活チェッカー 本体
 *
 * データの流れ：
 *   data/data.json（GitHub Actionsが1日2回作る）＋ config/programs.json（第何回の設定）
 *     → 放送1件ずつの「broadcast」に整える
 *     → 同じ回（例：夢カラ第6回のMX版とBS日テレ版）を1つの「content」にまとめる
 *     → 今日／この先7日／今見られる／期限切れ に振り分けて表示
 *
 * 見た・見ないの記録はこのiPhoneの中（localStorage）に保存する。
 */
'use strict';

const DAY = 86400000;
const STORE_KEY = 'oshi.v1';
const MEDIUMS = [
  { key: 'all', label: 'すべて' },
  { key: 'tv', label: 'テレビ' },
  { key: 'radio', label: 'ラジオ' },
  { key: 'stream', label: '配信' },   // 配信には SHOWROOM などの生配信（live）も含める
  { key: 'magazine', label: '雑誌' },
];
const EVENT_KINDS = [
  { key: 'all', label: 'すべて' },
  { key: 'live', label: 'ライブ' },
  { key: 'real', label: 'リアル' },
  { key: 'online', label: 'オンライン' },
  { key: 'ticket', label: 'チケット' },
  { key: 'release', label: 'リリース' },
];
const KIND_NAME = { live: 'ライブ・公演', real: 'リアル', online: 'オンライン', ticket: 'チケット', release: 'リリース', other: 'イベント' };
const MEDIUM_NAME = { tv: 'テレビ', radio: 'ラジオ', stream: '配信', live: '生配信', magazine: '雑誌', other: 'その他' };
const WD = ['日', '月', '火', '水', '木', '金', '土'];

/* ================= 保存 ================= */
const store = loadStore();
function loadStore() {
  const base = { status: {}, history: [], settings: { autoHideExpired: false, warnDays: 2 }, ui: { group: 'all', member: 'all', medium: 'all', tab: 'today' } };
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    if (s) return { ...base, ...s, settings: { ...base.settings, ...s.settings }, ui: { ...base.ui, ...s.ui } };
  } catch (e) { /* 壊れていたら初期値 */ }
  return base;
}
function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(store)); } catch (e) { /* 容量不足などは無視 */ }
}

/* ================= 時刻の扱い ================= */
// 日本時間の「日付」を表す数値（その日の0時JST のミリ秒）
function jstMidnight(ms) { const t = ms + 9 * 3600000; return t - (t % DAY) - 9 * 3600000; }
// テレビ表記に合わせ、0〜4時台は前日扱い（25:30 など）
function tvDay(b) { return b.allDay ? b.dayMs : jstMidnight(b.start - 5 * 3600000); }
function jst(ms) { return new Date(ms + 9 * 3600000); } // getUTC〜 で日本時間の値が取れる
function fmtDay(dayMs) {
  const d = jst(dayMs);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}（${WD[d.getUTCDay()]}）`;
}
function fmtTime(b) {
  if (b.allDay) return '終日';
  const d = jst(b.start), day = tvDay(b);
  const h = d.getUTCHours() + (jstMidnight(b.start) > day ? 24 : 0);
  return `${h}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

/* ================= データの整形 ================= */
let DATA = null, PROGRAMS = [], CONTENTS = [], BYKEY = new Map();

function build(data, programs) {
  const bs = data.items.map(it => {
    const dayMs = Date.parse(it.date + 'T00:00:00+09:00');
    const allDay = !it.start;
    const b = { ...it, allDay, dayMs, start: it.start || dayMs, end: it.end || dayMs + DAY };
    b.tv = tvDay(b);
    return b;
  }).sort((a, b) => a.start - b.start);

  // 同じ回をまとめる
  const contents = [];
  const norm = s => (s || '').replace(/[\s　「」『』]/g, '');
  for (const b of bs) {
    const prog = programs.find(p => (b.program || '').includes(p.match) || (b.title || '').includes(p.match));
    let key, label;
    if (prog) {
      const ep = episodeOf(prog, b.tv);
      key = `${b.group}|${prog.match}|${ep}`;
      label = `${prog.label} 第${ep}回${prog.total ? `（全${prog.total}回）` : ''}`;
    } else {
      // 番組名が同じで、放送局が違い、6日以内なら同じ内容（例：日テレと読売の同じ特番）
      const twin = contents.find(c => c.group === b.group && !c.prog && norm(c.program) === norm(b.program)
        && Math.abs(c.first.tv - b.tv) < 6 * DAY && !c.broadcasts.some(x => x.station === b.station));
      if (twin) { twin.broadcasts.push(b); b.key = twin.key; continue; }
      key = b.id;
      label = b.program || b.title;
    }
    let c = contents.find(x => x.key === key);
    if (!c) { c = { key, label, prog, group: b.group, program: b.program, broadcasts: [], first: b }; contents.push(c); }
    c.broadcasts.push(b);
    b.key = key;
  }
  for (const c of contents) finishContent(c);
  return contents;
}

function episodeOf(prog, day) {
  const first = Date.parse(prog.first + 'T00:00:00+09:00');
  let n = Math.floor((day - first) / (7 * DAY)) + 1;
  for (const s of prog.skips || []) if (Date.parse(s + 'T00:00:00+09:00') <= day) n--;
  return Math.max(1, n);
}

/** まとめた内容ごとに、出演・媒体・見逃し期限を決める */
function finishContent(c) {
  const bs = c.broadcasts;
  c.first = bs[0];
  c.medium = bs[0].medium;
  c.members = [...new Set(bs.flatMap(b => b.members))];
  c.castTBD = bs.some(b => b.castTBD);
  c.stations = [...new Set(bs.map(b => b.station).filter(Boolean))];
  // 期限：放送ごとに計算する。期限なしの放送（配信など）が1つでもあれば期限なし、そうでなければ一番遅いもの
  const ds = bs.map(deadlineOf);
  c.deadline = ds.find(d => d.at === null) || ds.reduce((a, d) => (d.at > a.at ? d : a));
}

/**
 * 見逃し期限のルール
 *  - 公式に「1週間」などの記載 → その日数
 *  - SHOWROOM・ニコ生などの生配信 → 放送終了で期限切れ（アーカイブ記載があれば7日）
 *  - テレビ → 7日（TVerを想定。公式に記載が無ければ「目安」と表示）
 *  - ラジオ → 7日（radikoのタイムフリー）
 *  - 雑誌 → 発売から30日
 *  - その他の配信（YouTube・Prime Video など）→ 期限なし
 */
function deadlineOf(b) {
  const v = b.vod || {};
  if (v.days) return { at: b.end + v.days * DAY, kind: 'stated' };
  switch (b.medium) {
    case 'live': return v.archive ? { at: b.end + 7 * DAY, kind: 'assumed' } : { at: b.end, kind: 'live' };
    case 'tv': return { at: b.end + 7 * DAY, kind: v.stated ? 'assumed' : 'unknown' };
    case 'radio': return { at: b.end + 7 * DAY, kind: 'assumed' };
    case 'magazine': return { at: b.dayMs + 30 * DAY, kind: 'assumed' };
    default: return { at: null, kind: 'none' };
  }
}

/* ================= 絞り込み ================= */
function memberGroupOf(name) {
  for (const g of Object.keys(DATA.members)) if (DATA.members[g].some(m => m.name === name)) return g;
  return null;
}
function matchMember(c) {
  const m = store.ui.member;
  if (m === 'all') return true;
  // 名前が出ている回か、そのメンバーのグループ全体・出演者未定の回（グループ出演も「出ている」に数える）
  return c.members.includes(m) || (c.members.length === 0 && c.group === memberGroupOf(m));
}
function matchMedium(c) {
  const m = store.ui.medium;
  if (m === 'all') return true;
  if (m === 'stream') return c.medium === 'stream' || c.medium === 'live';
  return c.medium === m;
}
function visibleContents() {
  const g = store.ui.group;
  return CONTENTS.filter(c => (g === 'all' || c.group === g) && matchMember(c) && matchMedium(c));
}

/* ================= 描画 ================= */
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
function tintOf(g) { return `var(--${g})`; }
const LOGO = k => `logos/${k}.png`;
function logoImg(k, cls = '') { return `<img src="${LOGO(k)}" alt="" class="${cls}" loading="lazy">`; }

/** 背景の飾り：選んだグループの色とロゴ。全グループなら3色 */
function renderDecor() {
  const g = store.ui.group;
  const keys = g === 'all' ? ['il', 'nm', 'nj'] : [g];
  const pos = keys.length === 1
    ? [{ x: 62, y: 58, s: 92, r: -14 }]
    : [{ x: -6, y: 18, s: 46, r: -16 }, { x: 58, y: 44, s: 50, r: 10 }, { x: 4, y: 72, s: 48, r: 8 }];
  const blobs = (keys.length === 1 ? [keys[0], keys[0]] : keys).map((k, i) =>
    `<span class="blob" style="background:var(--${k});width:${60 + i * 10}vw;height:${60 + i * 10}vw;left:${[ -25, 45, 5 ][i]}vw;top:${[ -12, 35, 70 ][i]}vh"></span>`).join('');
  const marks = keys.map((k, i) => `<img class="mark" src="${LOGO(k)}" alt="" style="left:${pos[i].x}vw;top:${pos[i].y}vh;width:${pos[i].s}vw;transform:rotate(${pos[i].r}deg)">`).join('');
  const html = blobs + marks;
  if ($('decor').dataset.k !== g) { $('decor').innerHTML = html; $('decor').dataset.k = g; }
}

function render() {
  if (!DATA) return;
  const now = Date.now();
  const today = jstMidnight(now - 5 * 3600000);
  document.documentElement.style.setProperty('--tint', store.ui.group === 'all' ? 'var(--label2)' : tintOf(store.ui.group));

  const u = jst(DATA.updatedAt);
  const stamp = `${u.getUTCMonth() + 1}/${u.getUTCDate()} ${u.getUTCHours()}:${String(u.getUTCMinutes()).padStart(2, '0')}`;
  // 26時間以上更新されていなければ、古いことを文字で知らせる（アラートは出さない）
  const stale = now - DATA.updatedAt > 26 * 3600000;
  $('updated').textContent = stale ? `最新に更新できていない（${stamp}時点）` : `${stamp} 更新`;
  $('updated').classList.toggle('stale', stale);
  $('title').textContent = { today: '今日', vod: '見逃し', events: 'イベント', guide: 'ガイド' }[store.ui.tab] || '今日';
  renderTabs();
  renderDecor();

  // データがまだ無いグループ（≒JOY）は、タブは押せるようにして理由を出す（HIG：タブを無効にしない）
  if (store.ui.tab === 'guide') { for (const b of document.querySelectorAll('#tabbar button')) b.setAttribute('aria-selected', String(b.dataset.tab === store.ui.tab)); renderGuide(now); return; }
  if (store.ui.group !== 'all' && !DATA.groups.some(g => g.key === store.ui.group)) {
    renderTabs(); renderDecor();
    $('main').innerHTML = `<div class="empty-art" style="padding-top:48px">${logoImg('nj')}<span>≒JOYはまだ公式サイトの情報を読み込んでいない。<br>公式サイトのURLを設定すると、ここに表示される。</span></div>`;
    $('vodBadge').hidden = true;
    for (const b of document.querySelectorAll('#tabbar button')) b.setAttribute('aria-selected', String(b.dataset.tab === store.ui.tab));
    return;
  }
  const cs = visibleContents();
  const vod = vodLists(cs, now, today);
  // 下のタブ（見逃しには未消化の件数を表示）
  for (const b of document.querySelectorAll('#tabbar button')) b.setAttribute('aria-selected', String(b.dataset.tab === store.ui.tab));
  // バッジは期限が近いものの件数だけ（全部の未消化を出すと意味が薄れる）
  const urgent = vod.avail.filter(c => !store.status[c.key] && c.deadline.at !== null && c.deadline.at - now <= store.settings.warnDays * DAY).length;
  $('vodBadge').textContent = urgent || '';
  $('vodBadge').hidden = !urgent;
  $('vodBadge').setAttribute('aria-label', `期限が近いもの${urgent}件`);

  if (store.ui.tab === 'vod') renderVod(vod, now);
  else if (store.ui.tab === 'events') renderEvents(now, today);
  else renderToday(cs, now, today);
}

/** 放送1件ずつの一覧（見ないにしたものは出さない） */
function broadcastsOn(cs, day) {
  const out = [];
  for (const c of cs) {
    if (store.status[c.key] === 'skip') continue;
    for (const b of c.broadcasts) if (b.tv === day) out.push([c, b]);
  }
  return out.sort((a, b) => a[1].start - b[1].start);
}

/** 見逃し：今見られる／期限切れ（内容ごと。今日以降にも放送があるものは除く） */
function vodLists(cs, now, today) {
  const past = cs.filter(c => (!store.status[c.key] || (store.status[c.key] === 'seen' && keepSeen.has(c.key))) && c.first.start <= now && !c.broadcasts.some(b => b.tv >= today));
  const avail = past.filter(c => c.deadline.at === null || c.deadline.at > now)
    .sort((a, b) => (a.deadline.at ?? Infinity) - (b.deadline.at ?? Infinity) || b.first.start - a.first.start);
  const expired = store.settings.autoHideExpired ? [] : past.filter(c => c.deadline.at !== null && c.deadline.at <= now)
    .sort((a, b) => b.first.start - a.first.start);
  return { avail, expired };
}

function renderToday(cs, now, today) {
  const list = broadcastsOn(cs, today);
  let h = sectionHead(fmtDay(today), list.length);
  h += list.length ? list.map(([c, b]) => row(c, b, now)).join('') : emptyArt('今日の出演はない');
  h += calendarHtml(cs, now, today); // 今日の下にカレンダー
  $('main').innerHTML = h;
}

function renderVod({ avail, expired }, now) {
  let h = sectionHead('今見られる', avail.length);
  h += avail.length ? avail.map(c => row(c, null, now)).join('') : emptyArt('未消化はない。全部追えてる');
  if (expired.length) {
    // 期限切れは最初は閉じておく（何が入っているかは見出しで分かる）
    h += `<details class="fold"${store.ui.expiredOpen ? ' open' : ''} id="expFold"><summary class="section-h"><span class="chev" aria-hidden="true">›</span><h2>期限切れ</h2><span class="count">${expired.length}件</span></summary>`;
    h += expired.map(c => row(c, null, now, true)).join('') + '</details>';
  }
  $('main').innerHTML = h;
  const f = $('expFold'); if (f) f.addEventListener('toggle', () => { store.ui.expiredOpen = f.open; save(); });
}

/** カレンダー：月の表＋選んだ日の一覧（最初は明日を選んだ状態） */
function calendarHtml(cs, now, today) {
  const t = jst(today);
  if (!store.ui.calMonth) store.ui.calMonth = `${t.getUTCFullYear()}-${t.getUTCMonth() + 1}`;
  if (!store.ui.calDay) store.ui.calDay = today + DAY;
  const [y, m] = store.ui.calMonth.split('-').map(Number);
  const first = Date.parse(`${y}-${String(m).padStart(2, '0')}-01T00:00:00+09:00`);
  const startDow = jst(first).getUTCDay();
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const gridStart = first - startDow * DAY;
  const weeks = Math.ceil((startDow + daysInMonth) / 7);

  // 日ごとの件数とグループ
  const byDay = new Map();
  for (const c of cs) {
    if (store.status[c.key] === 'skip') continue;
    for (const b of c.broadcasts) {
      const e = byDay.get(b.tv) || { n: 0, groups: new Set() };
      e.n++; e.groups.add(c.group); byDay.set(b.tv, e);
    }
  }

  let h = `<div class="section-h"><h2>カレンダー</h2></div><div class="cal">
    <div class="cal-head">
      <button class="iconbtn" data-cal="-1" aria-label="前の月">‹</button>
      <h2>${y}年${m}月</h2>
      <button class="iconbtn" data-cal="1" aria-label="次の月">›</button>
    </div>
    <div class="cal-grid" role="grid">${WD.map((w, i) => `<div class="dow${i === 0 ? ' sun' : i === 6 ? ' sat' : ''}">${w}</div>`).join('')}`;
  for (let i = 0; i < weeks * 7; i++) {
    const day = gridStart + i * DAY;
    const d = jst(day);
    const inMonth = d.getUTCMonth() + 1 === m;
    const e = byDay.get(day);
    const dots = e ? [...e.groups].slice(0, 3).map(g => `<i style="background:var(--${g})"></i>`).join('') : '';
    const cls = ['day', inMonth ? '' : 'out', day === today ? 'today' : '', day === store.ui.calDay ? 'sel' : ''].filter(Boolean).join(' ');
    h += `<button class="${cls}" data-day="${day}" aria-label="${d.getUTCMonth() + 1}月${d.getUTCDate()}日 ${e ? e.n + '件' : '予定なし'}" aria-pressed="${day === store.ui.calDay}">
      <span class="num">${d.getUTCDate()}</span><span class="dots">${dots}${e && e.n > 3 ? '<b>+</b>' : ''}</span></button>`;
  }
  h += '</div></div>';

  const list = broadcastsOn(cs, store.ui.calDay);
  h += sectionHead(fmtDay(store.ui.calDay) + (store.ui.calDay === today ? '（今日）' : ''), list.length);
  h += list.length ? list.map(([c, b]) => row(c, b, now)).join('') : '<p class="empty">この日の出演はない</p>';
  return h;
}

function emptyArt(text) {
  const k = store.ui.group === 'all' ? ['il', 'nm', 'nj'][new Date().getDate() % 3] : store.ui.group;
  return `<div class="empty-art">${logoImg(k)}<span>${esc(text)}</span></div>`;
}
function sectionHead(title, n, raw) {
  return `<div class="section-h"><h2>${esc(title)}</h2><span class="count">${raw ? esc(n) : n + '件'}</span></div>`;
}

function renderTabs() {
  // グループ（先頭に「全グループ」）
  const groups = [{ key: 'all', name: '全グループ' }, ...DATA.groups,
    ...(DATA.groups.some(g => g.key === 'nj') ? [] : [{ key: 'nj', name: '≒JOY' }])];
  $('groupTabs').innerHTML = groups
    .map(g => `<button role="tab" data-group="${g.key}" aria-selected="${store.ui.group === g.key}">${g.key === 'all'
      ? `<span class="glogos trio">${logoImg('il')}${logoImg('nm')}${logoImg('nj')}</span>`
      : `<span class="glogos">${logoImg(g.key)}</span>`}<span>${esc(g.name)}</span></button>`).join('');
  // メンバー・媒体のボタン（今の選択を見せる）
  const m = store.ui.member;
  $('memberPicker').innerHTML = `<span class="pk-label">メンバー</span><span class="pk-val">${esc(m === 'all' ? '全員' : m)}</span>${CHEV}`;
  const isEv = store.ui.tab === 'events';
  const fv = isEv ? (EVENT_KINDS.find(k => k.key === (store.ui.ekind || 'all')) || EVENT_KINDS[0]).label
                  : (MEDIUMS.find(k => k.key === store.ui.medium) || MEDIUMS[0]).label;
  $('filterPicker').innerHTML = `<span class="pk-label">${isEv ? '種類' : '媒体'}</span><span class="pk-val">${esc(fv)}</span>${CHEV}`;
}
const CHEV = '<svg class="pk-chev" viewBox="0 0 12 16" aria-hidden="true"><path d="M3 6l3-3 3 3M3 10l3 3 3-3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/* ================= イベント（予定があることを知るだけ。チェックはしない） ================= */
function fmtHM(ms) { const d = jst(ms); return `${d.getUTCHours()}:${String(d.getUTCMinutes()).padStart(2, '0')}`; }
function fmtDayTime(ms) { return `${fmtDay(jstMidnight(ms))} ${fmtHM(ms)}`; }

function eventMatches(e) {
  const g = store.ui.group, m = store.ui.member;
  if (g !== 'all' && e.group !== g) return false;
  if (m !== 'all' && !(e.members || []).includes(m) && !((e.members || []).length === 0 && e.group === memberGroupOf(m))) return false;
  return true;
}

/** 毎日ページが分かれている舞台などを、連続する日付ごとに1件にまとめる */
function mergeEvents(list) {
  const out = [];
  const norm = s => s.replace(/[\s　]/g, '');
  for (const e of list) {
    const day = Date.parse(e.date + 'T00:00:00+09:00');
    const prev = out.find(x => x.group === e.group && norm(x.title) === norm(e.title) && day - x.lastDay <= DAY && day > x.lastDay);
    if (prev) { prev.lastDay = day; continue; }
    out.push({ ...e, day, lastDay: day });
  }
  return out;
}

function renderEvents(now, today) {
  const kind = store.ui.ekind || 'all';
  let h = '';
  // チケット
  if (kind === 'all' || kind === 'ticket') {
    const ts = (DATA.tickets || []).filter(eventMatches);
    const open = [], soon = [];
    for (const t of ts) {
      const cur = t.phases.find(p => p.start <= now && p.end > now);
      const next = t.phases.find(p => p.start > now);
      if (cur) open.push({ t, p: cur }); else if (next) soon.push({ t, p: next });
    }
    open.sort((a, b) => a.p.end - b.p.end);
    soon.sort((a, b) => a.p.start - b.p.start);
    h += sectionHead('チケット受付中', open.length);
    h += open.length ? open.map(({ t, p }) => eventCard({
      group: t.group, url: t.url, kindLabel: 'チケット', title: t.title,
      meta: `${p.label ? esc(p.label) + '・' : ''}締切 ${fmtDayTime(p.end)}`, due: ticketDue(p.end, now),
    })).join('') : '<p class="empty">受付中のものはない</p>';
    if (soon.length) {
      h += sectionHead('受付予定', soon.length);
      h += soon.map(({ t, p }) => eventCard({
        group: t.group, url: t.url, kindLabel: 'チケット', title: t.title,
        meta: `${p.label ? esc(p.label) + '・' : ''}${fmtDayTime(p.start)} 開始`,
      })).join('');
    }
  }
  // 予定
  if (kind !== 'ticket') {
    const evs = mergeEvents((DATA.events || []).filter(e => eventMatches(e) && (kind === 'all' || e.kind === kind)))
      .filter(e => e.lastDay >= today);
    h += sectionHead('これからの予定', evs.length);
    let last = null;
    for (const e of evs) {
      const d = Math.max(e.day, today);
      if (d !== last) { h += `<div class="day-h">${fmtDay(d)}${d === today ? '（今日）' : ''}</div>`; last = d; }
      const when = e.lastDay > e.day ? `${fmtDay(e.day)}〜${fmtDay(e.lastDay)}` : (e.start ? `${fmtHM(e.start)}〜` : '終日');
      h += eventCard({ group: e.group, url: e.url, kindLabel: KIND_NAME[e.kind] || 'イベント', title: e.title,
        meta: `<b>${when}</b>${e.venue ? `<span>${esc(e.venue)}</span>` : ''}` });
    }
    if (!evs.length) h += '<p class="empty">予定はない</p>';
  }
  $('main').innerHTML = h;
}

function ticketDue(end, now) {
  const left = end - now;
  const soon = left <= store.settings.warnDays * DAY;
  const text = left < DAY ? `残り${Math.max(1, Math.ceil(left / 3600000))}時間` : `残り${Math.ceil(left / DAY)}日`;
  return `<span class="due${soon ? ' soon' : ''}">${text}</span>`;
}

function eventCard({ group, url, kindLabel, title, meta, due }) {
  return `<div class="row ev" data-url="${esc(url)}">
    <div class="card ev" style="--tint:${tintOf(group)}">
      <div class="body">
        <div class="meta">${store.ui.group === 'all' ? `<span class="gname">${logoImg(group)}${esc(groupName(group))}</span>` : ''}<span class="kind">${esc(kindLabel)}</span>${meta}</div>
        <div class="title">${esc(title)}</div>
        ${due ? `<div class="tags">${due}</div>` : ''}
      </div>
      <span class="chev" aria-hidden="true">›</span>
    </div></div>`;
}

/** 1行分。b があれば放送1件として、無ければ内容（まとめ）として出す */
function row(c, b, now, expired) {
  const status = store.status[c.key] || '';
  const bb = b || c.first;
  const stations = b ? b.station : c.stations.join(' / ');
  const meta = b
    ? `<b>${fmtTime(b)}</b><span>${esc(stations)}</span>`
    : `<b>${fmtDay(c.first.tv)}</b><span>${esc(stations)}</span>`;
  const g = c.group;
  const allMembers = (DATA.members[g] || []).length;
  let tags = '';
  if (c.castTBD) tags += '<span class="mem tbd">出演者未定</span>';
  else if (!c.members.length || (allMembers > 1 && c.members.length >= allMembers)) tags += '<span class="mem">グループ出演</span>';
  else tags += c.members.map(n => `<span class="mem">${esc(n)}</span>`).join('');
  tags += dueLabel(c, b, now);

  return `<div class="row" data-key="${esc(c.key)}" data-bid="${esc(bb.id)}">
    <div class="under"><button class="swipe-del" data-act="del" tabindex="-1">消す</button></div>
    <div class="card${expired ? ' expired' : ''}" data-status="${status}" style="--tint:${tintOf(g)};--soft:var(--${g}-soft)">
      <button class="chk" role="checkbox" aria-checked="${status === 'seen'}" aria-label="見た" data-act="seen"><span>✓</span></button>
      <div class="body">
        <div class="meta">${store.ui.group === 'all' ? `<span class="gname">${logoImg(g)}${esc(groupName(g))}</span>` : ''}${meta}<span>${MEDIUM_NAME[c.medium] || ''}</span></div>
        <div class="title">${esc(c.label)}</div>
        <div class="tags">${tags}</div>
      </div>
      <button class="more" aria-label="その他の操作" data-act="menu">•••</button>
    </div>
  </div>`;
}

function groupName(k) { return (DATA.groups.find(g => g.key === k) || {}).name || k; }

function dueLabel(c, b, now) {
  if (b && b.start > now) return ''; // まだ放送前
  const d = c.deadline;
  if (d.kind === 'none' || d.at === null) return '<span class="due">期限なし</span>';
  if (d.at <= now) return '<span class="due">期限切れ</span>';
  const left = d.at - now;
  const days = Math.ceil(left / DAY);
  const soon = left <= store.settings.warnDays * DAY;
  let text;
  if (d.kind === 'live') text = '放送中のみ';
  else if (left < DAY) text = `残り${Math.max(1, Math.ceil(left / 3600000))}時間`;
  else text = `残り${days}日`;
  if (d.kind === 'unknown') text += '（見逃し不明・目安）';
  else if (d.kind === 'assumed' && c.medium === 'tv') text += '（目安）';
  return `<span class="due${soon ? ' soon' : ''}">${text}</span>`;
}

/* ================= ガイド（公式リンクとレギュラー番組） ================= */
const OFFICIAL = [
  { g: 'il', name: '＝LOVE', site: 'https://equal-love.jp/', yt: 'https://www.youtube.com/@equallove_' },
  { g: 'nm', name: '≠ME', site: 'https://not-equal-me.jp/', yt: 'https://www.youtube.com/@notequalme6632' },
  { g: 'nj', name: '≒JOY', site: 'https://nearly-equal-joy.jp/', yt: 'https://www.youtube.com/channel/UC_qmQbqvW6UES3NT780l2Pg' },
];
const IKONOIJOY_CH = 'https://www.youtube.com/@ikonoijoy';
const YT_MARK = '<svg class="yt" viewBox="0 0 28 20" aria-hidden="true"><rect width="28" height="20" rx="6" fill="#FF0000"/><path d="M11 5.5v9l8-4.5z" fill="#fff"/></svg>';

/** 見られる場所（配信サービス）。re：説明文や放送局名にこの言葉があれば、そこで見られるとみなす */
/** 背景色に対して読みやすい文字色（白か黒）を選ぶ */
function onColor(hex) {
  const c = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(x => x <= .03928 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4);
  const L = .2126 * c[0] + .7152 * c[1] + .0722 * c[2];
  return (1.05 / (L + .05)) >= ((L + .05) / .05) ? '#fff' : '#000';
}
const SERVICES = [
  { key: 'tver', name: 'TVer', home: 'https://tver.jp/', re: /TVer/i, host: /tver\.jp/, color: '#1FA0E0' },
  { key: 'nhk', name: 'NHKプラス', home: 'https://plus.nhk.jp/', re: /NHKプラス|NHK\+/, host: /plus\.nhk/, color: '#3D3D3D' },
  { key: 'fod', name: 'FOD', home: 'https://fod.fujitv.co.jp/', re: /FOD/, host: /fod\.fujitv/, color: '#E60012' },
  { key: 'telasa', name: 'TELASA', home: 'https://www.telasa.jp/', re: /TELASA|テラサ/i, host: /telasa/, color: '#7B3FE4' },
  { key: 'abema', name: 'ABEMA', home: 'https://abema.tv/', re: /ABEMA/i, host: /abema/, color: '#2B2B2B' },
  { key: 'prime', name: 'Prime Video', home: 'https://www.amazon.co.jp/primevideo', re: /Prime\s*Video|プライムビデオ/i, host: /primevideo|amazon\.co\.jp\/.*video/, color: '#1A98FF' },
  { key: 'unext', name: 'U-NEXT', home: 'https://video.unext.jp/', re: /U-NEXT/i, host: /unext/, color: '#1B1B1B' },
  { key: 'lemino', name: 'Lemino', home: 'https://lemino.docomo.ne.jp/', re: /Lemino/i, host: /lemino/, color: '#1E1E1E' },
  { key: 'hulu', name: 'Hulu', home: 'https://www.hulu.jp/', re: /Hulu/i, host: /hulu\.jp/, color: '#1CE783' },
  { key: 'radiko', name: 'radiko', home: 'https://radiko.jp/', re: /radiko|ラジコ/i, host: /radiko/, color: '#00A7E1' },
  { key: 'showroom', name: 'SHOWROOM', home: 'https://www.showroom-live.com/', re: /SHOWROOM/i, host: /showroom/, color: '#FF3366' },
  { key: 'nico', name: 'ニコニコ', home: 'https://www.nicovideo.jp/', re: /ニコニコ|ニコ生/, host: /nicochannel|nicovideo|nico\.ms/, color: '#252525' },
  { key: 'youtube', name: 'YouTube', home: 'https://www.youtube.com/', re: /YouTube/i, host: /youtube|youtu\.be/, color: '#FF0000' },
  { key: 'mellow', name: 'mellow-fan', home: 'https://www.mellow-fan.com/', re: /mellow-fan/i, host: /mellow-fan/, color: '#F08CB4' },
  { key: 'artistspoken', name: 'Artistspoken', home: 'https://artistspoken.com/', re: /Artistspoken/i, host: /artistspoken/, color: '#444444' },
  { key: 'netflix', name: 'Netflix', home: 'https://www.netflix.com/jp/', re: /Netflix/i, host: /netflix/, color: '#E50914' },
];

/** 番組（まとめたもの）がどのサービスで見られるかと、そのサービス内の番組ページ */
function servicesOf(r) {
  const text = r.items.map(b => `${b.station}\n${b.title}\n${b.excerpt}`).join('\n');
  const urls = [...text.matchAll(/https?:\/\/[^\s<>」）)]+/g)].map(m => m[0]);
  const out = [];
  for (const sv of SERVICES) {
    const hit = sv.re.test(text) || urls.some(u => sv.host.test(u)) || (sv.key === 'radiko' && r.medium === 'radio');
    if (!hit) continue;
    out.push({ ...sv, url: urls.find(u => sv.host.test(u)) || null, assumed: sv.key === 'radiko' && !sv.re.test(text) });
  }
  return out;
}

/** 説明文からリンクを拾う（番組HP・TVer・radiko など）。SNSは後ろに回す */
function linksIn(text) {
  const out = [], seen = new Set();
  for (const m of (text || '').matchAll(/(?:([^\n：:▶]{1,16})[：:]\s*)?(https?:\/\/[^\s<>」）)]+)/g)) {
    const url = m[2].replace(/[、。]+$/, '');
    if (seen.has(url)) continue; seen.add(url);
    const host = url.replace(/^https?:\/\/(www\.)?/, '').split('/')[0];
    let label = (m[1] || '').replace(/^[・\s【]+|[】\s]+$/g, '').trim();
    const known = [[/tver\.jp/, 'TVer'], [/radiko/, 'radiko'], [/showroom/, 'SHOWROOM'], [/youtube|youtu\.be/, 'YouTube'], [/fod\.fujitv/, 'FOD'],
      [/nicochannel|nicovideo/, 'ニコニコ'], [/mellow-fan/, 'mellow-fan'], [/abema/, 'ABEMA'], [/telasa/, 'TELASA'], [/x\.com|twitter/, 'X'],
      [/instagram/, 'Instagram'], [/tiktok/, 'TikTok'], [/apps\.apple|play\.google/, 'アプリ']];
    const k = known.find(([re]) => re.test(host));
    if (k) label = k[1]; else if (!label || label.length > 10) label = '番組HP';
    if (/アプリ/.test(label)) continue;
    out.push({ label, url, sns: /^(X|Instagram|TikTok)$/.test(label) });
  }
  return out.sort((a, b) => a.sns - b.sns).slice(0, 4);
}

/** 毎週・毎月の番組、または期間中に2回以上出てくる番組をレギュラーとみなしてまとめる */
function regulars(now) {
  const norm = s => (s || '').replace(/[\s　「」『』]/g, '');
  const map = new Map();
  for (const b of DATA.items) {
    const key = b.group + '|' + norm(b.program || b.title);
    let r = map.get(key);
    if (!r) { r = { key, group: b.group, program: b.program || b.title, items: [], stations: new Set(), members: new Set(), castTBD: false, weekly: false }; map.set(key, r); }
    r.items.push(b);
    if (b.station) r.stations.add(b.station);
    b.members.forEach(m => r.members.add(m));
    if (b.castTBD) r.castTBD = true;
    if (/毎週|毎月|隔週|毎日/.test(b.excerpt || '')) r.weekly = true;
  }
  const list = [];
  for (const r of map.values()) {
    // 同じ特番の別局放送（数日違い）はレギュラーにしない：初回と最後が6日以上離れているか、毎週などの記載があるもの
    const ds = r.items.map(b => Date.parse(b.date + 'T00:00:00+09:00'));
    if (!r.weekly && Math.max(...ds) - Math.min(...ds) < 6 * DAY) continue;
    r.items.sort((a, b) => (a.start || 0) - (b.start || 0));
    const last = r.items[r.items.length - 1];
    r.next = r.items.find(b => (b.start || Date.parse(b.date + 'T00:00:00+09:00')) > now) || null;
    r.latest = [...r.items].reverse().find(b => (b.start || 0) <= now) || last;
    const sched = (last.excerpt || '').match(/(毎週|毎月|隔週|毎日)[^\n]*/);
    r.schedule = sched ? sched[0].replace(/[【】]/g, '').slice(0, 28) : '';
    r.medium = last.medium;
    r.links = linksIn(r.items.map(b => b.excerpt).join('\n'));
    r.url = last.url;
    list.push(r);
  }
  return list;
}

function guideLinkCard(href, inner, g, cls = '') {
  return `<a class="glink ${cls}" href="${esc(href)}" target="_blank" rel="noopener" style="--soft:var(--${g}-soft);--tint:var(--${g})">${inner}</a>`;
}

function renderGuide(now) {
  let h = `<div class="section-h"><h2>公式サイト</h2></div><div class="ggrid">`;
  h += OFFICIAL.map(o => guideLinkCard(o.site, `${logoImg(o.g, 'gl-logo')}<span class="gl-name">${esc(o.name)}</span><span class="gl-sub">${esc(o.site.replace(/^https:\/\/|\/$/g, ''))}</span>`, o.g)).join('');
  h += `</div><div class="section-h"><h2>YouTube</h2></div>`;
  h += guideLinkCard(IKONOIJOY_CH, `<img class="ch-logo" src="logos/ch.png" alt=""><span class="gl-name">いこのいじょいch</span><span class="gl-sub">イコラブ ノイミー ニアジョイ チャンネル</span>${YT_MARK}`, 'il', 'wide trio-bg');
  h += '<div class="ggrid">' + OFFICIAL.map(o => guideLinkCard(o.yt, `${logoImg(o.g, 'gl-logo')}<span class="gl-name">${esc(o.name)}</span><span class="gl-sub">公式チャンネル</span>${YT_MARK}`, o.g)).join('') + '</div>';

  // レギュラー番組（上のグループ・メンバー・媒体の絞り込みが効く）
  const g = store.ui.group, m = store.ui.member;
  const rs = regulars(now).filter(r => (g === 'all' || r.group === g)
      && (m === 'all' || r.members.has(m) || (r.members.size === 0 && r.group === memberGroupOf(m)))
      && (store.ui.medium === 'all' || r.medium === store.ui.medium || (store.ui.medium === 'stream' && r.medium === 'live')))
    .sort((a, b) => ((a.next && (a.next.start || 0)) || Infinity) - ((b.next && (b.next.start || 0)) || Infinity));
  // 配信サービスごとにまとめる（「ここではこれが見られる」）
  const bySv = new Map(), none = [];
  for (const r of rs) {
    const svs = servicesOf(r);
    if (!svs.length) none.push(r);
    for (const sv of svs) {
      if (!bySv.has(sv.key)) bySv.set(sv.key, { sv, list: [] });
      bySv.get(sv.key).list.push({ r, url: sv.url, assumed: sv.assumed });
    }
  }
  const order = SERVICES.map(x => x.key).filter(k => bySv.has(k));
  h += sectionHead('配信サービス', order.length ? `${order.length}サービス` : 0, true);
  const progRow = (r, url, home, note) => {
    const who = r.castTBD ? '出演者未定' : r.members.size ? [...r.members].join('、') : 'グループ出演';
    return `<a class="sv-row" href="${esc(url || home)}" target="_blank" rel="noopener">
      ${logoImg(r.group, 'sv-glogo')}
      <span class="sv-prog"><b>${esc(r.program)}</b><small>${esc([r.schedule || [...r.stations].join(' / '), who].filter(Boolean).join('・'))}${note ? `・${esc(note)}` : ''}</small></span>
      <span class="sv-go" aria-hidden="true">${url ? '›' : '↗'}</span></a>`;
  };
  for (const k of order) {
    const { sv, list } = bySv.get(k);
    h += `<section class="sv-card" style="--sv:${sv.color};--on-sv:${onColor(sv.color)}">
      <a class="sv-head" href="${esc(sv.home)}" target="_blank" rel="noopener"><span class="sv-badge">${esc(sv.name)}</span><span class="sv-count">${list.length}番組</span><span class="sv-open">開く ↗</span></a>
      ${list.map(({ r, url, assumed }) => progRow(r, url, sv.home, assumed ? 'タイムフリー（目安）' : '')).join('')}
    </section>`;
  }
  if (none.length) {
    h += `<section class="sv-card" style="--sv:var(--label2)"><div class="sv-head"><span class="sv-badge plain">放送のみ・配信情報なし</span><span class="sv-count">${none.length}番組</span></div>
      ${none.map(r => progRow(r, r.url, r.url, '')).join('')}</section>`;
  }
  if (!rs.length) h += emptyArt('この絞り込みのレギュラー番組はない');
  h += '<p class="empty" style="margin-top:12px">毎週・毎月の放送か、1週間以上あけて2回以上出演している番組を自動で集め、公式の説明に書かれた配信先ごとに分けている。ラジオはradikoのタイムフリーで聴ける前提で入れている。</p>';
  $('main').innerHTML = h;
}

/* ================= 操作 ================= */
let undo = null;
// 見逃しでチェックしたものは、すぐ消さずに横線付きで残す（タブを切り替えたら消える）
const keepSeen = new Set();
/** 一覧から消える変更なら、行を縮めて消してから反映する */
function changeStatus(c, status) {
  const rowEl = document.querySelector(`.row[data-key="${CSS.escape(c.key)}"]`);
  const disappears = status === 'skip';
  if (rowEl && disappears) {
    rowEl.style.height = rowEl.offsetHeight + 'px';
    rowEl.classList.add('leaving');
    requestAnimationFrame(() => { rowEl.style.height = '0px'; });
    setTimeout(() => setStatus(c, status), 220);
  } else setStatus(c, status);
}
function setStatus(c, status, opt = {}) {
  const before = store.status[c.key] || '';
  if (status) store.status[c.key] = status; else delete store.status[c.key];
  store.history.unshift({ key: c.key, label: c.label, from: before, to: status, at: Date.now() });
  store.history = store.history.slice(0, 50);
  save();
  if (opt.quiet) { render(); return; }
  undo = { c, before };
  $('undoText').textContent = status === 'skip' ? `「${c.label}」を消した` : `「${c.label}」を戻した`;
  $('undoBtn').hidden = false;
  $('undobar').hidden = false;
  render();
}
$('undoBtn').addEventListener('click', () => {
  if (!undo) return;
  const { c, before } = undo;
  if (before) store.status[c.key] = before; else delete store.status[c.key];
  save(); undo = null; $('undobar').hidden = true; render();
});
$('undoClose').addEventListener('click', () => { undo = null; $('undobar').hidden = true; });

let lastDragEnd = 0;
document.addEventListener('click', e => {
  // カードの本文をタップ → その予定の公式ページを開く（ボタンとスワイプ直後は除く）
  const evEl = e.target.closest('.row.ev');
  if (evEl) { window.open(evEl.dataset.url, '_blank', 'noopener'); return; }
  const bodyEl = e.target.closest('.card .body');
  if (bodyEl && !e.target.closest('button') && Date.now() - lastDragEnd > 400) {
    const rowEl = bodyEl.closest('.row');
    const c = BYKEY.get(rowEl.dataset.key);
    const b = c && (c.broadcasts.find(x => x.id === rowEl.dataset.bid) || c.first);
    if (b && b.url) window.open(b.url, '_blank', 'noopener');
    return;
  }
  const t = e.target.closest('button');
  if (!t) return;
  if (t.dataset.group) {
    if (t.disabled) return;
    store.ui.group = t.dataset.group;
    // 選んでいたメンバーが新しいグループにいなければ「全員」に戻す
    if (store.ui.member !== 'all' && t.dataset.group !== 'all' && memberGroupOf(store.ui.member) !== t.dataset.group) store.ui.member = 'all';
    save(); render(); return;
  }
  if (t.dataset.tab) { keepSeen.clear(); store.ui.tab = t.dataset.tab; save(); render(); window.scrollTo(0, 0); return; }
  if (t.dataset.cal) {
    const [y, m] = store.ui.calMonth.split('-').map(Number);
    const d = new Date(Date.UTC(y, m - 1 + +t.dataset.cal, 1));
    store.ui.calMonth = `${d.getUTCFullYear()}-${d.getUTCMonth() + 1}`;
    save(); render(); return;
  }
  if (t.dataset.day) { store.ui.calDay = +t.dataset.day; save(); render(); return; }
  if (t.id === 'memberPicker') { openMemberMenu(t); return; }
  if (t.id === 'filterPicker') { openFilterMenu(t); return; }
  if (t.id === 'openSettings') { openSettings(); return; }
  const rowEl = t.closest('.row');
  if (!rowEl) return;
  const c = BYKEY.get(rowEl.dataset.key);
  if (!c) return;
  const b = c.broadcasts.find(x => x.id === rowEl.dataset.bid) || c.first;
  if (t.dataset.act === 'seen') { const on = store.status[c.key] !== 'seen'; if (on) keepSeen.add(c.key); setStatus(c, on ? 'seen' : '', { quiet: true }); }
  if (t.dataset.act === 'del') { closeOpenRow(); changeStatus(c, 'skip'); }
  if (t.dataset.act === 'menu') openMenu(c, b, t);
});

/* ---------- 左スワイプ：「消す」を出す（メールアプリと同じ）。•••メニューからも消せる ---------- */
const REVEAL = 88; // 「消す」ボタンの幅
let drag = null, openRow = null;
function closeOpenRow() {
  if (!openRow) return;
  const card = openRow.querySelector('.card');
  card.classList.add('anim'); card.style.transform = '';
  const r = openRow; openRow = null;
  setTimeout(() => { card.classList.remove('anim'); r.classList.remove('open', 'dir-left'); }, 230);
}
document.addEventListener('pointerdown', e => {
  const card = e.target.closest('.card');
  if (openRow && (!card || card.parentElement !== openRow) && !e.target.closest('.swipe-del')) { closeOpenRow(); }
  if (!card || card.classList.contains('ev') || e.target.closest('button')) return;
  const base = card.parentElement.classList.contains('open') ? -REVEAL : 0;
  drag = { card, row: card.parentElement, x: e.clientX, y: e.clientY, dx: base, base, active: false, id: e.pointerId };
});
document.addEventListener('pointermove', e => {
  if (!drag || e.pointerId !== drag.id) return;
  const mx = e.clientX - drag.x, dy = e.clientY - drag.y;
  if (!drag.active) {
    if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(mx)) { drag = null; return; } // 縦スクロール
    if (Math.abs(mx) < 10) return;
    drag.active = true;
    drag.card.setPointerCapture(e.pointerId);
  }
  let dx = drag.base + mx;
  if (dx > 0) dx = dx / 4; // 右には少しだけ（引っ張られる感じ）
  drag.dx = dx;
  drag.card.style.transform = `translateX(${dx}px)`;
  drag.row.classList.toggle('dir-left', dx < 0);
});
function endDrag(e) {
  if (!drag || (e && e.pointerId !== drag.id)) return;
  const { card, row, dx, active } = drag;
  drag = null;
  if (!active) return;
  lastDragEnd = Date.now();
  const w = card.offsetWidth;
  card.classList.add('anim');
  const c = BYKEY.get(row.dataset.key);
  if (dx < -w * 0.6 && c) {                 // 大きく引いた → そのまま消す
    card.style.transform = `translateX(${-w}px)`;
    openRow = null;
    setTimeout(() => changeStatus(c, 'skip'), 200);
  } else if (dx < -REVEAL / 2) {            // 途中まで → 「消す」を出して止める
    card.style.transform = `translateX(${-REVEAL}px)`;
    if (openRow && openRow !== row) closeOpenRow();
    openRow = row; row.classList.add('open');
    setTimeout(() => card.classList.remove('anim'), 230);
  } else {                                   // 少しだけ → 戻す
    card.style.transform = '';
    if (openRow === row) openRow = null;
    setTimeout(() => { card.classList.remove('anim'); row.classList.remove('dir-left', 'open'); }, 230);
  }
}
document.addEventListener('pointerup', endDrag);
document.addEventListener('pointercancel', endDrag);

/* ---------- 下から出るメニュー ---------- */
function openSheet(html) {
  $('sheet').innerHTML = html;
  $('sheet').hidden = false; $('sheetBackdrop').hidden = false;
  const first = $('sheet').querySelector('button'); if (first) first.focus();
}
function closeSheet() { $('sheet').hidden = true; $('sheetBackdrop').hidden = true; }
$('sheetBackdrop').addEventListener('click', closeSheet);

/* ---------- 押したボタンの近くに出るメニュー（iOS 26 の出方） ---------- */
const ICON = {
  check: '<path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>',
  eyeoff: '<path d="M3 3l18 18M10.6 6.1A9.8 9.8 0 0 1 12 6c5 0 9 6 9 6a17 17 0 0 1-3.2 3.7M6.3 7.6C4.2 9.2 3 12 3 12s4 6 9 6a8.8 8.8 0 0 0 4-1M9.9 10a3 3 0 0 0 4.2 4.2" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/>',
  undo: '<path d="M9 7L4 12l5 5M4 12h11a5 5 0 0 1 0 10h-2" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>',
  cal: '<rect x="3.5" y="5" width="17" height="15.5" rx="3" fill="none" stroke="currentColor" stroke-width="1.9"/><path d="M3.5 10h17M8 3v4M16 3v4M12 13v5M9.5 15.5h5" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/>',
  link: '<path d="M14 4h6v6M20 4l-9 9M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>',
  trash: '<path d="M4 7h16M9 7V4.5h6V7M6.5 7l1 12.5h9l1-12.5M10 11v5M14 11v5" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.9"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" fill="none" stroke="currentColor" stroke-width="1.9"/>',
};
const ico = k => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICON[k] || ''}</svg>`;

/**
 * items: [{ label, icon, value, checked, header, sub }]
 * anchor の近く（下、入らなければ上）に出す。外を押すと閉じる。
 */
function openPopMenu(anchor, items, onPick, opt = {}) {
  const el = $('menu');
  el.innerHTML = items.map((it, i) => it.header
    ? `<div class="menu-h">${esc(it.header)}</div>`
    : it.sep ? '<div class="menu-sep"></div>'
    : `<button class="${it.danger ? 'danger' : ''}" role="menuitem${it.checked !== undefined ? 'radio' : ''}" ${it.checked !== undefined ? `aria-checked="${!!it.checked}"` : ''} data-i="${i}">
        <span class="mi-check">${it.checked ? ico('check') : ''}</span>
        <span class="mi-label">${esc(it.label)}${it.sub ? `<small>${esc(it.sub)}</small>` : ''}</span>
        ${it.icon ? `<span class="mi-icon">${ico(it.icon)}</span>` : ''}</button>`).join('');
  el.classList.toggle('with-check', items.some(it => it.checked !== undefined));
  el.hidden = false; $('menuBackdrop').hidden = false;
  // 位置：ボタンの下。画面からはみ出すなら上に。左右は画面内に収める
  const r = anchor.getBoundingClientRect();
  const vw = window.innerWidth, vh = window.innerHeight;
  const w = Math.min(opt.width || 260, vw - 24);
  el.style.width = w + 'px';
  el.style.maxHeight = Math.min(opt.maxHeight || 420, vh - 120) + 'px';
  let left = opt.alignRight ? r.right - w : r.left;
  left = Math.max(12, Math.min(left, vw - w - 12));
  el.style.left = left + 'px';
  const h = el.offsetHeight;
  const below = r.bottom + 6;
  el.style.top = (below + h < vh - 90 ? below : Math.max(12, r.top - h - 6)) + 'px';
  el.style.transformOrigin = `${r.left + r.width / 2 - left}px ${below + h < vh - 90 ? 'top' : 'bottom'}`;
  const sel = el.querySelector('[aria-checked="true"]'); if (sel) sel.scrollIntoView({ block: 'nearest' });
  el.onclick = e => {
    const b = e.target.closest('button[data-i]'); if (!b) return;
    closePopMenu(); onPick(items[+b.dataset.i]);
  };
}
function closePopMenu() { $('menu').hidden = true; $('menuBackdrop').hidden = true; }
$('menuBackdrop').addEventListener('click', closePopMenu);

function openMemberMenu(anchor) {
  const gs = store.ui.group === 'all' ? DATA.groups.map(g => g.key) : [store.ui.group];
  const items = [{ label: '全員', value: 'all', checked: store.ui.member === 'all' }];
  for (const g of gs) {
    if (gs.length > 1) items.push({ header: groupName(g) });
    for (const mm of DATA.members[g] || []) items.push({ label: mm.name, value: mm.name, checked: store.ui.member === mm.name });
  }
  openPopMenu(anchor, items, it => { store.ui.member = it.value; save(); render(); }, { width: 220 });
}
function openFilterMenu(anchor) {
  const isEv = store.ui.tab === 'events';
  const list = isEv ? EVENT_KINDS : MEDIUMS;
  const cur = isEv ? (store.ui.ekind || 'all') : store.ui.medium;
  openPopMenu(anchor, list.map(k => ({ label: k.label, value: k.key, checked: k.key === cur })), it => {
    if (isEv) store.ui.ekind = it.value; else store.ui.medium = it.value;
    save(); render();
  }, { width: 200, alignRight: true });
}

function openMenu(c, b, anchor) {
  const s = store.status[c.key];
  const items = [
    { label: 'iPhoneのカレンダーに追加', icon: 'cal', act: 'ics' },
    ...(b.url ? [{ label: '公式ページを開く', icon: 'link', act: 'url' }] : []),
    { label: 'タイトルをコピー', icon: 'copy', act: 'copy', sub: c.program || c.label },
    { sep: true },
    { label: '消す', icon: 'trash', act: 'skip', danger: true },
  ];
  openPopMenu(anchor, items, it => {
    if (it.act === 'seen') changeStatus(c, 'seen');
    if (it.act === 'unseen' || it.act === 'unskip') setStatus(c, '');
    if (it.act === 'skip') changeStatus(c, 'skip');
    if (it.act === 'ics') openIcs(c, b);
    if (it.act === 'url') window.open(b.url, '_blank', 'noopener');
    if (it.act === 'copy') copyText(c.program || c.label);
  }, { width: 270, alignRight: true });
}

function copyText(text) {
  const done = () => { $('undoText').textContent = `「${text}」をコピーした`; undo = null; $('undoBtn').hidden = true; $('undobar').hidden = false; };
  if (navigator.clipboard) navigator.clipboard.writeText(text).then(done, done); else done();
}

/* ---------- 確認ダイアログ ---------- */
function confirmAlert({ title, text, ok }) {
  return new Promise(resolve => {
    $('alertTitle').textContent = title; $('alertText').textContent = text; $('alertOk').textContent = ok;
    $('alertBackdrop').hidden = false;
    $('alertCancel').focus();
    const end = v => { $('alertBackdrop').hidden = true; $('alertOk').onclick = $('alertCancel').onclick = null; resolve(v); };
    $('alertOk').onclick = () => end(true);
    $('alertCancel').onclick = () => end(false);
  });
}

/** .ics（予定ファイル）を作って開く。iPhoneなら「カレンダーに追加」の画面が出る想定 */
function openIcs(c, b) {
  const f = ms => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const d = ms => { const x = jst(ms); return `${x.getUTCFullYear()}${String(x.getUTCMonth() + 1).padStart(2, '0')}${String(x.getUTCDate()).padStart(2, '0')}`; };
  const escIcs = s => String(s || '').replace(/[\\;,]/g, m => '\\' + m).replace(/\n/g, '\\n');
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//oshi-checker//JA', 'BEGIN:VEVENT',
    `UID:${b.id}@oshi-checker`, `DTSTAMP:${f(Date.now())}`,
    ...(b.allDay ? [`DTSTART;VALUE=DATE:${d(b.dayMs)}`, `DTEND;VALUE=DATE:${d(b.dayMs + DAY)}`] : [`DTSTART:${f(b.start)}`, `DTEND:${f(b.end)}`]),
    `SUMMARY:${escIcs(`${c.label}（${b.station || ''}）`)}`,
    `DESCRIPTION:${escIcs(b.title + (b.url ? `\n${b.url}` : ''))}`,
    ...(b.url ? [`URL:${b.url}`] : []),
    'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:まもなく放送', 'TRIGGER:-PT30M', 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR',
  ];
  const blob = new Blob([lines.join('\r\n')], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `${b.id}.ics`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

/* ---------- 設定 ---------- */
function openSettings() {
  const s = store.settings;
  const hist = store.history.slice(0, 20).map((h, i) => {
    const w = x => x === 'seen' ? '見た' : x === 'skip' ? '消した' : '未';
    const t = jst(h.at);
    return `<div class="hist"><span>${esc(h.label)}<br><small>${w(h.from)} → ${w(h.to)}・${t.getUTCMonth() + 1}/${t.getUTCDate()} ${t.getUTCHours()}:${String(t.getUTCMinutes()).padStart(2, '0')}</small></span>
      <button data-h="${i}">戻す</button></div>`;
  }).join('') || '<div class="hist"><span><small>まだ操作はない</small></span></div>';
  openSheet(`<div class="group">
      <div class="head">設定</div>
      <button class="setting" data-s="auto" role="switch" aria-checked="${s.autoHideExpired}">
        <span>期限切れを自動で消す<small>オフなら灰色＋横線で残り、自分で消す</small></span><span class="switch" aria-checked="${s.autoHideExpired}"></span></button>
      <div class="setting"><span>赤字にするのは残り</span>
        <span class="seg-mini">${[1, 2, 3].map(n => `<button data-w="${n}" aria-pressed="${s.warnDays === n}">${n}日</button>`).join('')}</span></div>
      <button class="setting" data-s="reload"><span>データを読み直す</span><span aria-hidden="true">↻</span></button>
    </div>
    <div class="group"><h3>履歴</h3>${hist}</div>
    <div class="group">
      <button class="item" data-s="export">記録を書き出す（バックアップ）</button>
      <button class="item danger" data-s="import">記録を読み込む（今の記録を置き換え）</button>
    </div>
    <div class="group"><button class="item cancel" data-s="close">閉じる</button></div>
    <input type="file" id="importFile" accept="application/json" hidden>`);
  $('sheet').onclick = e => {
    const el = e.target.closest('[data-s],[data-w],[data-h]');
    if (!el) return;
    if (el.dataset.w) { s.warnDays = +el.dataset.w; save(); render(); openSettings(); return; }
    if (el.dataset.h) {
      const h = store.history[+el.dataset.h];
      if (h.from) store.status[h.key] = h.from; else delete store.status[h.key];
      store.history.splice(+el.dataset.h, 1);
      save(); render(); openSettings(); return;
    }
    switch (el.dataset.s) {
      case 'auto': s.autoHideExpired = !s.autoHideExpired; save(); render(); openSettings(); break;
      case 'reload': closeSheet(); load(); break;
      case 'export': exportStore(); break;
      case 'import':
        confirmAlert({ title: '今の記録を置き換えますか？', text: '見た／見ないの記録が、読み込むファイルの内容に置き換わります。', ok: '置き換える' })
          .then(yes => { if (yes) $('importFile').click(); });
        break;
      case 'close': closeSheet(); break;
    }
  };
  $('importFile').onchange = async e => {
    const file = e.target.files[0]; if (!file) return;
    try {
      const s2 = JSON.parse(await file.text());
      if (!s2.status) throw new Error('形式が違う');
      Object.assign(store, s2); save(); closeSheet(); render();
    } catch (err) { $('sheet').querySelector('.head').textContent = '読み込めなかった：' + err.message; }
  };
}
function exportStore() {
  const blob = new Blob([JSON.stringify(store)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  const t = jst(Date.now());
  a.download = `oshi-backup-${t.getUTCFullYear()}${String(t.getUTCMonth() + 1).padStart(2, '0')}${String(t.getUTCDate()).padStart(2, '0')}.json`;
  document.body.appendChild(a); a.click(); a.remove();
}

/* ================= 読み込み ================= */
async function load() {
  try {
    const [d, p] = await Promise.all([
      fetch('data/data.json', { cache: 'no-cache' }).then(r => r.json()),
      fetch('config/programs.json', { cache: 'no-cache' }).then(r => r.json()).catch(() => ({ programs: [] })),
    ]);
    DATA = d; PROGRAMS = p.programs || [];
    CONTENTS = build(DATA, PROGRAMS);
    BYKEY = new Map(CONTENTS.map(c => [c.key, c]));
    if (store.ui.group !== 'all' && store.ui.group !== 'nj' && !DATA.groups.some(g => g.key === store.ui.group)) store.ui.group = 'all';
    if (store.ui.tab === 'cal') store.ui.tab = 'today';
    render();
  } catch (e) {
    $('main').innerHTML = `<p class="placeholder">データを読み込めなかった（${esc(e.message)}）<br>初めてなら、GitHubの Actions で「update-data」を一度実行してほしい</p>`;
  }
}
load();
// アプリに戻ってきたとき、日付が変わっていれば表示を更新する
document.addEventListener('visibilitychange', () => { if (!document.hidden) render(); });

// オフラインでも開けるようにする（sw.js）
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

// スクロールしたら大きなタイトルを小さくする（一番上に戻ると大きく戻る）
window.addEventListener('scroll', () => { $('bar').classList.toggle('compact', window.scrollY > 40); }, { passive: true });
