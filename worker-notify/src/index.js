// KU ISE — 예약 알림 발송기 (Cloudflare Worker, 매분 실행)
//
// 왜 만들었나:
// 알림 발송은 원래 GitHub Actions 크론이 5분 간격으로 돌렸다. 그런데 GitHub의 스케줄러는
// 정확히 5분을 지켜주지 않고 몇 분씩 더 밀린다("예약 시각"이라는 개념이 성립하지 않는다).
// 일정 알림처럼 "9시 정각에 와야 하는" 알림에는 못 쓴다. Cloudflare Cron Trigger는 매분
// 돌릴 수 있어서 오차가 1분 안으로 들어온다.
//
// 하는 일은 딱 하나다: Firestore의 notifyQueue에서 "발송 시각이 된" 항목을 꺼내 FCM으로
// 보내고 보냈다고 표시한다. 크롤링·계정 정리처럼 오래 걸리는 일은 여전히 GitHub Actions가
// 맡는다(무료 플랜의 CPU 10ms/요청 제한 안에 들어갈 수 없는 작업들이다).
//
// 무료 플랜 한도와 이 코드의 관계:
//   - 외부 요청 50개/실행 → 아래 SUBREQUEST_BUDGET으로 직접 센다. 남은 건 다음 분에 보낸다.
//   - CPU 10ms/요청       → 매분 하는 일은 작은 JSON 몇 개 파싱이 전부다. 비싼 작업(JWT
//                           RSA 서명)은 결과를 KV에 55분 캐싱해서 하루 30번 이하로 줄였다.

/* ===== 무료 한도 관리 ===== */
// 50개가 상한이지만 토큰 발급·조회·기록에도 쓰이므로 발송에는 40개까지만 쓴다.
const SUBREQUEST_BUDGET = 40;
// 한 번에 꺼내오는 큐 항목 수. 예산보다 넉넉히 가져와도 예산이 먼저 바닥나면 거기서 멈춘다.
const QUEUE_FETCH_LIMIT = 50;

/* ===== 공휴일 판정 =====
   규칙 원본은 notify/holidays.mjs다. 여기 있는 건 그 사본이고, public/index.html에도 같은
   사본이 있다(런타임이 달라 한 파일을 공유할 수 없음). 셋 중 하나를 고치면 셋 다 고쳐야 한다. */
const HOLIDAY_LUNAR_BY_YEAR = {
  2026: { seollal: '2026-02-17', chuseok: '2026-09-25', buddha: '2026-05-24' },
  // 2027 설날은 2/7(일). 학교 학사일정(설날 2/6~2/8 + 대체 2/9)과 일치시킨 값.
  2027: { seollal: '2027-02-07', chuseok: '2027-09-15', buddha: '2027-05-13' },
};
const HOLIDAY_EXTRA_BY_YEAR = { 2026: ['2026-06-03'], 2027: [] };
const pad2 = (n) => String(n).padStart(2, '0');
const fmtDate = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const parseDate = (s) => { const [y, m, d] = String(s).split('-').map(Number); return new Date(y, (m || 1) - 1, d || 1); };

// 대체공휴일 조건 — 관공서의 공휴일에 관한 규정 제3조.
//   'weekend'(제2항) 토·일과 겹치면 대체. 삼일절·어린이날·석탄일·광복절·개천절·한글날·성탄절.
//   'sunday' (제1항) "다른 공휴일과 겹치는 경우"만. 설날·추석 연휴. 토요일은 법정 공휴일이
//            아니라 대체가 안 생긴다(2026년 추석 9/26 토 → 9/28 대체공휴일 없음).
function holidayFallbackFor(year) {
  const lunar = HOLIDAY_LUNAR_BY_YEAR[year];
  if (!lunar) return [];
  const threeDays = (s) => {
    const base = parseDate(s);
    return [-1, 0, 1].map((off) => { const d = new Date(base); d.setDate(d.getDate() + off); return fmtDate(d); });
  };
  const base = [
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
    ...(HOLIDAY_EXTRA_BY_YEAR[year] || []).map((date) => ({ date, sub: false })),
  ];
  const taken = new Set(base.map((h) => h.date));
  const out = base.map((h) => h.date);
  for (const h of base) {
    if (!h.sub) continue;
    const dow = parseDate(h.date).getDay();
    if (!(h.sub === 'weekend' ? dow === 0 || dow === 6 : dow === 0)) continue;
    const cur = parseDate(h.date);
    for (let i = 0; i < 10; i++) {
      cur.setDate(cur.getDate() + 1);
      const s = fmtDate(cur), d = cur.getDay();
      if (d === 0 || d === 6 || taken.has(s)) continue;
      taken.add(s); out.push(s); break;
    }
  }
  return out;
}
function isHolidayDate(holidayDoc, dateStr) {
  const year = Number(String(dateStr).slice(0, 4));
  if (!year) return false;
  const fromServer = holidayDoc && holidayDoc.byYear && holidayDoc.byYear[String(year)];
  const list = Array.isArray(fromServer) && fromServer.length ? fromServer : holidayFallbackFor(year);
  return list.includes(dateStr);
}

/* ===== 반복 알림 =====
   "매일" 또는 "매주 월·수·금"처럼 설정된 알림은 한 번 보내고 끝나는 게 아니라, 보낸 직후
   다음 차례 시각을 스스로 계산해 다시 예약한다(sent를 true로 찍지 않고 at만 앞으로 민다).
   앞으로 몇 번 보낼지 미리 큐에 쌓아두지 않는 이유: 사용자가 시각이나 요일을 바꾸면 쌓아둔
   걸 전부 찾아 고쳐야 하는데, 한 건만 굴리면 그럴 일이 없다. */
function nextRepeatAt(item) {
  const repeat = item.repeat;
  if (!repeat || !repeat.kind || repeat.kind === 'none') return null;

  // 저장된 "보낼 시각"(HH:MM)을 기준으로 다음 날짜를 찾는다. 발송이 밀려서 at이 과거로
  // 한참 내려가 있어도, 항상 "지금보다 뒤"인 가장 가까운 차례로 맞춘다.
  const [hh, mm] = String(item.repeatTime || '09:00').split(':').map(Number);
  const nowKst = kstNow();
  // KST 기준 날짜 계산을 위해 UTC 게터를 쓴다(kstNow는 +9h를 더해둔 값이라 UTC 게터가 KST를 가리킨다).
  const cursor = new Date(Date.UTC(nowKst.getUTCFullYear(), nowKst.getUTCMonth(), nowKst.getUTCDate(), hh || 0, mm || 0));
  const days = Array.isArray(repeat.days) ? repeat.days : [];

  for (let i = 0; i <= 14; i++) {
    const cand = new Date(cursor.getTime() + i * 86400000);
    if (cand.getTime() <= nowKst.getTime()) continue; // 오늘치가 이미 지났으면 내일부터
    if (repeat.kind === 'weekly' && days.length && !days.includes(cand.getUTCDay())) continue;
    // cand는 KST 기준 시각이므로, 실제 저장할 epoch로 되돌리려면 9시간을 뺀다.
    return cand.getTime() - 9 * 60 * 60 * 1000;
  }
  return null; // 2주 안에 해당하는 요일이 없으면(요일 목록이 비었거나 이상하면) 반복을 끝낸다
}

/* ===== KST 시각 =====
   Worker는 UTC로 돈다. "지금 야간인가", "오늘이 공휴일인가"는 전부 KST 기준이어야 한다. */
const kstNow = () => new Date(Date.now() + 9 * 60 * 60 * 1000);
const kstDateStr = () => kstNow().toISOString().slice(0, 10);
// 22시~다음날 7시(KST)에는 야간 알림에 동의한 사람에게만 보낸다 — 기존 GitHub Actions
// 발송기(notify/send-notifications.mjs의 isQuietHour)와 같은 규칙.
function isQuietHour() {
  const h = kstNow().getUTCHours();
  return h >= 22 || h < 7;
}

/* ===== 구글 액세스 토큰 (서비스 계정 JWT → OAuth2) =====
   RSA 서명은 이 Worker에서 제일 비싼 연산이라 결과를 KV에 55분 캐싱한다(토큰 수명 60분).
   그래서 실제로는 하루 26번 남짓만 서명한다. */
function b64url(buf) {
  const bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf;
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function pemToDer(pem) {
  const body = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const bin = atob(body);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}
async function mintAccessToken(sa) {
  const iat = Math.floor(Date.now() / 1000);
  const claim = {
    iss: sa.client_email,
    // Firestore 읽기·쓰기와 FCM 발송 두 가지가 필요하다.
    scope: 'https://www.googleapis.com/auth/datastore https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    iat,
    exp: iat + 3600,
  };
  const unsigned = `${b64url(new TextEncoder().encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })))}.${b64url(new TextEncoder().encode(JSON.stringify(claim)))}`;
  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToDer(sa.private_key),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned));
  const jwt = `${unsigned}.${b64url(sig)}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${jwt}`,
  });
  if (!res.ok) throw new Error(`토큰 발급 실패 ${res.status} ${(await res.text()).slice(0, 200)}`);
  return (await res.json()).access_token;
}
async function getAccessToken(env, budget) {
  const cached = await env.NOTIFY_CACHE.get('access_token');
  if (cached) return cached;
  budget.spend(); // oauth2 호출 1회
  const token = await mintAccessToken(JSON.parse(env.FIREBASE_SERVICE_ACCOUNT));
  // 수명 60분짜리를 55분만 쓴다 — 만료 직전에 걸려 401이 나는 일을 피하려는 여유분.
  await env.NOTIFY_CACHE.put('access_token', token, { expirationTtl: 55 * 60 });
  return token;
}

/* ===== Firestore REST =====
   서비스 계정으로 붙으므로 보안 규칙을 우회한다(Admin SDK와 같은 권한). */
function fsBase(pid) {
  return `https://firestore.googleapis.com/v1/projects/${pid}/databases/(default)/documents`;
}
// Firestore REST는 값에 타입 껍데기를 씌워 보낸다. 필요한 타입만 벗겨낸다.
function decodeValue(v) {
  if (v == null) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue' in v) return null;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(decodeValue);
  if ('mapValue' in v) return decodeFields(v.mapValue.fields || {});
  return null;
}
function decodeFields(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields || {})) out[k] = decodeValue(v);
  return out;
}
async function fsGetDoc(env, token, path, budget) {
  budget.spend();
  const res = await fetch(`${fsBase(env.FIREBASE_PROJECT_ID)}/${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`문서 읽기 실패 ${path} ${res.status}`);
  const j = await res.json();
  return decodeFields(j.fields);
}
// 발송 시각이 지났는데 아직 안 보낸 항목을 이른 순서대로 가져온다.
// (sent ASC, at ASC 복합 인덱스가 firestore.indexes.json에 있어야 동작한다)
async function fsQueryDueNotifications(env, token, nowMs, budget) {
  budget.spend();
  const res = await fetch(`${fsBase(env.FIREBASE_PROJECT_ID)}:runQuery`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: 'notifyQueue' }],
        where: {
          compositeFilter: {
            op: 'AND',
            filters: [
              { fieldFilter: { field: { fieldPath: 'sent' }, op: 'EQUAL', value: { booleanValue: false } } },
              { fieldFilter: { field: { fieldPath: 'at' }, op: 'LESS_THAN_OR_EQUAL', value: { integerValue: String(nowMs) } } },
            ],
          },
        },
        orderBy: [{ field: { fieldPath: 'at' }, direction: 'ASCENDING' }],
        limit: QUEUE_FETCH_LIMIT,
      },
    }),
  });
  if (!res.ok) throw new Error(`큐 조회 실패 ${res.status} ${(await res.text()).slice(0, 300)}`);
  const rows = await res.json();
  return rows
    .filter((r) => r.document)
    .map((r) => ({
      name: r.document.name,             // projects/.../documents/notifyQueue/{id}
      id: r.document.name.split('/').pop(),
      ...decodeFields(r.document.fields),
    }));
}
// 처리한 항목들의 상태를 한 번의 commit으로 기록한다(항목 수와 무관하게 외부 요청 1회).
async function fsCommitUpdates(env, token, updates, budget) {
  if (!updates.length) return;
  budget.spend();
  const writes = updates.map((u) => ({
    update: {
      name: u.name,
      fields: {
        sent: { booleanValue: !!u.sent },
        sentAt: { integerValue: String(Date.now()) },
        // 반복 알림은 여기서 다음 차례 시각으로 밀린다(sent는 false로 남는다).
        ...(u.at != null ? { at: { integerValue: String(u.at) } } : {}),
        ...(u.cursor != null ? { cursor: { integerValue: String(u.cursor) } } : {}),
        ...(u.error ? { lastError: { stringValue: String(u.error).slice(0, 300) } } : {}),
      },
    },
    // 지정한 필드만 건드린다 — 이게 없으면 나머지 필드가 전부 지워진다.
    updateMask: {
      fieldPaths: [
        'sent', 'sentAt',
        ...(u.at != null ? ['at'] : []),
        ...(u.cursor != null ? ['cursor'] : []),
        ...(u.error ? ['lastError'] : []),
      ],
    },
  }));
  const res = await fetch(`${fsBase(env.FIREBASE_PROJECT_ID)}:commit`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ writes }),
  });
  if (!res.ok) throw new Error(`발송 표시 실패 ${res.status} ${(await res.text()).slice(0, 300)}`);
}

/* ===== FCM HTTP v1 =====
   v1에는 멀티캐스트가 없어서 토큰 하나당 요청 하나다. 그래서 전교생 발송은 토큰을 훑지 않고
   토픽으로 보낸다 — 받는 사람이 몇 명이든 요청 1회로 끝난다.
   (토픽 구독은 GitHub Actions 쪽에서 firebase-admin의 subscribeToTopic으로 해둔다) */
const TOPIC_ALL = 'ise_all';       // 전체
const TOPIC_NIGHT = 'ise_night';   // 야간 알림에 동의한 사람만
function tapData(item) {
  const out = {};
  if (item.pairId) out.pairId = item.pairId;
  if (item.cohortYear) out.cohortYear = item.cohortYear;
  return Object.keys(out).length ? out : null;
}
// 같은 대화에서 메시지가 여러 개 연달아 오면 알림이 한 장씩 계속 쌓인다 — 카톡처럼 한
// 자리에서 최신 내용으로 갱신되게 하려면 안드로이드 알림에 같은 tag를 줘야 한다(같은
// tag의 알림은 새로 오면 이전 것을 대체한다). 대화 하나당 tag 하나:
//   친구 채팅   — 그 pairId
//   학생회 채팅 — 방이 하나뿐이라 고정 문자열
//   학번별 채팅 — 그 학번
// 채팅이 아닌 알림(공지·투표 등)은 각각 다른 내용이라 대체되면 안 되므로 tag를 안 준다.
function notificationTag(item) {
  if (item.pairId) return `chat_${item.pairId}`;
  return null;
}
async function fcmSend(env, token, target, title, body, category, budget, extraData, tag) {
  budget.spend();
  const message = {
    ...target, // { token } 또는 { topic }
    notification: { title, body },
    // extraData — 채팅 알림의 pairId처럼, 눌렀을 때 어디로 갈지에 필요한 추가 정보.
    // FCM data 필드는 값이 전부 문자열이어야 해서 String()으로 감싼다.
    data: {
      url: './index.html',
      ...(category ? { category } : {}),
      ...Object.fromEntries(Object.entries(extraData || {}).map(([k, v]) => [k, String(v)])),
    },
    // channel_id는 항상 붙인다 — MainActivity.createNotificationChannel()이 만든
    // IMPORTANCE_HIGH 채널로 보내야 진동만이 아니라 화면 위 배너(헤드업)로도 뜬다.
    // 이걸 빼면 FCM이 기본 중요도짜리 자체 채널로 보내서 조용히 목록에만 쌓인다.
    android: { notification: { channel_id: 'ku_ise_default', ...(tag ? { tag } : {}) } },
  };
  const res = await fetch(
    `https://fcm.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/messages:send`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
    }
  );
  if (res.ok) return { ok: true };
  const text = (await res.text()).slice(0, 300);
  // 만료·무효 토큰은 실패로 세지 않는다 — 기기를 지웠거나 앱을 삭제한 경우라서, 다시
  // 보내봐야 영영 성공하지 않는다. (토큰 정리는 GitHub Actions 쪽이 이미 하고 있다)
  const gone = res.status === 404 || /UNREGISTERED|INVALID_ARGUMENT/.test(text);
  return { ok: false, gone, error: `${res.status} ${text}` };
}

/* ===== 본체 ===== */
function makeBudget(limit) {
  let used = 0;
  return {
    spend() { used++; },
    get used() { return used; },
    left() { return limit - used; },
  };
}

async function runOnce(env) {
  const budget = makeBudget(SUBREQUEST_BUDGET);
  const token = await getAccessToken(env, budget);
  const nowMs = Date.now();

  const due = await fsQueryDueNotifications(env, token, nowMs, budget);
  if (!due.length) return { sent: 0, items: 0, subrequests: budget.used };

  // 수신 대상 목록은 5분에 한 번만 Firestore에서 읽고 나머지 4분은 KV에서 꺼내 쓴다.
  // (GitHub Actions가 5분마다 shared/pushAudience를 새로 쓴다)
  let audience = await env.NOTIFY_CACHE.get('audience', 'json');
  if (!audience) {
    audience = await fsGetDoc(env, token, 'shared/pushAudience', budget);
    // 문서가 아예 없으면 캐싱하지 않는다 — GitHub Actions가 아직 한 번도 안 돈 상태라
    // 곧 생길 값이다. 빈 값을 5분간 캐싱하면 그 사이 알림이 전부 "받을 사람 없음"으로
    // 처리돼 조용히 사라진다.
    if (audience) await env.NOTIFY_CACHE.put('audience', JSON.stringify(audience), { expirationTtl: 300 });
  }

  // 공휴일 목록은 하루 한 번만 바뀌므로 6시간 캐싱.
  let holidays = await env.NOTIFY_CACHE.get('holidays', 'json');
  if (!holidays) {
    holidays = (await fsGetDoc(env, token, 'shared/holidays', budget)) || { byYear: {} };
    await env.NOTIFY_CACHE.put('holidays', JSON.stringify(holidays), { expirationTtl: 6 * 3600 });
  }

  const quiet = isQuietHour();
  const todayIsHoliday = isHolidayDate(holidays, kstDateStr());
  const updates = [];

  // 채팅은 메시지마다 큐 항목이 생기고, 한 항목이 받는 사람 수만큼 FCM 요청을 쓴다(실행당 한도 50개).
  // 한 사람이 1분 안에 같은 대화에 연달아 보낸 메시지는 알림을 각각 보낼 이유가 없으니(같은
  // tag라 어차피 한 자리에서 덮어써진다) 마지막 것 하나만 보내고 나머지는 보낸 것으로 처리한다.
  // 이미 일부 토큰에 나간 항목(cursor>0)과 채팅 메시지가 아닌 알림(공지 갱신 등)은 건드리지 않는다.
  const coalesceKey = (it) => {
    if (Number(it.cursor || 0) > 0) return null;
    if (it.audience === 'user' && it.gateKey === 'chat' && it.pairId) return `chat|${it.pairId}|${it.targetUid}|${it.uid}`;
    return null;
  };
  const lastIdByKey = new Map();
  for (const it of due) { const k = coalesceKey(it); if (k) lastIdByKey.set(k, it.id); }
  const toSend = [];
  let coalescedCount = 0;
  for (const it of due) {
    const k = coalesceKey(it);
    if (k && lastIdByKey.get(k) !== it.id) {
      updates.push({ name: it.name, sent: true });
      coalescedCount++;
    } else {
      toSend.push(it);
    }
  }

  let sentCount = 0;
  let skippedNoAudience = 0; // 대상 목록이 없어 다음 실행으로 미룬 개인 알림 수
  let repeatedCount = 0;     // 발송 후 다음 차례로 재예약된 반복 알림 수

  // 한 항목의 처리를 끝낼 때 쓰는 마무리. 반복 설정이 있으면 "완료"로 찍지 않고 다음 차례
  // 시각으로 밀어둔다 — 그래야 같은 문서 하나가 계속 굴러가면서 매일/매주 알림이 이어진다.
  const settle = (item, extra = {}) => {
    const next = nextRepeatAt(item);
    if (next == null) return { name: item.name, sent: true, ...extra };
    repeatedCount++;
    // cursor는 "토큰 몇 개까지 보냈는지" 표시라, 다음 차례에는 처음부터 다시 보내야 한다.
    return { name: item.name, sent: false, at: next, cursor: 0, ...extra };
  };

  for (const item of toSend) {
    // 예산이 바닥나면 남은 항목은 손대지 않는다. sent가 false로 남아 있으므로 다음 분에
    // 그대로 다시 조회돼서 이어서 나간다 — 이게 "누락분 재발송"이다.
    if (budget.left() <= 1) break;

    // 평일에만 의미 있는 알림(시간표 등)은 공휴일이면 보내지 않고 처리 완료로 넘긴다.
    if (item.skipOnHoliday && todayIsHoliday) {
      updates.push(settle(item));
      continue;
    }

    // 학생회·학번별 채팅은 기능이 없어졌다. 옛 버전 앱이 아직 큐에 넣을 수 있으니 보내지 않고
    // 처리 완료로 넘긴다(아래 else 분기로 떨어지면 보낸 사람 본인에게 가버린다).
    if (item.audience === 'councilChat' || item.audience === 'cohortChat') {
      updates.push({ name: item.name, sent: true });
      continue;
    }

    if (item.audience === 'all') {
      // 전교생 발송 — 토픽 하나로 끝난다. 야간에는 동의자 토픽으로 대상을 좁힌다.
      const topic = quiet ? TOPIC_NIGHT : TOPIC_ALL;
      const r = await fcmSend(env, token, { topic }, item.title, item.body, item.category, budget, tapData(item), notificationTag(item));
      if (r.ok) { sentCount++; updates.push(settle(item)); }
      else updates.push({ name: item.name, sent: false, error: r.error });
      continue;
    }

    // 대상 목록 자체가 아직 없으면(Actions가 한 번도 안 돌았거나 일시적 실패) 이 항목은
    // 손대지 않고 넘긴다. 여기서 "완료"로 찍어버리면 알림이 영영 안 가고 흔적도 안 남는다.
    if (!audience) {
      skippedNoAudience++;
      continue;
    }

    // 대상 토큰 결정. audience 값에 따라 어디서 찾을지가 다르다:
    //   self                          — 만든 사람 본인 (audience.byUid[item.uid])
    //   user + targetUid              — 그 uid 한 명 (audience.byUid[item.targetUid]).
    //                                   gateKey가 있으면(chat/councilChat/cohortChat) 그
    //                                   사람이 해당 알림을 켰는지도 같이 본다 — 꺼둔 사람에게
    //                                   억지로 보내면 안 된다.
    //   notice/poll/recruit/bugAlert/councilAlert — 그 카테고리를 구독한 사람들 전체
    //                                   (audience[category], Actions가 5분마다 채워둔 배열)
    let tokens;
    if (item.audience === 'user') {
      const gateOk = !item.gateKey || (audience[item.gateKey + 'OkUids'] || []).includes(item.targetUid);
      tokens = gateOk ? (audience.byUid && audience.byUid[item.targetUid]) || [] : [];
    } else if (['notice', 'poll', 'recruit', 'bugAlert', 'councilAlert'].includes(item.audience)) {
      // 이 글을 쓴 사람이 그 카테고리 알림도 켜둔 경우(예: 학생회가 공지 알림도 구독 중),
      // 자기가 방금 올린 글의 알림을 자기도 받는 걸 막는다.
      const own = (audience.byUid && audience.byUid[item.uid]) || [];
      tokens = (audience[item.audience] || []).filter((t) => !own.includes(t));
    } else {
      tokens = (audience.byUid && audience.byUid[item.uid]) || [];
    }

    // 채팅은 이미 읽은 사람에게는 안 보낸다. 메시지를 보낸 뒤 발송까지 최대 1분이 걸리는데,
    // 그 사이 상대가 채팅방을 열어서(실시간 리스너로) 이미 봤을 수 있다 — 그런데도 알림이
    // 오면 "읽은 메시지 알림이 뒤늦게 오는" 성가신 경험이 된다.
    if (item.audience === 'user' && item.gateKey === 'chat' && item.pairId) {
      const link = await fsGetDoc(env, token, `friendLinks/${item.pairId}`, budget);
      const seenAt = link && link.lastSeenAt && link.lastSeenAt[item.targetUid];
      if (seenAt && seenAt >= item.at) tokens = [];
    }

    if (!tokens.length) {
      // 알림을 켠 적이 없거나(opt-in 안 함), 꺼둔 사람이거나, 이미 읽었거나, 토큰이
      // 정리된 사람 — 다시 시도해도 같으니 완료로 둔다.
      updates.push(settle(item));
      continue;
    }
    // 개인 알림(self/user)만 야간 규칙을 적용한다. notice/poll/recruit 같은 카테고리
    // 배열은 이미 그 자체로 구독자 목록이라 별도 야간 필터가 없다 — 기존 Actions 발송기도
    // 카테고리 알림엔 야간 규칙을 적용하지 않았다(공지·투표·구인은 원래 즉시성 알림).
    if (['self', 'user'].includes(item.audience) && quiet && !(audience.night || []).some((t) => tokens.includes(t))) {
      updates.push(settle(item));
      continue;
    }
    // 토큰이 여러 개인데 예산이 모자라면 보낸 데까지 cursor에 적어두고 다음 분에 이어서 보낸다.
    let i = Number(item.cursor || 0);
    let failed = null;
    for (; i < tokens.length; i++) {
      if (budget.left() <= 1) break;
      const r = await fcmSend(env, token, { token: tokens[i] }, item.title, item.body, item.category, budget, tapData(item), notificationTag(item));
      if (r.ok) sentCount++;
      else if (!r.gone) failed = r.error; // 만료 토큰은 실패로 치지 않는다
    }
    if (i >= tokens.length) updates.push(settle(item, failed ? { error: failed } : {}));
    else updates.push({ name: item.name, sent: false, cursor: i });
  }

  await fsCommitUpdates(env, token, updates, budget);
  if (skippedNoAudience) {
    console.warn(`[notify] shared/pushAudience가 없어 개인 알림 ${skippedNoAudience}건을 미룸 — GitHub Actions가 한 번 돌아야 생깁니다`);
  }
  return { sent: sentCount, items: updates.length, skipped: skippedNoAudience, repeated: repeatedCount, coalesced: coalescedCount, subrequests: budget.used };
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      runOnce(env)
        .then((r) => {
          // 보낼 게 없는 분이 대부분이라, 실제로 뭔가 한 경우만 로그를 남긴다
          // (wrangler tail로 볼 때 빈 줄이 1분마다 쌓이지 않도록).
          if (r.items || r.skipped) console.log(`[notify] 발송 ${r.sent}건 / 처리 ${r.items}건 / 반복재예약 ${r.repeated}건 / 미룸 ${r.skipped}건 / 외부요청 ${r.subrequests}개`);
        })
        .catch((e) => console.error('[notify] 실패:', e && e.message))
    );
  },

  // 크론을 기다리지 않고 바로 한 번 돌려보고 싶을 때 쓰는 수동 실행구.
  // 배포 주소를 알면 누구나 부를 수 있으므로, 서비스 계정 JSON의 private_key_id 뒷자리를
  // 아는 사람만 통과시킨다(이 값은 secret 안에만 있고 앱·저장소에는 없다).
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== '/run') return new Response('ku-ise-notify', { status: 200 });
    const sa = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);
    if (url.searchParams.get('key') !== String(sa.private_key_id).slice(-8)) {
      return new Response('unauthorized', { status: 401 });
    }
    try {
      const r = await runOnce(env);
      return new Response(JSON.stringify(r), { headers: { 'Content-Type': 'application/json' } });
    } catch (e) {
      return new Response(`실패: ${e && e.message}`, { status: 500 });
    }
  },
};
