// 학과 공지 / 학식을 학교 사이트에서 가져와 Firestore에 저장하는 스크립트.
// GitHub Actions 크론(10분 간격)에서 실행된다.
//
// 원래 앱(브라우저)에서만 가져왔는데, 그러면 "그 시간에 누군가 앱을 열어야" 갱신됐다.
// 서버에서 돌리면 아무도 앱을 안 켜도 정해진 시각에 갱신되고, 브라우저가 아니므로
// CORS 프록시(allorigins 등 불안정한 외부 서비스)를 거칠 필요도 없어 더 안정적이다.
//
// 일정
//   학과 공지: 매일 00:00 / 12:00 KST
//   학식     : 매주 월요일 10:00 → 실패 시 10:30 → 11:00 → 12:00 (한 번 성공하면 그 주는 종료)

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { JSDOM } from 'jsdom';

const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
if (!raw) {
  console.error('FIREBASE_SERVICE_ACCOUNT 환경변수가 없습니다.');
  process.exit(1);
}
if (!getApps().length) initializeApp({ credential: cert(JSON.parse(raw)) });
const db = getFirestore();

const MEAL_SOURCE_URL = 'https://gpa.korea.ac.kr/koreaSejong/8028/subview.do';
const DEPT_NOTICE_URL = 'https://aisemi.korea.ac.kr/AISEMI/3600/subview.do';
const DEPT_ORIGIN = 'https://aisemi.korea.ac.kr';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';

/* ===== 시각 계산 (러너는 UTC, 판단은 KST) ===== */
function kstNow() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000);
}
function kstDateStr(d = kstNow()) {
  return d.toISOString().slice(0, 10);
}
// 크론이 몇 분 밀릴 수 있으므로 "지정 시각을 지났고 아직 안 했으면 실행"으로 판단하고,
// 너무 늦게(기본 50분 초과) 도착한 건 건너뛴다.
function isDue(targetH, targetM, graceMinutes = 50) {
  const n = kstNow();
  const minutesNow = n.getUTCHours() * 60 + n.getUTCMinutes();
  const target = targetH * 60 + targetM;
  return minutesNow >= target && minutesNow - target <= graceMinutes;
}
// 이번 주 월요일 날짜(KST). 학식은 주 단위로 한 번만 성공하면 되므로 이 값을 키로 쓴다.
function thisMondayStr() {
  const n = kstNow();
  const dow = n.getUTCDay(); // 0=일 … 1=월
  const diff = dow === 0 ? -6 : 1 - dow;
  const mon = new Date(n.getTime() + diff * 86400000);
  return mon.toISOString().slice(0, 10);
}

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'ko-KR,ko;q=0.9' },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}
const pad = (n) => String(n).padStart(2, '0');

/* ===== 학과 공지 파싱 (앱의 parseDeptNoticeTable과 동일 로직) ===== */
function parseDeptNoticeTable(dom) {
  const table =
    dom.querySelector('table.board-table') ||
    Array.from(dom.querySelectorAll('table')).find((t) => t.querySelector('a[href*="artclView.do"]'));
  if (!table) return [];
  return Array.from(table.querySelectorAll('tbody tr'))
    .map((tr) => {
      const link = tr.querySelector('a[href*="artclView.do"]');
      if (!link) return null;
      const title = (link.textContent || '').replace(/\s+/g, ' ').trim();
      if (!title) return null;
      let href = link.getAttribute('href') || '';
      if (href && !/^https?:\/\//.test(href)) {
        href = DEPT_ORIGIN + (href.startsWith('/') ? href : '/' + href);
      }
      const dateEl = tr.querySelector('.td-date, td.date, td:last-child');
      let date = dateEl ? dateEl.textContent.trim() : '';
      if (!/^\d{4}[.\-]\d{2}[.\-]\d{2}$/.test(date)) date = '';
      return { title, href, date };
    })
    .filter(Boolean)
    .slice(0, 8);
}

/* ===== 학식 파싱 (앱의 cellMenuText / extractDietData / parseMealTables와 동일 로직) ===== */
function cellMenuText(td, doc) {
  if (!td) return '';
  const target = td.querySelector('p.offTxt') || td.querySelector('p') || td;
  const clone = target.cloneNode(true);
  clone.querySelectorAll('br').forEach((br) => br.replaceWith(doc.createTextNode('\n')));
  const rawLines = clone.textContent
    .replace(/ /g, ' ')
    .split('\n')
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  const lines = [];
  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i];
    if (/^kcal$/i.test(line)) {
      if (i + 1 < rawLines.length && /^\d+$/.test(rawLines[i + 1])) i++;
      continue;
    }
    lines.push(line);
  }
  return lines
    .join(', ')
    .replace(/\s*\(\s*\d+(?:\s*,\s*\d+)*\s*\)/g, '')
    .replace(/,?\s*kcal,?\s*\d+/gi, '')
    .replace(/\s*,\s*,/g, ',')
    .replace(/^\s*,\s*|\s*,\s*$/g, '');
}

function getTableHeaderCells(table) {
  const theadCells = Array.from(table.querySelectorAll('thead th, thead td'));
  if (theadCells.length) return theadCells;
  const firstRow = table.querySelector('tr');
  return firstRow ? Array.from(firstRow.children) : [];
}

function extractDietData(table, baseYear, baseMonth, doc) {
  const headCells = getTableHeaderCells(table);
  if (headCells.length < 2) return null;
  const dateCols = headCells.slice(1).map((th) => {
    const m = (th.textContent || '').match(/(\d{1,2})\s*\.\s*(\d{1,2})/);
    if (!m) return null;
    const mm = parseInt(m[1], 10);
    const dd = parseInt(m[2], 10);
    const year = baseMonth === 12 && mm === 1 ? baseYear + 1 : baseYear;
    return `${year}-${pad(mm)}-${pad(dd)}`;
  });
  if (dateCols.every((d) => !d)) return null;

  const data = {};
  dateCols.forEach((d) => {
    if (d) data[d] = { breakfast: '', lunch: '', dinner: '', note: '' };
  });

  Array.from(table.querySelectorAll('tbody tr, tr')).forEach((row) => {
    const cells = Array.from(row.children);
    if (cells.length < 2) return;
    let labelTxt = (cells[0].textContent || '').replace(/ /g, ' ').trim();
    labelTxt = labelTxt.replace(/\(\s*\d{1,2}:\d{2}\s*[~\-]\s*\d{1,2}:\d{2}\s*\)/g, '').trim();

    const mealMatch = labelTxt.match(/^(조식|아침|중식|점심|석식|저녁)\s*[-–·:]?\s*(.*)$/);
    if (!mealMatch) return;
    const mealWord = mealMatch[1];
    const subCategory = (mealMatch[2] || '').trim();

    let key = null;
    if (mealWord === '조식' || mealWord === '아침') key = 'breakfast';
    else if (mealWord === '중식' || mealWord === '점심') key = 'lunch';
    else if (mealWord === '석식' || mealWord === '저녁') key = 'dinner';
    if (!key) return;

    cells.slice(1).forEach((td, i) => {
      const date = dateCols[i];
      if (!date || !data[date]) return;
      const text = cellMenuText(td, doc);
      if (!text) return;
      if (/휴무|공휴일|미운영|휴일|대체공휴일/.test(text) && text.length < 40) {
        data[date].note = text;
        return;
      }
      const entry = subCategory ? `[${subCategory}] ${text}` : text;
      data[date][key] = data[date][key] ? data[date][key] + '\n' + entry : entry;
    });
  });
  return data;
}

function parseMealTables(dom, doc) {
  const bodyText = (dom.body && dom.body.textContent) || '';
  const rawLabels = [...bodyText.matchAll(/(교직원|학생)\s*식단표/g)].map((m) => m[1]);
  const labels = rawLabels.filter((v, i) => i === 0 || v !== rawLabels[i - 1]);

  const tables = Array.from(dom.querySelectorAll('table')).filter((t) => {
    const headText = getTableHeaderCells(t)
      .map((c) => c.textContent || '')
      .join(' ');
    return /\d{1,2}\s*\.\s*\d{1,2}/.test(headText);
  });

  const ym = bodyText.match(/(\d{4})\s*\.\s*(\d{1,2})\s*\.\s*(\d{1,2})/);
  const baseYear = ym ? parseInt(ym[1], 10) : new Date().getFullYear();
  const baseMonth = ym ? parseInt(ym[2], 10) : new Date().getMonth() + 1;

  const results = [];
  tables.forEach((table, i) => {
    const kind = labels[i] === '교직원' ? 'staff' : labels[i] === '학생' ? 'student' : null;
    if (!kind) return;
    const data = extractDietData(table, baseYear, baseMonth, doc);
    if (data) results.push({ kind, data });
  });
  return results;
}

/* ===== 실행 ===== */
async function runDeptNotices() {
  const html = await fetchHtml(DEPT_NOTICE_URL);
  if (!html || html.length < 500 || !/artclView\.do/.test(html)) {
    throw new Error('공지 페이지 응답이 예상과 다름');
  }
  const dom = new JSDOM(html).window.document;
  const items = parseDeptNoticeTable(dom);
  if (!items.length) throw new Error('공지 목록 구조를 인식하지 못함');
  await db.collection('shared').doc('deptNotices').set({ items, updatedAt: Date.now() });
  return items.length;
}

async function runMeals() {
  const html = await fetchHtml(MEAL_SOURCE_URL);
  if (!html || html.length < 500 || !/<table/i.test(html) || !/식단|offTxt|dietMa/.test(html)) {
    throw new Error('식단 페이지 응답이 예상과 다름');
  }
  const window = new JSDOM(html).window;
  const results = parseMealTables(window.document, window.document);
  if (!results.length) throw new Error('식단표 구조를 인식하지 못함');

  const snap = await db.collection('shared').doc('meals').get();
  const byDate = (snap.exists ? snap.data().byDate : {}) || {};
  let dayCount = 0;
  for (const { kind, data } of results) {
    for (const [date, v] of Object.entries(data)) {
      const prev = byDate[date] || {};
      if (kind === 'student') {
        byDate[date] = {
          ...prev,
          student:
            v.breakfast || v.lunch || v.dinner || v.note
              ? { breakfast: v.breakfast, lunch: v.lunch, dinner: v.dinner, note: v.note || '' }
              : null,
          updatedAt: Date.now(),
        };
      } else {
        byDate[date] = {
          ...prev,
          staff: v.lunch || v.note ? { lunch: v.lunch, note: v.note || '' } : null,
          updatedAt: Date.now(),
        };
      }
      if (v.breakfast || v.lunch || v.dinner || v.note) dayCount++;
    }
  }
  if (!dayCount) throw new Error('가져온 식단에 내용이 없음');
  await db.collection('shared').doc('meals').set({ byDate });
  return dayCount;
}

async function main() {
  const ref = db.collection('shared').doc('fetchState');
  const snap = await ref.get();
  const st = snap.exists ? snap.data() : {};
  const doneSlots = new Set(st.doneSlots || []);
  const next = {};
  const newSlots = [];

  const today = kstDateStr();

  // 학과 공지 — 매일 00:00, 12:00
  for (const [h, m] of [[0, 0], [12, 0]]) {
    const slot = `notice_${today}_${pad(h)}${pad(m)}`;
    if (doneSlots.has(slot) || !isDue(h, m)) continue;
    try {
      const n = await runDeptNotices();
      console.log(`학과 공지 갱신 완료 (${pad(h)}:${pad(m)} 슬롯) — ${n}건`);
    } catch (e) {
      console.warn(`학과 공지 갱신 실패 (${pad(h)}:${pad(m)} 슬롯):`, e.message);
    }
    // 성공/실패와 무관하게 이 슬롯은 소진 처리 (다음 슬롯에서 다시 시도)
    newSlots.push(slot);
  }

  // 학식 — 월요일 10:00 → 10:30 → 11:00 → 12:00, 한 번 성공하면 그 주는 더 시도하지 않음
  const monday = thisMondayStr();
  const isMonday = kstNow().getUTCDay() === 1;
  if (isMonday && st.mealFetchedWeek !== monday) {
    for (const [h, m] of [[10, 0], [10, 30], [11, 0], [12, 0]]) {
      const slot = `meal_${today}_${pad(h)}${pad(m)}`;
      if (doneSlots.has(slot) || !isDue(h, m, 25)) continue;
      try {
        const c = await runMeals();
        console.log(`학식 갱신 완료 (${pad(h)}:${pad(m)} 슬롯) — ${c}일치`);
        next.mealFetchedWeek = monday; // 성공했으니 이번 주는 여기서 종료
      } catch (e) {
        console.warn(`학식 갱신 실패 (${pad(h)}:${pad(m)} 슬롯):`, e.message);
      }
      newSlots.push(slot);
      break; // 한 번 실행에 한 슬롯만
    }
  }

  if (newSlots.length || Object.keys(next).length) {
    await ref.set(
      {
        // 최근 40개만 유지 — 슬롯 키는 날짜가 들어가서 계속 새로 생긴다
        doneSlots: [...doneSlots, ...newSlots].slice(-40),
        updatedAt: Date.now(),
        ...next,
      },
      { merge: true }
    );
  } else {
    console.log('실행할 슬롯 없음 — 종료');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
