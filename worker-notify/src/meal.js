// 학식 푸시 계획 — 순수 함수만 둔다(네트워크·저장소 없음). Worker(index.js)가 읽어 온 값을 넣어 주면
// "지금 어떤 토픽으로 무슨 제목·본문을 보내야 하는지"만 돌려준다. 그래서 단독으로 테스트할 수 있다.
//
// 보내는 방식: 사람마다 토큰을 훑지 않고 FCM 토픽으로 한 번에 보낸다(토픽 구독은 GitHub Actions의
// notify/send-notifications.mjs가 users의 학식 설정을 보고 맞춰 둔다).
//   meal_jinri_breakfast / meal_jinri_dinner — 진리관 조식·석식을 켠 사람
//   meal_jinri_lunch  — 진리관 중식만 켠 사람
//   meal_mirae_lunch  — 미래관 중식만 켠 사람
//   meal_both_lunch   — 진리관·미래관 중식을 둘 다 켠 사람(한 통으로 합쳐서 받는다)

export const MEAL_SLOTS = [
  // 조식은 월요일 오전엔 그 주 식단이 아직 없을 수 있어(식단은 GitHub Actions가 받아 둔다) 유예를 길게 둔다.
  { key: 'breakfast', label: '조식', h: 7, m: 0, grace: 240 },
  { key: 'lunch', label: '중식', h: 10, m: 30, grace: 120 },
  { key: 'dinner', label: '석식', h: 16, m: 30, grace: 120 },
];

// dataKey: shared/meals.byDate[날짜] 안에서 그 식당의 메뉴가 들어 있는 필드
export const MEAL_CAFES = [
  { key: 'jinri', short: '진리', dataKey: 'student', slots: ['breakfast', 'lunch', 'dinner'] },
  { key: 'mirae', short: '미래', dataKey: 'staff', slots: ['lunch'] },
];

export const MEAL_TOPICS = {
  jinri: { breakfast: 'meal_jinri_breakfast', lunch: 'meal_jinri_lunch', dinner: 'meal_jinri_dinner' },
  mirae: { lunch: 'meal_mirae_lunch' },
  bothLunch: 'meal_both_lunch',
};

// 저장된 메뉴는 "[한식] 밥, 국..."처럼 줄바꿈으로 나뉘어 있다 — 알림에는 한 줄로 합친다.
// (notify/send-notifications.mjs의 같은 이름 로직과 똑같이 유지한다.)
export function normalizeMenu(menu) {
  return String(menu || '')
    .replace(/\*([^,\n]+)/g, '($1)')
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean)
    .join(' / ');
}

// 그날 그 끼니의 메뉴가 어느 식당에든 들어 있는지(= 아직 못 보낸 게 아니라 "보낼 게 있는" 날인지).
export function slotHasMenu(today, slotKey) {
  if (!today) return false;
  return MEAL_CAFES.some((cafe) => {
    if (!cafe.slots.includes(slotKey)) return false;
    const day = today[cafe.dataKey];
    return !!(day && typeof day === 'object' && String(day[slotKey] || '').trim());
  });
}

/**
 * @param {string} date          KST 날짜 'YYYY-MM-DD'
 * @param {number} minutes       KST 자정부터 지난 분
 * @param {object|null} today    shared/meals.byDate[date] — { student:{breakfast,lunch,dinner}, staff:{lunch} }
 * @param {Set<string>} sentKeys 이미 보낸 것으로 기록된 '날짜_식당_끼니' 키들(발송기 쪽 기록 포함)
 * @returns {Array<{slot:string, topic:string, title:string, body:string, keys:string[]}>}
 *          keys: 이 메시지가 "보냈다"고 기록할 '날짜_식당_끼니' 키들
 */
export function planMealMessages(date, minutes, today, sentKeys) {
  const out = [];
  if (!today) return out;
  for (const slot of MEAL_SLOTS) {
    const diff = minutes - (slot.h * 60 + slot.m);
    if (diff < 0 || diff > slot.grace) continue;

    const entries = [];
    for (const cafe of MEAL_CAFES) {
      if (!cafe.slots.includes(slot.key)) continue;
      const day = today[cafe.dataKey];
      const menu = day && typeof day === 'object' ? String(day[slot.key] || '').trim() : '';
      if (!menu) continue;
      const key = `${date}_${cafe.key}_${slot.key}`;
      if (sentKeys.has(key)) continue;
      entries.push({ cafe, key, body: normalizeMenu(menu) });
    }
    if (!entries.length) continue;

    const keys = entries.map((e) => e.key);
    const title = slot.label;

    if (slot.key !== 'lunch') {
      // 조식·석식은 진리관 하나뿐이라 토픽도 하나다.
      const e = entries[0];
      out.push({ slot: slot.key, topic: MEAL_TOPICS[e.cafe.key][slot.key], title, body: e.body.slice(0, 200), keys });
      continue;
    }

    // 중식: 진리관·미래관 각각의 "그 식당만 켠 사람" 토픽 + 둘 다 켠 사람 토픽.
    for (const e of entries) {
      out.push({ slot: slot.key, topic: MEAL_TOPICS[e.cafe.key].lunch, title, body: e.body.slice(0, 200), keys: [e.key] });
    }
    if (entries.length === 1) {
      // 한 식당 메뉴만 있으면 둘 다 켠 사람에게도 그 메뉴만 그대로(식당 이름 없이) 보낸다.
      out.push({ slot: slot.key, topic: MEAL_TOPICS.bothLunch, title, body: entries[0].body.slice(0, 200), keys: [] });
    } else {
      // 둘 다 있으면 한 통: 식당마다 한 줄 — "(진리) …" 줄바꿈 "(미래) …"
      const per = Math.floor(190 / entries.length) - 6;
      const body = entries.map((e) => `(${e.cafe.short}) ${e.body.slice(0, per)}`).join('\n').slice(0, 200);
      out.push({ slot: slot.key, topic: MEAL_TOPICS.bothLunch, title, body, keys: [] });
    }
  }
  return out;
}
