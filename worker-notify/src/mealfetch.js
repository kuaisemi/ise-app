// 학식 식단 수집 — 학교 페이지(gpa.korea.ac.kr)를 Worker가 직접 받아 shared/meals에 저장한다.
// 원래는 GitHub Actions(notify/fetch-sources.mjs의 runMeals)만 했는데 그 크론이 3~9시간 간격으로
// 드문드문 돌아서, 월요일 아침에 이번 주 식단이 비어 있고 관리자가 앱을 열어 직접 불러와야 했다.
// Worker는 매분 정확히 돌므로 여기서 같은 일을 한다. (jsdom이 없어서 정규식으로 읽는다)
// 이 파일의 파서는 순수 함수라 저장해 둔 HTML로 단독 테스트할 수 있다.

export const MEAL_SOURCE_URL = 'https://gpa.korea.ac.kr/koreaSejong/8028/subview.do';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';

const pad = (n) => String(n).padStart(2, '0');
const decodeEntities = (s) =>
  s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
const stripTags = (s) => decodeEntities(s.replace(/<[^>]*>/g, ''));

// 칸 하나의 메뉴 글자 (fetch-sources.mjs의 cellMenuText와 같은 규칙)
function cellMenuText(tdHtml) {
  const p = tdHtml.match(/<p[^>]*class="offTxt"[^>]*>([\s\S]*?)<\/p>/i) || tdHtml.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
  const inner = p ? p[1] : tdHtml;
  const rawLines = decodeEntities(inner.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, ''))
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

function parseTable(tableHtml, baseYear, baseMonth) {
  const theadM = tableHtml.match(/<thead[\s\S]*?<\/thead>/i);
  const head = theadM ? theadM[0] : '';
  const headCells = [...head.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/gi)].map((m) => stripTags(m[1]));
  if (headCells.length < 2) return null;
  const dateCols = headCells.slice(1).map((t) => {
    const m = t.match(/(\d{1,2})\s*\.\s*(\d{1,2})/);
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

  const body = theadM ? tableHtml.slice(tableHtml.indexOf(theadM[0]) + theadM[0].length) : tableHtml;
  for (const rm of body.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...rm[1].matchAll(/<(th|td)[^>]*>([\s\S]*?)<\/\1>/gi)].map((m) => m[2]);
    if (cells.length < 2) continue;
    const labelTxt = stripTags(cells[0].replace(/<br\s*\/?>/gi, ' '))
      .replace(/\s+/g, ' ')
      .replace(/\(\s*\d{1,2}:\d{2}\s*[~\-]\s*\d{1,2}:\d{2}\s*\)/g, '')
      .trim();
    const mealMatch = labelTxt.match(/^(조식|아침|중식|점심|석식|저녁)\s*[-–·:]?\s*(.*)$/);
    if (!mealMatch) continue;
    const w = mealMatch[1];
    const subCategory = (mealMatch[2] || '').trim();
    const key = w === '조식' || w === '아침' ? 'breakfast' : w === '중식' || w === '점심' ? 'lunch' : 'dinner';

    cells.slice(1).forEach((td, i) => {
      const date = dateCols[i];
      if (!date || !data[date]) return;
      const text = cellMenuText(td);
      if (!text) return;
      if (/휴무|공휴일|미운영|휴일|대체공휴일/.test(text) && text.length < 40) {
        data[date].note = text;
        return;
      }
      const entry = subCategory ? `[${subCategory}] ${text}` : text;
      data[date][key] = data[date][key] ? data[date][key] + '\n' + entry : entry;
    });
  }
  return data;
}

// 반환: [{ kind: 'student'|'staff', data: { 'YYYY-MM-DD': {breakfast,lunch,dinner,note} } }]
export function parseMealHtml(html, nowYear, nowMonth) {
  // 페이지가 2MB인데 거의 다 빈 공백이다 — 식단표 구간만 잘라 공백을 접어 두면 몇 KB가 된다.
  const first = html.indexOf('식단표');
  const last = html.lastIndexOf('</table>');
  if (first < 0 || last < 0) return [];
  const region = html.slice(Math.max(0, first - 400), last + 8).replace(/\s+/g, ' ');

  const results = [];
  for (const tm of region.matchAll(/<table[\s>][\s\S]*?<\/table>/gi)) {
    const t = tm[0];
    const cap = t.match(/<caption[^>]*>([\s\S]*?)<\/caption>/i);
    const capText = cap ? stripTags(cap[1]) : '';
    const kind = /교직원\s*식단표/.test(capText) ? 'staff' : /학생\s*식단표/.test(capText) ? 'student' : null;
    if (!kind) continue;
    const ym = capText.match(/(\d{4})\s*\.\s*(\d{1,2})\s*\.\s*(\d{1,2})/);
    const data = parseTable(t, ym ? parseInt(ym[1], 10) : nowYear, ym ? parseInt(ym[2], 10) : nowMonth);
    if (data) results.push({ kind, data });
  }
  return results;
}

export async function fetchMealHtml() {
  const res = await fetch(MEAL_SOURCE_URL, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'ko-KR,ko;q=0.9' },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// 기존 byDate에 이번에 읽은 값을 합친다. (fetch-sources.mjs runMeals의 병합·정리 규칙과 같다)
// monday/sunday: 이번 주 범위(KST). 이번 주 식단이 하나도 없으면 null을 돌려준다(아직 안 올라온 것).
export function mergeMeals(prevByDate, results, monday, sunday, nowMs) {
  const byDate = { ...(prevByDate || {}) };
  let hasThisWeek = false;
  for (const { kind, data } of results) {
    for (const [date, v] of Object.entries(data)) {
      const has = !!(v.breakfast || v.lunch || v.dinner || v.note);
      if (has && date >= monday && date <= sunday) hasThisWeek = true;
      const prev = byDate[date] || {};
      if (kind === 'student') {
        byDate[date] = {
          ...prev,
          student: has ? { breakfast: v.breakfast, lunch: v.lunch, dinner: v.dinner, note: v.note || '' } : null,
          updatedAt: nowMs,
        };
      } else {
        byDate[date] = {
          ...prev,
          staff: v.lunch || v.note ? { lunch: v.lunch, note: v.note || '' } : null,
          updatedAt: nowMs,
        };
      }
    }
  }
  if (!hasThisWeek) return null;
  for (const date of Object.keys(byDate)) {
    if (date < monday || date > sunday) delete byDate[date];
  }
  return byDate;
}
