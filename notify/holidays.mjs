// 대한민국 공휴일 판정 — 알림·셔틀·시간표가 모두 이 규칙 하나만 본다.
//
// 값이 어디서 오는가(우선순위 순):
//   1. shared/holidays 문서 — fetch-sources.mjs가 하루 한 번 공공데이터포털 특일정보 API에서
//      받아 저장한다. 임시공휴일처럼 갑자기 지정되는 날까지 반영되는 유일한 경로.
//   2. 아래 FALLBACK 표 — API 키가 없거나 호출이 실패해도 앱이 멀쩡히 돌게 하는 안전망.
//
// 같은 규칙이 public/index.html(앱)과 worker-notify(발송기)에도 들어가 있다. 런타임이 서로 달라
// 물리적으로 한 파일을 공유할 수 없어서, "규칙의 원본"은 이 파일로 정하고 나머지 두 곳은
// 여기를 보고 똑같이 유지한다. 바꿀 일이 생기면 세 곳을 같이 고쳐야 한다.

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseYmd = (s) => {
  const [y, m, d] = String(s).split('-').map(Number);
  return new Date(y, m - 1, d);
};

// 음력에서 오는 날짜(설날 당일·추석 당일·부처님오신날)와 그 해에만 있는 공휴일(선거일)만
// 연도별로 적는다. 나머지 양력 고정 공휴일과 대체공휴일은 아래에서 계산한다.
// 여기 없는 연도는 FALLBACK이 비게 되고, 그때는 shared/holidays만 쓴다.
const LUNAR_BY_YEAR = {
  2026: { seollal: '2026-02-17', chuseok: '2026-09-25', buddha: '2026-05-24' },
  2027: { seollal: '2027-02-06', chuseok: '2027-09-15', buddha: '2027-05-13' },
};
const EXTRA_BY_YEAR = {
  2026: ['2026-06-03'], // 제9회 전국동시지방선거
  2027: [],
};

// 대체공휴일 발생 조건 — 관공서의 공휴일에 관한 규정 제3조를 그대로 옮긴 것.
//
//   'weekend' (제2항) 토요일이나 일요일과 겹치면 대체공휴일.
//             삼일절·어린이날·부처님오신날·광복절·개천절·한글날·성탄절.
//   'sunday'  (제1항) "다른 공휴일과 겹치는 경우"에만. 설날·추석 연휴가 여기 해당한다.
//             토요일은 법정 공휴일이 아니라서 대체공휴일이 생기지 않고, 일요일은 그 자체가
//             공휴일(제2조제1호)이라 생긴다. ★ 설·추석에 토요일 규칙을 잘못 적용하면
//             2026년 추석(9/26 토)처럼 있지도 않은 대체공휴일 9/28을 만들어낸다.
//   false     대체공휴일 없음. 신정·현충일·선거일.
function baseHolidaysOf(year) {
  const lunar = LUNAR_BY_YEAR[year];
  if (!lunar) return null;
  // 설날·추석은 당일 기준 전날·당일·다음날 3일이 연휴다.
  const threeDays = (dateStr) => {
    const base = parseYmd(dateStr);
    return [-1, 0, 1].map((off) => {
      const d = new Date(base);
      d.setDate(d.getDate() + off);
      return ymd(d);
    });
  };
  return [
    { date: `${year}-01-01`, sub: false },
    ...threeDays(lunar.seollal).map((date) => ({ date, sub: 'sunday' })),
    { date: `${year}-03-01`, sub: 'weekend' },
    { date: `${year}-05-05`, sub: 'weekend' },
    { date: lunar.buddha, sub: 'weekend' },
    { date: `${year}-06-06`, sub: false },
    { date: `${year}-08-15`, sub: 'weekend' },
    ...threeDays(lunar.chuseok).map((date) => ({ date, sub: 'sunday' })),
    { date: `${year}-10-03`, sub: 'weekend' },
    { date: `${year}-10-09`, sub: 'weekend' },
    { date: `${year}-12-25`, sub: 'weekend' },
    ...(EXTRA_BY_YEAR[year] || []).map((date) => ({ date, sub: false })),
  ];
}

// 대체공휴일까지 붙인 그 해 전체 공휴일 날짜 배열(YYYY-MM-DD, 오름차순).
function fallbackHolidaysOf(year) {
  const base = baseHolidaysOf(year);
  if (!base) return [];
  const taken = new Set(base.map((h) => h.date));
  const out = [...base.map((h) => h.date)];
  for (const h of base) {
    if (!h.sub) continue;
    const dow = parseYmd(h.date).getDay();
    const triggers = h.sub === 'weekend' ? dow === 0 || dow === 6 : dow === 0;
    if (!triggers) continue;
    // "그 다음의 첫 번째 비공휴일" — 이미 공휴일인 날과 주말은 건너뛴다.
    const cur = parseYmd(h.date);
    for (let i = 0; i < 10; i++) {
      cur.setDate(cur.getDate() + 1);
      const s = ymd(cur);
      const d = cur.getDay();
      if (d === 0 || d === 6 || taken.has(s)) continue;
      taken.add(s);
      out.push(s);
      break;
    }
  }
  return out.sort();
}

const FALLBACK_CACHE = {};
export function fallbackHolidays(year) {
  if (!FALLBACK_CACHE[year]) FALLBACK_CACHE[year] = fallbackHolidaysOf(year);
  return FALLBACK_CACHE[year];
}

// shared/holidays 문서 모양: { byYear: { "2026": ["2026-01-01", ...] }, updatedAt }
// doc이 없거나 그 해가 비어 있으면 내장 표로 떨어진다.
export function holidaySetFor(doc, year) {
  const fromDoc = doc && doc.byYear && doc.byYear[String(year)];
  const list = Array.isArray(fromDoc) && fromDoc.length ? fromDoc : fallbackHolidays(year);
  return new Set(list);
}

// 아래 셋이 바깥에서 실제로 쓰는 판정 함수. dateStr은 항상 'YYYY-MM-DD'.
export function isHoliday(doc, dateStr) {
  const year = Number(String(dateStr).slice(0, 4));
  if (!year) return false;
  return holidaySetFor(doc, year).has(dateStr);
}
// 셔틀의 "쉬는 날" 판정 기준 — 주말이거나 공휴일.
export function isRestDay(doc, dateStr) {
  const dow = parseYmd(dateStr).getDay();
  if (dow === 0 || dow === 6) return true;
  return isHoliday(doc, dateStr);
}
// 평일 알림(오늘의 시간표 등)을 보내도 되는 날 — 월~금이면서 공휴일이 아닌 날.
export function isSchoolWeekday(doc, dateStr) {
  const dow = parseYmd(dateStr).getDay();
  if (dow === 0 || dow === 6) return false;
  return !isHoliday(doc, dateStr);
}

export { ymd, parseYmd };
