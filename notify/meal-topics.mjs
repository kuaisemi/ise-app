// 학식 푸시용 FCM 토픽 구성 — 순수 함수(네트워크 없음). Worker(worker-notify/src/meal.js)가 이 토픽으로 보낸다.
//
//   meal_jinri_breakfast — 진리관 + 조식
//   meal_jinri_dinner    — 진리관 + 석식
//   meal_jinri_lunch     — 진리관 + 중식 (미래관은 안 켠 사람)
//   meal_mirae_lunch     — 미래관 + 중식 (진리관은 안 켠 사람)
//   meal_both_lunch      — 진리관·미래관 + 중식을 다 켠 사람 (한 통으로 합쳐 받는다)
//
// 토큰 하나가 같은 끼니의 토픽 두 개에 동시에 들어가면 알림이 두 번 오므로,
// 중식은 반드시 위 셋 중 정확히 하나에만 넣는다.
export const MEAL_TOPIC_NAMES = [
  'meal_jinri_breakfast',
  'meal_jinri_dinner',
  'meal_jinri_lunch',
  'meal_mirae_lunch',
  'meal_both_lunch',
];

// prefs: { jinri, mirae, breakfast, lunch, dinner } (불리언)
export function mealTopicsForPrefs(prefs) {
  const out = [];
  if (!prefs) return out;
  if (prefs.jinri && prefs.breakfast) out.push('meal_jinri_breakfast');
  if (prefs.jinri && prefs.dinner) out.push('meal_jinri_dinner');
  if (prefs.lunch) {
    if (prefs.jinri && prefs.mirae) out.push('meal_both_lunch');
    else if (prefs.jinri) out.push('meal_jinri_lunch');
    else if (prefs.mirae) out.push('meal_mirae_lunch');
  }
  return out;
}

// tokensByUid: Map(uid -> string[]), mealPrefsByUid: Map(uid -> prefs), invalid: Set(token)
// 반환: { topicName: Set(token) } — 모든 토픽 이름이 키로 항상 들어 있다.
export function desiredMealTopics(tokensByUid, mealPrefsByUid, invalid = new Set()) {
  const out = Object.fromEntries(MEAL_TOPIC_NAMES.map((n) => [n, new Set()]));
  for (const [uid, tokens] of tokensByUid) {
    const topics = mealTopicsForPrefs(mealPrefsByUid.get(uid));
    if (!topics.length) continue;
    for (const t of tokens) {
      if (!t || invalid.has(t)) continue;
      for (const name of topics) out[name].add(t);
    }
  }
  return out;
}

// prev: { topicName: string[] } (지난번에 구독시킨 목록), desired: desiredMealTopics() 결과
// 반환: { topicName: { add: string[], remove: string[] } } — 바뀐 게 있는 토픽만.
export function diffMealTopics(prev, desired) {
  const out = {};
  for (const name of MEAL_TOPIC_NAMES) {
    const before = new Set((prev && prev[name]) || []);
    const after = desired[name] || new Set();
    const add = [...after].filter((t) => !before.has(t));
    const remove = [...before].filter((t) => !after.has(t));
    if (add.length || remove.length) out[name] = { add, remove };
  }
  return out;
}
