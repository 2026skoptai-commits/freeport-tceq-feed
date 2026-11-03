/**
 * Freeport LNG Watch — TCEQ 수집기 (GitHub Actions에서 1시간마다 실행)  [FreeportWatch v5]
 * TCEQ Air Emission Event Reports에서 Freeport LNG(CN601720345) 최근 60일 신고 + 상세(Train·원인·지속시간)를 조회해
 *  - tceq.json  : Google Apps Script(FreeportWatch_v5.gs)가 읽어 알림 메일 발송
 *  - index.html : Freeport 신고 목록 페이지 (GitHub Pages) — 메일의 바로가기·신고번호 링크가 여기로 연결
 * 기본 클라이언트로 시간당 수 건만 요청 (위장·우회 없음). 아래 파싱·표시 함수는 FreeportWatch_v5.gs에서 자동 추출됨.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const TCEQ_BASE = "https://www2.tceq.texas.gov/oce/eer/index.cfm";
const CN = process.env.TCEQ_CN || 'CN601720345';
const LOOKBACK_DAYS = 60, MAX_DETAIL = 15, DETAIL_BUDGET_MS = 240000, DETAIL_REFRESH_MS = 24 * 3600000;

function decodeEntities(s) {
  if (!s) return '';
  s = s.replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/, '$1');
  return s
    .replace(/&#(\d+);/g, function (_, d) { return String.fromCodePoint(parseInt(d, 10)); })
    .replace(/&#x([0-9a-f]+);/gi, function (_, h) { return String.fromCodePoint(parseInt(h, 16)); })
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .trim();
}

function pad2_(n) { return (n < 10 ? '0' : '') + n; }

function isCtDst_(y, mo, d, h) {
  if (mo < 3 || mo > 11) return false;
  if (mo > 3 && mo < 11) return true;
  var firstDow = new Date(Date.UTC(y, mo - 1, 1)).getUTCDay();
  var firstSun = 1 + ((7 - firstDow) % 7);
  if (mo === 3) { var st = firstSun + 7; return d > st || (d === st && h >= 2); }
  return d < firstSun || (d === firstSun && h < 2);   // 11월 첫째 일요일 02시 종료
}

function parseCt(s) {
  var m = String(s || '').match(/(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})\s*([AP]M)?)?/i);
  if (!m) return null;
  var mo = +m[1], d = +m[2], y = +m[3], h = m[4] ? +m[4] : 0, mi = m[5] ? +m[5] : 0;
  if (m[6]) { var pm = /p/i.test(m[6]); if (h === 12) h = pm ? 12 : 0; else if (pm) h += 12; }
  return new Date(Date.UTC(y, mo - 1, d, h + (isCtDst_(y, mo, d, h) ? 5 : 6), mi));
}

function formatCtDate(d) {
  var k = new Date(d.getTime() - 6 * 3600000);
  if (isCtDst_(k.getUTCFullYear(), k.getUTCMonth() + 1, k.getUTCDate(), k.getUTCHours())) k = new Date(d.getTime() - 5 * 3600000);
  return pad2_(k.getUTCMonth() + 1) + '/' + pad2_(k.getUTCDate()) + '/' + k.getUTCFullYear();
}

function formatKst(d, withYear) {
  var k = new Date(d.getTime() + 9 * 3600000);
  var s = pad2_(k.getUTCMonth() + 1) + '/' + pad2_(k.getUTCDate()) + ' ' + pad2_(k.getUTCHours()) + ':' + pad2_(k.getUTCMinutes());
  return withYear ? k.getUTCFullYear() + '-' + s.replace('/', '-') : s;
}

function escHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function buildTceqSearchUrl(now, cn, lookbackDays) {
  // 종료일은 지정하지 않음 (TCEQ가 '오늘 이후' 날짜를 오류 처리)
  return TCEQ_BASE + '?fuseaction=main.searchresults&newsearch=yes&cn_txt=' + encodeURIComponent(cn) +
    '&event_start_beg_dt=' + encodeURIComponent(formatCtDate(new Date(now.getTime() - lookbackDays * 86400000)));
}

function tceqDetailUrl(id) { return TCEQ_BASE + '?fuseaction=main.getDetails&target=' + id; }

function parseTceqList(html) {
  if (!html) return { ok: false, err: '빈 응답' };
  if (/Errors were found|Server Error/i.test(html)) return { ok: false, err: 'TCEQ 검색 오류 응답' };
  if (/No results were found/i.test(html)) return { ok: true, incidents: [] };
  if (html.indexOf('getDetails') < 0) return { ok: false, err: '예상치 못한 응답 형식' };
  var rows = html.match(/<tr[\s\S]*?<\/tr>/gi) || [], out = [];
  for (var i = 0; i < rows.length; i++) {
    var idm = rows[i].match(/getDetails&(?:amp;)?target=(\d+)/);
    if (!idm) continue;
    var cells = (rows[i].match(/<td[^>]*>[\s\S]*?<\/td>/gi) || []).map(function (c) {
      return decodeEntities(c.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '));
    });
    if (cells.length < 8 || !/^RN\d{9}$/.test(cells[1]) || !parseCt(cells[3]) || !/^\d{2}\/\d{2}\/\d{4}/.test(cells[7])) continue;  // 열 밀림 방지
    out.push({ id: idm[1], rn: cells[1], name: cells[2], began: cells[3], ended: cells[4],
      eventType: cells[5], reportType: cells[6], reportDate: cells[7] });
  }
  var ids = {}, m2, re2 = /getDetails&(?:amp;)?target=(\d+)/g;
  while ((m2 = re2.exec(html)) !== null) ids[m2[1]] = true;
  if (Object.keys(ids).length > out.length) return { ok: false, err: 'TCEQ 표 형식 변경 감지 (파싱 ' + out.length + '/' + Object.keys(ids).length + '건)' };
  // 결과는 신고번호 내림차순(최신 우선) 50건/페이지 → 신규 신고는 항상 1페이지
  return { ok: true, incidents: out, paged: /CurrentPage=2/.test(html) };
}

function htmlToLines_(html) {
  var t = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, '\n');
  return decodeEntities(t).split('\n').map(function (x) { return x.replace(/\s+/g, ' ').trim(); })
    .filter(function (x) { return x; });
}

function parseTceqDetail(html) {
  if (!html || html.indexOf('Incident Tracking Number') < 0) return null;
  var L = htmlToLines_(html);
  function idx(label) { for (var i = 0; i < L.length; i++) if (L[i].indexOf(label) === 0) return i; return -1; }
  function after(label) { var i = idx(label); return i >= 0 ? (L[i + 1] || '') : ''; }
  function between(a, b, sep) {
    var i = idx(a); if (i < 0) return '';
    var parts = [];
    for (var j = i + 1; j < L.length && L[j].indexOf(b) !== 0; j++) parts.push(L[j]);
    return parts.join(sep || ' ');
  }
  return {
    status: after('Incident Status:'),
    reportType: after('Report Type:'),
    unit: between('Process Unit or Area Common Names', 'Facility Common Name', ' / '),
    facility: between('Facility Identification Number (FIN)', '1 - Emission Point', ' / '),
    duration: after('Event Duration:'),
    cause: between('Cause of Emission Event', 'Actions Taken'),
    notified: after('Initial Notification Date/Time:')
  };
}

function trainLabel(detail) {
  if (!detail) return '';
  var txt = (detail.facility || '') + ' ' + (detail.unit || '');
  var m = txt.match(/TRAINS?\s*([0-9][0-9,\s&]*(?:AND\s*[0-9])?)/i);
  if (m) {
    var nums = {}, ds = m[1].match(/[0-9]/g) || [];
    for (var i = 0; i < ds.length; i++) nums[ds[i]] = true;
    return 'Train ' + Object.keys(nums).sort().join(',');
  }
  if (/pretreat/i.test(txt)) return '전처리설비';
  return (detail.facility || detail.unit || '').split(' / ')[0].slice(0, 40);
}

function causeTags(cause) {
  var c = String(cause || ''), tags = [];
  var rules = [[/power|electric|feed interruption|outage/i, '전력 공급 문제'], [/\btrip/i, '트립'],
    [/fire/i, '화재'], [/compressor/i, '컴프레서'], [/maint/i, '정비'], [/leak/i, '누출'],
    [/start-?up|restart|cooldown/i, '재가동'], [/shut ?down/i, '정지']];
  for (var i = 0; i < rules.length; i++) if (rules[i][0].test(c)) tags.push(rules[i][1]);
  return tags.slice(0, 3).join('·');
}

function shortFacility_(name) {
  return /PRETREAT/i.test(name) ? '전처리(Stratton Ridge)' : /LIQUEF/i.test(name) ? '액화 플랜트' : name;
}

/** Freeport 신고 목록 페이지 (정적 HTML) */
function renderPage(feed, now) {
  const e = escHtml;
  const incs = feed.incidents || [], det = feed.details || {};
  const updated = feed.fetched_at ? formatKst(new Date(feed.fetched_at), true) + ' KST' : '-';
  const lastOk = feed.last_ok_at ? formatKst(new Date(feed.last_ok_at), true) + ' KST' : '-';
  const ctKst = s => { const d = parseCt(s); return e(s) + ' CT' + (d ? ' <span class="m">(' + formatKst(d) + ' KST)</span>' : ''); };
  const cards = incs.map(inc => {
    const d = det[inc.id], tl = d ? trainLabel(d) : '', tags = d ? causeTags(d.cause) : '';
    const row = (k, v) => '<tr><th>' + k + '</th><td>' + v + '</td></tr>';
    return '<section class="card" id="i' + e(inc.id) + '">' +
      '<h2><span class="b ' + (/FINAL/i.test(inc.reportType) ? 'fin' : 'ini') + '">' + e(inc.reportType) + '</span> #' + e(inc.id) +
      ' · ' + e(shortFacility_(inc.name)) + (tl ? ' · <span class="t">' + e(tl) + '</span>' : '') + '</h2>' +
      '<table>' +
      row('발생 ~ 종료', ctKst(inc.began) + '<br>~ ' + (inc.ended ? ctKst(inc.ended) : '진행 중/미기재')) +
      (d && d.duration ? row('지속시간', e(d.duration)) : '') +
      row('설비', d ? e(d.facility || d.unit) : e(inc.name + ' (' + inc.rn + ')')) +
      row('원인', d ? (tags ? '<b>' + e(tags) + '</b><br>' : '') + e(d.cause) : '<span class="m">상세 미수집 — 다음 회차에 갱신</span>') +
      row('보고', e(inc.eventType) + ' · ' + e(inc.reportType) + ' · 보고일 ' + e(inc.reportDate) +
        (d && d.status ? ' · 상태 ' + e(d.status) : '') + (d && d.notified ? ' · 최초통보 ' + e(d.notified) + ' CT' : '')) +
      row('TCEQ 원문', '<a href="' + e(tceqDetailUrl(inc.id)) + '">#' + e(inc.id) + '</a> <span class="m">(미국 외 접속 시 TCEQ 홈으로 이동될 수 있음)</span>') +
      '</table></section>';
  }).join('\n');
  return '<!doctype html>\n<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="robots" content="noindex"><title>Freeport LNG TCEQ 신고</title><style>' +
    ':root{--bg:#f6f7f9;--card:#fff;--fg:#1f2328;--m:#6b7280;--ln:#e5e7eb;--hd:#922b21;--lk:#1a5276;--ini:#c0392b;--fin:#566573;--t:#c0392b}' +
    '@media (prefers-color-scheme:dark){:root{--bg:#111418;--card:#1a1f25;--fg:#e6e8eb;--m:#9aa3ad;--ln:#2c333b;--hd:#e07a6f;--lk:#7fb3e0;--t:#ff8a80}}' +
    'body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.55 "Malgun Gothic",-apple-system,"Segoe UI",sans-serif}' +
    'main{max-width:920px;margin:0 auto;padding:16px}h1{font-size:20px;margin:4px 0 2px;color:var(--hd)}' +
    '.sum{color:var(--m);font-size:13px;margin-bottom:12px}.warn{background:#fdecea;color:#922b21;border:1px solid #f5c6c0;padding:8px 10px;border-radius:6px;margin:8px 0}' +
    '.card{background:var(--card);border:1px solid var(--ln);border-left:5px solid var(--ini);border-radius:6px;margin:10px 0;padding:10px 12px}' +
    '.card:target{outline:3px solid #f1c40f}.card h2{font-size:15px;margin:0 0 6px}.t{color:var(--t)}' +
    '.b{display:inline-block;color:#fff;font-size:11px;padding:1px 6px;border-radius:3px;background:var(--ini);vertical-align:1px}.b.fin{background:var(--fin)}' +
    'table{border-collapse:collapse;width:100%}th{width:92px;text-align:left;vertical-align:top;color:var(--m);font-weight:normal;padding:4px 6px 4px 0}' +
    'td{padding:4px 0;border-top:1px solid var(--ln);word-break:break-word}th{border-top:1px solid var(--ln)}' +
    'a{color:var(--lk)}.m{color:var(--m);font-size:12px}footer{color:var(--m);font-size:12px;margin:18px 0 8px}' +
    '</style></head><body><main>' +
    '<h1>Freeport LNG — TCEQ 배출사건 신고</h1>' +
    '<div class="sum">FREEPORT LNG DEVELOPMENT LP (' + e(feed.cn || CN) + ') · 액화 플랜트 RN103196689 · 전처리 RN106481500<br>' +
    '최근 ' + LOOKBACK_DAYS + '일 · <b>' + incs.length + '건</b> · 마지막 갱신 ' + e(updated) + ' (매시간 자동 갱신)</div>' +
    (feed.ok ? '' : '<div class="warn">⚠ 이번 회차 TCEQ 조회 실패 (' + e(feed.err || '원인 미상') + '). 아래는 마지막 정상 조회(' + e(lastOk) + ') 기준입니다.</div>') +
    (incs.length ? cards : '<p class="m">최근 ' + LOOKBACK_DAYS + '일 신고 없음</p>') +
    '<footer>출처: TCEQ Air Emission Event Reports · 시간은 미국 중부시간(CT) 원문과 KST 환산 병기 · 신고는 사건 후 통상 24시간 내 등록 · Freeport LNG Watch v5</footer>' +
    '</main></body></html>\n';
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function get(url) {
  let last = { code: 0, err: 'no attempt' };
  for (let a = 0; a < 3; a++) {
    try {
      const r = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(20000) });
      const text = await r.text();
      if (r.status === 200) return { code: 200, text };
      last = { code: r.status, text };
    } catch (e) { last = { code: 0, err: 'network: ' + String(e.message || e).slice(0, 80) }; }
    if (a < 2) await sleep(3000 * (a + 1));
  }
  return last;
}

async function main() {
  const FEED = process.env.FEED_FILE || 'tceq.json';
  const DIR = path.dirname(FEED);
  const now = new Date();
  let prev = {};
  try { prev = JSON.parse(fs.readFileSync(FEED, 'utf8')); } catch (e) { prev = {}; }
  const out = { version: 1, source: 'TCEQ Air Emission Event Reports', cn: CN, lookback_days: LOOKBACK_DAYS,
    fetched_at: now.toISOString(), ok: false, err: '', last_ok_at: prev.last_ok_at || null,
    incidents: prev.incidents || [], details: prev.details || {} };
  const save = () => {
    fs.writeFileSync(FEED, JSON.stringify(out, null, 1) + '\n');
    fs.writeFileSync(path.join(DIR, 'index.html'), renderPage(out, new Date()));
    fs.writeFileSync(path.join(DIR, '.nojekyll'), '');
  };
  const r = await get(buildTceqSearchUrl(now, CN, LOOKBACK_DAYS));
  const list = r.code === 200 ? parseTceqList(r.text) : { ok: false, err: r.err || ('HTTP ' + r.code) };
  if (list.ok) {
    const pd = prev.details || {}, details = {}, t0 = Date.now();
    for (const inc of list.incidents) if (pd[inc.id]) details[inc.id] = pd[inc.id];   // 기존 상세 우선 유지
    // ① 목록을 상세 조회 전에 먼저 저장 → 상세가 지연·실패해도 신규 신고 자체는 반드시 반영
    Object.assign(out, { ok: true, err: '', last_ok_at: now.toISOString(), incidents: list.incidents, details, paged: !!list.paged });
    save();
    // ② 상세: 없음(신규) → 보고유형 변경 → 24시간 지난 것 순으로, 시간 한도 내에서
    const fresh = p => p && p.fetchedAt && Date.now() - Date.parse(p.fetchedAt) < DETAIL_REFRESH_MS;
    const need = list.incidents.filter(i => !(pd[i.id] && pd[i.id].listReportType === i.reportType && fresh(pd[i.id])))
      .sort((a, b) => (pd[a.id] ? 1 : 0) - (pd[b.id] ? 1 : 0))
      .slice(0, MAX_DETAIL);
    for (const inc of need) {
      if (Date.now() - t0 > DETAIL_BUDGET_MS) { console.log('상세 조회 시간 한도 도달 — 다음 회차에 계속'); break; }
      const d = await get(tceqDetailUrl(inc.id));
      const parsed = d.code === 200 ? parseTceqDetail(d.text) : null;
      if (parsed) { parsed.listReportType = inc.reportType; parsed.fetchedAt = new Date().toISOString(); details[inc.id] = parsed; }
      await sleep(1000);
    }
  } else {
    out.err = list.err;
  }
  save();
  console.log(out.ok ? 'OK ' + out.incidents.length + '건 (상세 ' + Object.keys(out.details).length + '건)' : 'FAIL ' + out.err);
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
module.exports = { main, parseTceqList, parseTceqDetail, buildTceqSearchUrl, renderPage };
