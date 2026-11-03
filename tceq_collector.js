/**
 * Freeport LNG Watch — TCEQ 수집기 (GitHub Actions에서 1시간마다 실행)  [FreeportWatch v4]
 * TCEQ Air Emission Event Reports에서 Freeport LNG(CN601720345) 최근 45일 신고 + 상세(Train·원인·지속시간)를
 * 조회해 tceq.json으로 저장. Google Apps Script(FreeportWatch_v4.gs)가 이 파일을 읽어 알림 메일 발송.
 * 기본 클라이언트로 시간당 수 건만 요청 (위장·우회 없음). 아래 파싱 함수는 FreeportWatch_v4.gs에서 자동 추출됨.
 */
'use strict';
const fs = require('fs');
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
  const now = new Date();
  let prev = {};
  try { prev = JSON.parse(fs.readFileSync(FEED, 'utf8')); } catch (e) { prev = {}; }
  const out = { version: 1, source: 'TCEQ Air Emission Event Reports', cn: CN, lookback_days: LOOKBACK_DAYS,
    fetched_at: now.toISOString(), ok: false, err: '', last_ok_at: prev.last_ok_at || null,
    incidents: prev.incidents || [], details: prev.details || {} };
  const r = await get(buildTceqSearchUrl(now, CN, LOOKBACK_DAYS));
  const list = r.code === 200 ? parseTceqList(r.text) : { ok: false, err: r.err || ('HTTP ' + r.code) };
  const save = () => fs.writeFileSync(FEED, JSON.stringify(out, null, 1) + '\n');
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
module.exports = { main, parseTceqList, parseTceqDetail, buildTceqSearchUrl };
