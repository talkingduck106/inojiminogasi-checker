/**
 * 公式サイトのスケジュール → data/data.json
 *
 * GitHub Actions が1日2回（5:17 と 0:17）実行する。
 * やること：
 *   1. 各グループの「月ごとのスケジュール一覧」から詳細ページのIDを集める
 *   2. 詳細ページを読み、カテゴリが「メディア」のものだけ取り出す
 *   3. 番組名・放送局・日時・出演メンバー・見逃し配信の記載を抜き出して data.json に書く
 *
 * 公式サイトへの負荷を抑えるため、
 *   ・1リクエストごとに少し待つ
 *   ・2日以上前の予定は前回の data.json の内容を使い回し、詳細ページを読み直さない
 */
import fs from 'node:fs/promises';

const ROOT = new URL('../', import.meta.url);
const OUT = new URL('data/data.json', ROOT);
const MEMBERS = new URL('config/members.json', ROOT);

const GROUPS = [
  { key: 'il', name: '＝LOVE', base: 'https://equal-love.jp', news: 'https://equal-love.jp/news/' },
  { key: 'nm', name: '≠ME', base: 'https://not-equal-me.jp', news: 'https://not-equal-me.jp/news/1/' },
  // ≒JOY は公式サイトのURLが決まったら追加する
  // { key: 'nj', name: '≒JOY', base: 'https://...' },
];
const PAST_DAYS = 45;   // 何日前まで取るか（見逃し消化用）
const FUTURE_DAYS = 60; // 何日先まで取るか
const WAIT_MS = 400;    // リクエストの間隔
const NEWS_PAGES = 2;   // ニュース一覧を何ページ見るか（チケットの受付期間を探す）
const DAY = 86400000;

// テスト時は fetch を差し替えられるようにする
export let fetchText = async (url) => {
  const res = await fetch(url, { headers: { 'User-Agent': 'oshi-checker (personal use; 2 runs/day)' } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.text();
};
export function setFetch(fn) { fetchText = fn; }
export let sleep = (ms) => new Promise(r => setTimeout(r, ms));
export function setSleep(fn) { sleep = fn; }

/* ---------- HTML → 行の配列 ---------- */
export function toLines(html) {
  return html
    .replace(/<(script|style|head|noscript)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(p|div|li|ul|ol|h\d|dt|dd|dl|tr|td|th|section|article|header|footer|span|time)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .split('\n').map(s => s.replace(/\s+/g, ' ').trim()).filter(s => s && s !== 'NEW');
}

/* ---------- 【ラベル】の値を取り出す（「【時　間】」のような空白入りにも対応） ---------- */
function field(body, ...labels) {
  for (const label of labels) {
    const re = new RegExp('【' + [...label].join('[\\s　]*') + '】[\\s　]*([^\\n]*)');
    const m = body.match(re);
    if (m && m[1].trim()) return m[1].trim();
  }
  return '';
}

// FM/AM は「Amazon」などに誤反応しないよう、英字に挟まれていないときだけ
const RADIO = /ラジオ|ＦＭ|radiko|NACK5|J-WAVE|文化放送|ニッポン放送|bayfm|InterFM|(^|[^A-Za-z])(FM|AM)([^A-Za-z]|$)/;
const LIVE_ONLY = /SHOWROOM|ニコニコ生放送|ニコ生|17LIVE|TikTok\s*LIVE|インスタライブ|Instagram\s*ライブ|YouTube\s*Live|生配信/i;
const STREAM = /YouTube|Prime Video|TELASA|ABEMA|Lemino|U-NEXT|Hulu|Netflix|FOD|Artistspoken|mellow-fan|ニコニコチャンネル|配信/i;
const TV = /テレビ|TV|系|BS|CS|MX|NHK|放送局/;

/** 媒体の種類を判定する */
export function detectMedium({ title, station, body, magazine }) {
  if (magazine) return 'magazine';
  const s = `${station} ${title}`;
  if (RADIO.test(s)) return 'radio';
  if (LIVE_ONLY.test(s)) return 'live';
  if (/【放送局】|【放[\s　]*送[\s　]*局】/.test(body) || TV.test(station)) return 'tv';
  if (STREAM.test(s)) return 'stream';
  if (TV.test(title)) return 'tv';
  return 'other';
}

/** 見逃し配信の記載を探す */
export function detectVod(body) {
  const services = ['TVer', 'FOD', 'ABEMA', 'U-NEXT', 'Hulu', 'Lemino', 'NHKプラス', 'radiko', 'mellow-fan', 'TELASA', 'Prime Video']
    .filter(s => body.toLowerCase().includes(s.toLowerCase()));
  const archive = /見逃し|アーカイブ|タイムシフト|タイムフリー/.test(body);
  let days = null;
  const w = body.match(/(\d+)\s*週間/);
  const d = body.match(/(\d+)\s*日間/);
  if (w) days = +w[1] * 7; else if (d) days = +d[1];
  return { services, archive, days, stated: services.length > 0 || archive };
}

/** 出演メンバーを判定する（※の後 → 【出演】 → 全文 の順） */
export function detectMembers(title, body, names) {
  let seg;
  const i = title.lastIndexOf('※');
  if (i >= 0) seg = title.slice(i + 1);
  else {
    const m = field(body, '出演', '出演者');
    seg = m || `${title}\n${body}`;
  }
  const cast = field(body, '出演', '出演者');
  return {
    members: names.filter(n => seg.includes(n)),
    castTBD: /ランダム|未定|調整中/.test(cast),
  };
}

/** 日時の文字列から最初の時刻（25:30 のような24時超えも可）を取る */
function times(s) {
  const all = [...s.matchAll(/(\d{1,2})[:：](\d{2})/g)].map(m => [+m[1], +m[2]]).filter(([h, mi]) => h < 30 && mi < 60);
  return all;
}

/** 詳細ページを読み取る。メディア以外は null */
export function parseDetail(g, id, html, names) {
  const lines = toLines(html);
  const dateRe = /^(\d{1,2})\.(\d{1,2})\s*(MON|TUE|WED|THU|FRI|SAT|SUN)\.?\s*(\d{4})$/i;
  let di = -1, span = 1, m = null;
  for (let i = 0; i < lines.length && di < 0; i++) {
    for (let s = 1; s <= 3; s++) {
      const hit = lines.slice(i, i + s).join(' ').match(dateRe);
      if (hit) { di = i; span = s; m = hit; break; }
    }
  }
  if (di < 0) return { error: 'date-not-found' };
  const month = +m[1], day = +m[2], year = +m[4];
  let next = di + span;
  let category = '';
  if (lines[next] && lines[next].length <= 12 && !/[「」『』]/.test(lines[next])) { category = lines[next]; next++; }
  const title = lines[next] || '';
  const rest = lines.slice(next + 1);
  const back = rest.findIndex(l => l === 'BACK');
  const body = (back >= 0 ? rest.slice(0, back) : rest)
    .filter(l => !/^(Facebook|X|Twitter|LINE|シェア|ポスト)$/i.test(l)).join('\n');
  if (category !== 'メディア') return parseEvent(g, id, { year, month, day, category, title, body, names });

  const station = field(body, '放送局', '媒体', '媒体名', '出版社', 'チャンネル');
  const magazine = field(body, '雑誌名');
  const program = field(body, '番組名', '雑誌名', 'タイトル') || (title.match(/[「『](.+?)[」』]/) || [])[1] || title;
  const timeText = [field(body, '時間'), field(body, '放送日時'), field(body, '放送日'), field(body, '配信日'), field(body, '配信リリース')].join(' ');
  const ts = times(timeText);

  const base = Date.UTC(year, month - 1, day) - 9 * 3600000; // JSTの0時
  let start = null, end = null;
  if (ts.length && !magazine) {
    start = base + (ts[0][0] * 60 + ts[0][1]) * 60000;
    if (ts[1]) {
      end = base + (ts[1][0] * 60 + ts[1][1]) * 60000;
      if (end <= start) end = null;
    }
  }
  const medium = detectMedium({ title, station, body, magazine });
  if (start && !end) end = start + 60 * 60000; // 終了時刻が無ければ1時間とみなす

  const { members, castTBD } = detectMembers(title, body, names);
  return {
    id: `${g.key}-${id}`,
    group: g.key,
    url: `${g.base}/schedule/detail/${id}`,
    title,
    program: program.replace(/\s+/g, ' ').trim(),
    station,
    medium,
    date: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    start, end, // ミリ秒（UTC）。時刻が書かれていなければ null（終日扱い）
    members,
    castTBD,
    vod: detectVod(body),
    excerpt: body.slice(0, 600),
  };
}

/* ================= イベント（ライブ・特典会・リリースなど） ================= */

/** イベントの種類：live（ライブ）／real（対面の特典会など）／online／release（発売）／other */
export function eventKind(category, title, body) {
  const t = `${title}\n${body.slice(0, 300)}`;
  if (/リリース|発売日|CD|シングル|アルバム|Blu-ray|DVD|映像作品/.test(category) || (/発売/.test(title) && !/発売記念/.test(title))) return 'release';
  if (/オンライン/.test(t) && /握手|お話し|サイン|特典|オンライン/.test(`${category}${title}`)) return 'online';
  if (/握手|お話し|サイン会|撮影会|チェキ|特典会|ミート|リリイベ|リリースイベント/.test(`${category}${title}`)) return 'real';
  if (/ライブ|LIVE|公演|コンサート|CONCERT|ツアー|TOUR|フェス|FES|生誕祭|周年/.test(`${category}${title}`)) return 'live';
  return 'other';
}

function parseEvent(g, id, { year, month, day, category, title, body, names }) {
  const base = Date.UTC(year, month - 1, day) - 9 * 3600000;
  // 開演時刻 → 無ければ最初の「HH:MM〜」
  const near = (() => { const p = body.search(new RegExp(`${month}月\\s*${day}日`)); return p >= 0 ? body.slice(p, p + 300) : body; })();
  const kaien = near.match(/開演\s*[:：]?\s*(\d{1,2})[:：](\d{2})/);
  const kaishi = near.match(/開始\s*[:：]?\s*(\d{1,2})[:：](\d{2})/);
  const range = near.match(/(\d{1,2})[:：](\d{2})\s*[～〜~\-－ー]/);
  const hm = kaien || kaishi || range || near.match(/(\d{1,2})[:：](\d{2})/);
  const start = hm ? base + (+hm[1] * 60 + +hm[2]) * 60000 : null;
  // 会場：タイトル末尾の「」の後ろ、または【会場】
  let venue = '';
  const t0 = title.replace(/※.*$/, '').trim(); // 「※メンバー名」は会場ではない
  const tailM = t0.match(/[」』]\s*([^「」『』]{2,40})$/);
  const tail = tailM && !/^(発売|開催|決定|配信|公開)/.test(tailM[1].trim()) ? tailM : null;
  const label = field(body, '会場') || (body.match(/会場\s*[:：]\s*([^\n]{2,40})/) || [])[1] || '';
  if (tail) venue = tail[1].trim(); else if (label && !/こちら|http/.test(label)) venue = label.trim();
  const { members } = detectMembers(title, body, names);
  return {
    type: 'event',
    id: `${g.key}-${id}`,
    group: g.key,
    url: `${g.base}/schedule/detail/${id}`,
    kind: eventKind(category, title, body),
    category,
    title,
    date: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    start,
    venue,
    members,
  };
}

/* ================= チケット（ニュース記事の受付期間） =================
 * カレンダー用GASと同じ考え方：
 *   ・記事の中から「◯月◯日 … 〜 ◯月◯日 …」の期間を探す
 *   ・物販・入金・当落発表は除く
 *   ・切れ目なくつながる受付（第1次→第2次…）は1本にまとめ、1日以上空けば別にする
 */
const MD = /(?:(\d{4})年\s*)?(\d{1,2})月\s*(\d{1,2})日[^\d～〜~\n]*(?:(\d{1,2})[:：](\d{2}))?/g;

function toMs(y, mo, d, h, mi) { return Date.UTC(y, mo - 1, d, (h ?? 0) - 9, mi ?? 0); }

/** 1行から「開始〜終了」を取り出す。無ければ null */
export function periodIn(line, baseYear, baseMonth) {
  const parts = line.split(/[～〜~]/);
  if (parts.length < 2) return null;
  const a = [...parts[0].matchAll(MD)].pop();
  const b = [...parts.slice(1).join('～').matchAll(MD)][0];
  if (!a) return null;
  const year = (y, mo) => y ? +y : (mo < baseMonth - 3 ? baseYear + 1 : baseYear);
  const sy = year(a[1], +a[2]);
  const start = toMs(sy, +a[2], +a[3], a[4] ? +a[4] : 0, a[5] ? +a[5] : 0);
  let end;
  if (b) {
    const ey = b[1] ? +b[1] : (+b[2] < +a[2] ? sy + 1 : sy);
    end = toMs(ey, +b[2], +b[3], b[4] ? +b[4] : 23, b[5] ? +b[5] : 59);
  } else {
    // 「〜23:59」のように時刻だけ → 開始と同じ日
    const t = parts.slice(1).join('～').match(/(\d{1,2})[:：](\d{2})/);
    if (!t) return null;
    end = toMs(sy, +a[2], +a[3], +t[1], +t[2]);
  }
  return end > start ? { start, end } : null;
}

export function parseNews(g, id, html, now) {
  const lines = toLines(html);
  const di = lines.findIndex(l => /^\d{4}\.\d{1,2}\.\d{1,2}/.test(l));
  if (di < 0) return null;
  const [, y, mo] = lines[di].match(/^(\d{4})\.(\d{1,2})/);
  const title = (lines[di - 1] && lines[di - 1] !== 'NEWS') ? lines[di - 1] : (lines[di + 1] || '');
  const rest = lines.slice(di + 1);
  const back = rest.findIndex(l => l === 'BACK');
  const body = back >= 0 ? rest.slice(0, back) : rest;
  // チケット・応募の記事だけ（物販・グッズの記事は除く）
  if (/物販|グッズ/.test(title) || !/チケット|先行|受付|応募|抽選|申込/.test(title + body.join('\n'))) return null;

  const phases = [];
  let lastLabel = '';
  for (const line of body) {
    const p = periodIn(line, +y, +mo);
    if (!p) { if (line.length <= 40) lastLabel = line; continue; }
    // 受付の名前：【第1次応募受付】→ 中身、「FC先行：10月…」→ コロンの前、日付から始まる行 → 直前の行
    const br = line.match(/^[●■▼・\s]*【([^】]+)】/);
    const colon = line.match(/^[●■▼・\s]*([^:：]{1,30})[:：]\s*(\d{4}年)?\d{1,2}月/);
    const label = (br ? br[1] : colon ? colon[1] : lastLabel).replace(/^[●■▼・【\s]+|[】\s]+$/g, '').slice(0, 30);
    if (/入金|発表|当落|結果|販売時間|物販|開場|開演/.test(label + line.slice(0, 20))) continue;
    phases.push({ label, ...p });
  }
  if (!phases.length) return null;
  // つながる受付をまとめる
  phases.sort((a, b) => a.start - b.start);
  const merged = [];
  for (const p of phases) {
    const last = merged[merged.length - 1];
    if (last && p.start - last.end < DAY) {
      last.end = Math.max(last.end, p.end);
      if (p.label && !last.label.includes(p.label)) last.label = `${last.label}・${p.label}`.slice(0, 40);
    } else merged.push({ ...p });
  }
  const open = merged.filter(p => p.end > now - DAY);
  if (!open.length) return null;
  return { type: 'ticket', id: `${g.key}-n${id}`, group: g.key, url: `${g.base}/news/detail/${id}`, kind: 'ticket', title, phases: open };
}

/** 一覧ページのURL（今月は /schedule/、それ以外は /schedule/calender/年/月/） */
export function monthUrls(g, now) {
  const urls = [];
  const from = new Date(now - PAST_DAYS * DAY), to = new Date(now + FUTURE_DAYS * DAY);
  const jst = (d) => new Date(d.getTime() + 9 * 3600000);
  let y = jst(from).getUTCFullYear(), mo = jst(from).getUTCMonth() + 1;
  const ty = jst(to).getUTCFullYear(), tm = jst(to).getUTCMonth() + 1;
  const cy = jst(new Date(now)).getUTCFullYear(), cm = jst(new Date(now)).getUTCMonth() + 1;
  while (y < ty || (y === ty && mo <= tm)) {
    urls.push(y === cy && mo === cm ? `${g.base}/schedule/` : `${g.base}/schedule/calender/${y}/${String(mo).padStart(2, '0')}/`);
    mo++; if (mo > 12) { mo = 1; y++; }
  }
  return urls;
}

export async function run({ now = Date.now(), log = console.log } = {}) {
  const members = JSON.parse(await fs.readFile(MEMBERS, 'utf8'));
  let prev = { items: [] };
  try { prev = JSON.parse(await fs.readFile(OUT, 'utf8')); } catch { /* 初回 */ }
  const prevById = new Map(prev.items.map(it => [it.id, it]));
  const prevSkip = new Set(prev.nonMedia || []);

  const items = [], events = [], tickets = [], nonMedia = [], errors = [];
  const prevEvents = new Map((prev.events || []).map(e => [e.id, e]));
  for (const g of GROUPS) {
    const names = (members[g.key] || []).map(m => m.name);
    const ids = new Set();
    for (const url of monthUrls(g, now)) {
      try {
        const html = await fetchText(url);
        (html.match(/\/schedule\/detail\/\d+/g) || []).forEach(h => ids.add(h.split('/').pop()));
      } catch (e) { errors.push(String(e.message || e)); }
      await sleep(WAIT_MS);
    }
    log(`${g.name}: 詳細 ${ids.size}件`);

    for (const id of ids) {
      const key = `${g.key}-${id}`;
      const old = prevById.get(key);
      const oldDay = old && Date.parse(old.date + 'T00:00:00+09:00');
      // 2日以上前の予定は内容が変わらないので読み直さない
      if (old && oldDay < now - 2 * DAY) { items.push(old); continue; }
      const oldEv = prevEvents.get(key);
      if (oldEv && Date.parse(oldEv.date + 'T00:00:00+09:00') < now - 2 * DAY) { events.push(oldEv); continue; }
      if (!old && !oldEv && prevSkip.has(key)) { nonMedia.push(key); continue; }
      try {
        const it = parseDetail(g, id, await fetchText(`${g.base}/schedule/detail/${id}`), names);
        if (it && it.error) errors.push(`${key}: ${it.error}`);
        else if (it && it.type === 'event') events.push(it);
        else if (it) items.push(it);
        else nonMedia.push(key);
      } catch (e) { errors.push(String(e.message || e)); }
      await sleep(WAIT_MS);
    }

    // ニュース一覧 → チケット受付期間
    if (g.news) {
      const nids = new Set();
      for (let p = 1; p <= NEWS_PAGES; p++) {
        try {
          const html = await fetchText(p === 1 ? g.news : `${g.news}?page=${p}`);
          (html.match(/\/news\/detail\/\d+/g) || []).forEach(h => nids.add(h.split('/').pop()));
        } catch (e) { errors.push(String(e.message || e)); }
        await sleep(WAIT_MS);
      }
      for (const nid of nids) {
        try {
          const t = parseNews(g, nid, await fetchText(`${g.base}/news/detail/${nid}`), now);
          if (t) tickets.push(t);
        } catch (e) { errors.push(String(e.message || e)); }
        await sleep(WAIT_MS);
      }
      log(`${g.name}: ニュース ${nids.size}件 → チケット ${tickets.filter(t => t.group === g.key).length}件`);
    }
  }

  // 表示範囲より古いものは捨てる
  const min = now - (PAST_DAYS + 7) * DAY;
  const kept = items.filter(it => Date.parse(it.date + 'T00:00:00+09:00') >= min)
    .sort((a, b) => (a.start || Date.parse(a.date + 'T00:00:00+09:00')) - (b.start || Date.parse(b.date + 'T00:00:00+09:00')));

  const out = {
    updatedAt: now,
    groups: GROUPS.map(g => ({ key: g.key, name: g.name })),
    members,
    items: kept,
    events: events.filter(e => Date.parse(e.date + 'T00:00:00+09:00') >= now - 2 * DAY)
      .sort((a, b) => (a.start || Date.parse(a.date + 'T00:00:00+09:00')) - (b.start || Date.parse(b.date + 'T00:00:00+09:00'))),
    tickets,
    nonMedia,
    errors,
  };
  await fs.mkdir(new URL('data/', ROOT), { recursive: true });
  await fs.writeFile(OUT, JSON.stringify(out));
  log(`保存：メディア ${kept.length}件 / イベント ${out.events.length}件 / チケット ${tickets.length}件 / エラー ${errors.length}件`);
  if (errors.length) log(errors.slice(0, 20).join('\n'));
  return out;
}

// node scraper/scrape.mjs で直接実行されたとき
if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(e => { console.error(e); process.exit(1); });
}
