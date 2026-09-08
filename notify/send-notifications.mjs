// GitHub Actions 크론(10분 간격)으로 실행되는 무료 알림 발송 스크립트.
// Firebase Cloud Functions(=Blaze 요금제 필요) 없이도 푸시 알림을 보내기 위한 대안 —
// 신뢰할 수 있는 실행 환경에서 서비스 계정 키로 Firestore를 읽고 firebase-admin으로 직접 발송한다.
//
// 보내는 알림 종류
//   1) 새 공지          → 감지 즉시
//   2) 새 투표 시작      → 감지 즉시
//   3) 진행 중인 투표    → 매일 20:00 KST 한 번
//   4) 투표 마감 30분 전 → 투표당 한 번
//   5) 식단             → 조식 07:00 / 중식 10:30 / 석식 16:30 KST
//   6) 새 버그 제보      → 감지 즉시 (개발자·학생회장 전용)
//   6.5) 새 건의사항     → 감지 즉시 (학생회 전용)
//   7) 건의사항 답변     → 감지 즉시 (작성자 본인 전용)
//   8) 친구 채팅         → 감지 즉시 (채팅 알림을 켠 수신자 전용)
//   8.5) 학생회 단체 채팅 → 감지 즉시 (학생회 채팅 알림을 켠 학생회 구성원 전용)
//
// 필요한 비밀값: 저장소 Settings → Secrets and variables → Actions에
//   FIREBASE_SERVICE_ACCOUNT = Firebase 콘솔에서 발급한 서비스 계정 JSON 전체 내용

import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { getMessaging } from 'firebase-admin/messaging';
import { getAuth } from 'firebase-admin/auth';

const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
if (!raw) {
  console.error('FIREBASE_SERVICE_ACCOUNT 환경변수가 없습니다. GitHub Secrets 설정을 확인하세요.');
  process.exit(1);
}

initializeApp({ credential: cert(JSON.parse(raw)) });
const db = getFirestore();
const messaging = getMessaging();

const CHUNK = 500;   // FCM 멀티캐스트 1회 최대 토큰 수
const KEEP_IDS = 300; // notifyState에 남겨두는 "이미 보낸 id" 최대 개수

// GitHub Actions 러너는 UTC로 돈다. 모든 시각 판단은 KST(UTC+9) 기준으로 해야 함.
function kstNow() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000);
}
function kstDateStr(d = kstNow()) {
  return d.toISOString().slice(0, 10);
}
// 크론이 몇 분씩 밀릴 수 있으므로 "정각 ±5분"이 아니라 "지정 시각을 지났고 아직 안 보냈으면 보낸다"로
// 판단한다. 대신 너무 늦게(기본 60분 초과) 도착한 건 건너뛴다 — 워크플로가 한동안 멈췄다가
// 재개됐을 때 새벽에 아침 식단 알림이 뒤늦게 날아가는 걸 막기 위함.
function isDue(targetH, targetM, graceMinutes = 60) {
  const n = kstNow();
  const minutesNow = n.getUTCHours() * 60 + n.getUTCMinutes();
  const target = targetH * 60 + targetM;
  return minutesNow >= target && minutesNow - target <= graceMinutes;
}
// 22시~다음날 7시 사이(KST)엔, 야간 알림에 동의한 사람에게만 보낸다 — 동의 안 한 사람은
// 그 시간에 발송된 공지·투표 푸시를 아예 못 받고(나중에 다시 보내지 않음), 앱을 켜면 그때 보게 된다.
function isQuietHour() {
  const h = kstNow().getUTCHours();
  return h >= 22 || h < 7;
}

const live = (arr) => (arr || []).filter((x) => x && x.id && !x.deleted);

function pollEndsAt(p) {
  const dt = p.endDateTime || p.endDate;
  if (!dt) return null;
  // 앱이 저장하는 값은 KST 기준 로컬 시간 문자열이므로, KST로 해석되도록 +09:00을 명시한다.
  const iso = dt.includes('T') ? `${dt}:00+09:00` : `${dt}T23:59:59+09:00`;
  const t = new Date(iso);
  return isNaN(t.getTime()) ? null : t;
}
function isPollActive(p) {
  if (p.closed) return false;
  const end = pollEndsAt(p);
  return !end || end.getTime() > Date.now();
}

// 앱은 삭제를 tombstone(deleted:true)으로 처리한다 — 오프라인이던 기기가 나중에 접속했을 때
// 삭제된 글이 되살아나는 걸 막기 위해 "삭제됨" 표시를 남겨두는 방식. 다만 영원히 쌓이면
// 문서가 계속 커지므로, 삭제 표시 후 24시간이 지난 항목은 Firestore에서 실제로 제거한다.
// (24시간이면 대부분의 기기가 최소 한 번은 동기화하고도 남는 시간)
const TOMBSTONE_TTL_MS = 24 * 60 * 60 * 1000;
const TOMBSTONE_DOCS = [
  { name: 'notices', field: 'list' },
  { name: 'polls', field: 'list' },
  { name: 'suggestions', field: 'list' },
  { name: 'recruitments', field: 'list' },
  { name: 'councilPosts', field: 'list' },
  { name: 'bugReports', field: 'list' },
  { name: 'calendarEvents', field: 'events' },
];

// 탈퇴 대기열 처리.
// 앱(클라이언트 SDK)은 남의 Firebase Auth 계정을 지울 수 없다 — 본인 계정이거나 Admin SDK만
// 가능하다. 그래서 회장이 탈퇴시키면 프로필·시간표·명단은 앱이 지우고, 로그인 계정만
// shared/pendingAuthDeletes에 쌓아둔 뒤 여기서 대신 지운다.
// (지우기 전까지도 프로필과 명단이 없어서 그 계정은 로그인이 막힌 상태다)
async function purgePendingAuthDeletes() {
  const ref = db.collection('shared').doc('pendingAuthDeletes');
  const snap = await ref.get();
  if (!snap.exists) return;
  const list = Array.isArray(snap.data().list) ? snap.data().list : [];
  if (!list.length) return;

  const remaining = [];
  let removed = 0;
  for (const entry of list) {
    const uid = typeof entry === 'string' ? entry : entry && entry.uid;
    if (!uid) continue;                       // 형태가 깨진 항목은 그냥 버린다
    try {
      await getAuth().deleteUser(uid);
      removed++;
      console.log('[authPurge] 삭제', uid, (entry && entry.studentId) || '');
    } catch (e) {
      if (e && e.code === 'auth/user-not-found') {
        removed++;                            // 이미 없으면 처리된 것으로 본다
      } else {
        remaining.push(entry);                // 그 밖의 오류는 다음 실행에서 다시 시도
        console.error('[authPurge] 실패', uid, (e && e.code) || e);
      }
    }
  }
  await ref.set({ list: remaining }, { merge: true });
  console.log(`[authPurge] ${removed}건 삭제, ${remaining.length}건 남음`);
}

async function purgeOldTombstones() {
  const cutoff = Date.now() - TOMBSTONE_TTL_MS;
  for (const { name, field } of TOMBSTONE_DOCS) {
    try {
      const ref = db.collection('shared').doc(name);
      const snap = await ref.get();
      if (!snap.exists) continue;
      const items = snap.data()[field];
      if (!Array.isArray(items)) continue;
      const kept = items.filter((it) => {
        if (!it || !it.deleted) return true;
        // updatedAt이 없는 오래된 데이터는 지금 기준으로 판단할 수 없으니 이번엔 남겨두고,
        // 삭제 시각을 기록해 다음 실행부터 TTL이 적용되게 한다.
        if (!it.updatedAt) {
          it.updatedAt = Date.now();
          return true;
        }
        return it.updatedAt > cutoff;
      });
      if (kept.length !== items.length) {
        await ref.set({ [field]: kept }, { merge: true });
        console.log(`${name}: 만료된 삭제 항목 ${items.length - kept.length}건 완전 삭제`);
      }
    } catch (e) {
      console.warn(`${name} 정리 실패:`, e && e.message);
    }
  }
}

// 친구 채팅은 게시물과 달리 "삭제 표시(tombstone)" 없이, 메시지가 생긴 지 24시간이
// 지나면 그냥 완전히 지운다. 대화 내용을 보관할 이유가 없고(신고 시에는 이미 신고
// 접수 시점에 최근 대화를 별도로 복사해 남겨둔다), 계속 쌓아두면 문서 수만 늘어난다.
// chats/{pairId}/messages 서브컬렉션이 계정 쌍마다 따로 있어서, 하나씩 돌지 않고
// collectionGroup으로 전체 메시지 컬렉션을 한 번에 훑는다.
async function purgeOldChatMessages() {
  const cutoff = Date.now() - TOMBSTONE_TTL_MS;
  const snap = await db.collectionGroup('messages').where('createdAt', '<', cutoff).get();
  if (snap.empty) return;
  const batchSize = 400; // Firestore 배치 쓰기 한도(500)보다 여유 있게
  const docs = snap.docs;
  for (let i = 0; i < docs.length; i += batchSize) {
    const batch = db.batch();
    docs.slice(i, i + batchSize).forEach((d) => batch.delete(d.ref));
    await batch.commit();
  }
  console.log(`[chatPurge] 24시간 지난 메시지 ${docs.length}건 삭제`);
}

// 학생회 채팅은 친구 채팅(24시간)보다 길게, 7일치를 보관한 뒤 지운다 — 방이 하나뿐이라
// collectionGroup이 아니라 컬렉션을 바로 조회한다.
const COUNCIL_CHAT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
async function purgeOldCouncilChatMessages() {
  const cutoff = Date.now() - COUNCIL_CHAT_TTL_MS;
  const snap = await db.collection('councilChatMessages').where('createdAt', '<', cutoff).get();
  if (snap.empty) return;
  const batchSize = 400;
  const docs = snap.docs;
  for (let i = 0; i < docs.length; i += batchSize) {
    const batch = db.batch();
    docs.slice(i, i + batchSize).forEach((d) => batch.delete(d.ref));
    await batch.commit();
  }
  console.log(`[councilChatPurge] 7일 지난 메시지 ${docs.length}건 삭제`);
}

async function main() {
  const [noticesSnap, pollsSnap, mealsSnap, bugReportsSnap, suggestionsSnap, stateSnap, usersSnap] = await Promise.all([
    db.collection('shared').doc('notices').get(),
    db.collection('shared').doc('polls').get(),
    db.collection('shared').doc('meals').get(),
    db.collection('shared').doc('bugReports').get(),
    db.collection('shared').doc('suggestions').get(),
    db.collection('shared').doc('notifyState').get(),
    db.collection('users').get(),
  ]);

  // 앱은 삭제를 tombstone(deleted:true)으로 처리하므로 반드시 걸러내야 한다.
  const notices = live(noticesSnap.exists ? noticesSnap.data().list : []);
  const polls = live(pollsSnap.exists ? pollsSnap.data().list : []);
  const mealsByDate = (mealsSnap.exists ? mealsSnap.data().byDate : {}) || {};
  const bugReports = live(bugReportsSnap.exists ? bugReportsSnap.data().list : []);
  const suggestions = live(suggestionsSnap.exists ? suggestionsSnap.data().list : []);
  const st = stateSnap.exists ? stateSnap.data() : {};

  const notifiedNotice = new Set(st.notifiedNoticeIds || []);
  const notifiedPoll = new Set(st.notifiedPollIds || []);
  const warnedPollEnd = new Set(st.warnedPollEndIds || []);
  const sentMealKeys = new Set(st.sentMealKeys || []);
  const notifiedBugReport = new Set(st.notifiedBugReportIds || []);
  const notifiedSuggestionAnswer = new Set(st.notifiedSuggestionAnswerIds || []);
  const notifiedSuggestionNew = new Set(st.notifiedSuggestionNewIds || []);
  const lastPollReminderDate = st.lastPollReminderDate || '';

  // 카테고리별 수신 대상 토큰 수집.
  // 한 사람이 폰 앱 + PC 브라우저를 같이 쓸 수 있어 토큰은 배열(fcmTokens)로 관리한다.
  // fcmToken(단일 필드)은 구버전 클라이언트 호환용.
  const tokensBy = { notice: [], poll: [], meal: [] };
  const bugAlertTokens = []; // 개발자 · 학생회장: 버그 제보는 알림 설정과 무관하게 항상 받음
  const councilAlertTokens = []; // 학생회(국장 이상): 새 건의사항은 알림 설정과 무관하게 항상 받음
  const nightOkTokens = new Set(); // 야간(22시~7시) 알림에 동의한 토큰만
  const tokensByStudentId = new Map(); // 건의사항 답변처럼 "그 사람에게만" 보낼 때 씀
  const tokensByUid = new Map(); // 채팅처럼 uid로만 상대를 아는 경우
  const chatOkUids = new Set(); // 채팅 알림을 켜둔 사람만
  const councilChatOkUids = new Set(); // 학생회 채팅 알림을 켜둔 학생회 구성원만
  const nameByUid = new Map();
  const tokenToUid = new Map();
  usersSnap.forEach((docSnap) => {
    const u = docSnap.data();
    const tokens = [...new Set([...(u.fcmTokens || []), ...(u.fcmToken ? [u.fcmToken] : [])])];
    nameByUid.set(docSnap.id, u.name || '친구');
    if (!tokens.length) return;
    const prefs = u.notifyPrefs || {};
    if (u.studentId) tokensByStudentId.set(u.studentId, tokens);
    tokensByUid.set(docSnap.id, tokens);
    if (prefs.chat) chatOkUids.add(docSnap.id);
    if (prefs.councilChat && u.role && u.role !== 'student') councilChatOkUids.add(docSnap.id);
    for (const t of tokens) {
      tokenToUid.set(t, docSnap.id);
      if (prefs.notice) tokensBy.notice.push(t);
      if (prefs.poll) tokensBy.poll.push(t);
      if (prefs.meal) tokensBy.meal.push(t);
      if (prefs.night) nightOkTokens.add(t);
      if (u.role === 'developer' || u.role === 'president') bugAlertTokens.push(t);
      if (u.role && u.role !== 'student') councilAlertTokens.push(t);
    }
  });

  const invalidTokens = new Set();
  let sentCount = 0;

  async function send(category, title, body) {
    let tokens = tokensBy[category];
    if (isQuietHour()) {
      tokens = tokens.filter((t) => nightOkTokens.has(t));
      if (!tokens.length) {
        console.log(`(야간 시간대 — ${category} 알림에 동의한 사람이 없어 발송 생략)`);
        return;
      }
    }
    if (!tokens.length) return;
    for (let i = 0; i < tokens.length; i += CHUNK) {
      const batch = tokens.slice(i, i + CHUNK);
      const res = await messaging.sendEachForMulticast({
        tokens: batch,
        notification: { title, body },
        data: { url: './index.html' },
      });
      res.responses.forEach((r, idx) => {
        if (r.success) return;
        const code = r.error && r.error.code;
        if (
          code === 'messaging/invalid-registration-token' ||
          code === 'messaging/registration-token-not-registered'
        ) {
          invalidTokens.add(batch[idx]);
        } else {
          console.warn('발송 실패:', code, r.error && r.error.message);
        }
      });
    }
    sentCount++;
  }

  const nextState = {};

  // 1) 새 공지 — 작성자가 "알림 발송"을 켠 공지만 보낸다(기본 꺼짐).
  //    보내지 않는 공지도 처리 완료로 기록해서, 나중에 켜지지도 않았는데 뒤늦게 발송되는 걸 막는다.
  const newNotices = notices.filter((n) => !notifiedNotice.has(n.id));
  for (const n of newNotices) {
    if (!n.notifyPush) {
      console.log('새 공지(알림 발송 꺼짐, 건너뜀):', n.title);
      continue;
    }
    console.log('새 공지 알림:', n.title);
    await send('notice', '새로운 공지가 있어요', `제목: ${n.title}`);
  }

  // 2) 새 투표 시작 — 공지와 마찬가지로 작성자가 "알림 발송"을 켠 투표만 보낸다(기본 꺼짐).
  const newPolls = polls.filter((p) => !notifiedPoll.has(p.id));
  for (const p of newPolls) {
    if (!p.notifyPush) {
      console.log('새 투표(알림 발송 꺼짐, 건너뜀):', p.question);
      continue;
    }
    console.log('새 투표 알림:', p.question);
    await send('poll', '새 투표가 시작됐어요', `제목: ${p.question}`);
  }

  // 3) 진행 중인 투표 — 매일 20:00 KST 한 번만.
  //    알림 발송을 끈 투표는 리마인더 대상에서도 빠진다.
  const today = kstDateStr();
  const activePolls = polls.filter((p) => isPollActive(p) && p.notifyPush);
  if (activePolls.length && lastPollReminderDate !== today && isDue(20, 0)) {
    const head = activePolls[0].question;
    const body =
      activePolls.length > 1 ? `${head} 외 ${activePolls.length - 1}건` : `제목: ${head}`;
    console.log('진행 중 투표 리마인더:', body);
    await send('poll', '아직 참여하지 않은 투표가 있어요', body);
    nextState.lastPollReminderDate = today;
  }

  // 4) 투표 마감 30분 전 (투표당 한 번)
  const endingSoon = activePolls.filter((p) => {
    if (warnedPollEnd.has(p.id)) return false;
    const end = pollEndsAt(p);
    if (!end) return false;
    const minutesLeft = (end.getTime() - Date.now()) / 60000;
    return minutesLeft > 0 && minutesLeft <= 30;
  });
  for (const p of endingSoon) {
    console.log('투표 마감 임박 알림:', p.question);
    await send('poll', '곧 마감되는 투표가 있어요', `제목: ${p.question} (30분 후 마감)`);
  }

  // 5) 식단 — 조식 07:00 / 중식 10:30 / 석식 16:30 KST
  const MEAL_SLOTS = [
    { key: 'breakfast', label: '조식', h: 7, m: 0 },
    { key: 'lunch', label: '중식', h: 10, m: 30 },
    { key: 'dinner', label: '석식', h: 16, m: 30 },
  ];
  const todayMeal = (mealsByDate[today] && mealsByDate[today].student) || null;
  const newMealKeys = [];
  if (todayMeal) {
    for (const slot of MEAL_SLOTS) {
      const dedupKey = `${today}_${slot.key}`;
      if (sentMealKeys.has(dedupKey)) continue;
      if (!isDue(slot.h, slot.m)) continue;
      const menu = (todayMeal[slot.key] || '').trim();
      if (!menu) continue;
      // 저장된 메뉴는 "[한식] 밥, 국..." 처럼 줄바꿈으로 구분되어 있어 한 줄로 합쳐 보낸다.
      const body = menu.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).join(' / ').slice(0, 200);
      console.log(`식단 알림(${slot.label}):`, body.slice(0, 40));
      await send('meal', `오늘의 ${slot.label}`, body);
      newMealKeys.push(dedupKey);
    }
  }

  // 6) 새 버그 제보 — 개발자 · 학생회장에게는 알림 설정과 무관하게 항상 즉시 알림.
  const newBugReports = bugReports.filter((r) => !notifiedBugReport.has(r.id));
  if (newBugReports.length && bugAlertTokens.length) {
    for (const r of newBugReports) {
      console.log('새 버그 제보 알림:', r.title);
      for (let i = 0; i < bugAlertTokens.length; i += CHUNK) {
        const batch = bugAlertTokens.slice(i, i + CHUNK);
        const res = await messaging.sendEachForMulticast({
          tokens: batch,
          notification: { title: '새 버그 제보가 있어요', body: `제목: ${r.title}` },
          data: { url: './index.html' },
        });
        res.responses.forEach((resp, idx) => {
          if (resp.success) return;
          const code = resp.error && resp.error.code;
          if (
            code === 'messaging/invalid-registration-token' ||
            code === 'messaging/registration-token-not-registered'
          ) {
            invalidTokens.add(batch[idx]);
          } else {
            console.warn('발송 실패:', code, resp.error && resp.error.message);
          }
        });
      }
      sentCount++;
    }
  }

  // 6.5) 새 건의사항 — 학생회(국장 이상)에게는 알림 설정과 무관하게 항상 즉시 알림.
  const newSuggestions = suggestions.filter((s) => !notifiedSuggestionNew.has(s.id));
  if (newSuggestions.length && councilAlertTokens.length) {
    for (const s of newSuggestions) {
      console.log('새 건의사항 알림:', s.title || s.content);
      for (let i = 0; i < councilAlertTokens.length; i += CHUNK) {
        const batch = councilAlertTokens.slice(i, i + CHUNK);
        const res = await messaging.sendEachForMulticast({
          tokens: batch,
          notification: { title: '새 건의사항이 올라왔어요', body: `제목: ${s.title || s.content}` },
          data: { url: './index.html' },
        });
        res.responses.forEach((resp, idx) => {
          if (resp.success) return;
          const code = resp.error && resp.error.code;
          if (
            code === 'messaging/invalid-registration-token' ||
            code === 'messaging/registration-token-not-registered'
          ) {
            invalidTokens.add(batch[idx]);
          } else {
            console.warn('발송 실패:', code, resp.error && resp.error.message);
          }
        });
      }
      sentCount++;
    }
  }

  // 7) 건의사항에 답변이 달리면 그 글을 쓴 학생에게만 보낸다 (게시판 전체 알림이 아니라
  //    개인 알림이라, 다른 사람의 "공지" 알림 설정과는 무관하게 본인 토큰이 있으면 보낸다).
  const newAnswers = suggestions.filter(
    (s) => s.status === '답변완료' && s.studentId && !notifiedSuggestionAnswer.has(s.id)
  );
  for (const s of newAnswers) {
    const allTokens = tokensByStudentId.get(s.studentId) || [];
    const tokens = isQuietHour() ? allTokens.filter((t) => nightOkTokens.has(t)) : allTokens;
    if (!tokens.length) {
      console.log('건의사항 답변 알림(수신 토큰 없음, 건너뜀):', s.title || s.content);
      continue;
    }
    console.log('건의사항 답변 알림:', s.title || s.content);
    const res = await messaging.sendEachForMulticast({
      tokens,
      notification: { title: '건의사항에 답변이 달렸어요', body: `제목: ${s.title || s.content}` },
      data: { url: './index.html' },
    });
    res.responses.forEach((resp, idx) => {
      if (resp.success) return;
      const code = resp.error && resp.error.code;
      if (
        code === 'messaging/invalid-registration-token' ||
        code === 'messaging/registration-token-not-registered'
      ) {
        invalidTokens.add(tokens[idx]);
      } else {
        console.warn('발송 실패:', code, resp.error && resp.error.message);
      }
    });
    sentCount++;
  }

  // 8) 친구 채팅 — 지난 실행 이후 새로 온 메시지를 받는 사람에게만 보낸다. pairId(두 uid를
  //    사전순으로 이어붙인 값)가 곧 메시지의 부모(chats/{pairId}) 문서 id라, 거기서 상대
  //    uid를 바로 뽑아낼 수 있다(보낸 사람 자신에게는 당연히 안 보낸다).
  const lastChatCheck = st.lastChatCheck || Date.now() - 15 * 60 * 1000; // 처음 실행이면 최근 15분만
  const chatRunStartedAt = Date.now();
  const newMsgsSnap = await db.collectionGroup('messages').where('createdAt', '>', lastChatCheck).get();
  if (!newMsgsSnap.empty) {
    for (const d of newMsgsSnap.docs) {
      const m = d.data();
      const pairId = d.ref.parent.parent.id; // chats/{pairId}/messages/{msgId}
      const uids = pairId.split('_');
      const recipientUid = uids.find((u) => u !== m.senderUid);
      if (!recipientUid || !chatOkUids.has(recipientUid)) continue;
      const allTokens = tokensByUid.get(recipientUid) || [];
      const tokens = isQuietHour() ? allTokens.filter((t) => nightOkTokens.has(t)) : allTokens;
      if (!tokens.length) continue;
      const senderName = nameByUid.get(m.senderUid) || '친구';
      const res = await messaging.sendEachForMulticast({
        tokens,
        notification: { title: `${senderName}님의 메시지`, body: String(m.text || '').slice(0, 80) },
        data: { url: './index.html' },
      });
      res.responses.forEach((resp, idx) => {
        if (resp.success) return;
        const code = resp.error && resp.error.code;
        if (
          code === 'messaging/invalid-registration-token' ||
          code === 'messaging/registration-token-not-registered'
        ) {
          invalidTokens.add(tokens[idx]);
        }
      });
      sentCount++;
    }
    console.log(`[chatNotify] 새 메시지 ${newMsgsSnap.size}건 확인, 알림 발송 시도`);
  }
  nextState.lastChatCheck = chatRunStartedAt;

  // 8.5) 학생회 단체 채팅 — 방이 하나뿐이라 pairId 없이 컬렉션 전체를 그대로 훑는다.
  //      보낸 사람 본인 제외, 학생회 채팅 알림을 켠 학생회 구성원에게만 보낸다.
  const lastCouncilChatCheck = st.lastCouncilChatCheck || Date.now() - 15 * 60 * 1000;
  const councilChatRunStartedAt = Date.now();
  const newCouncilMsgsSnap = await db
    .collection('councilChatMessages')
    .where('createdAt', '>', lastCouncilChatCheck)
    .get();
  if (!newCouncilMsgsSnap.empty) {
    for (const d of newCouncilMsgsSnap.docs) {
      const m = d.data();
      for (const recipientUid of councilChatOkUids) {
        if (recipientUid === m.senderUid) continue;
        const allTokens = tokensByUid.get(recipientUid) || [];
        const tokens = isQuietHour() ? allTokens.filter((t) => nightOkTokens.has(t)) : allTokens;
        if (!tokens.length) continue;
        const res = await messaging.sendEachForMulticast({
          tokens,
          notification: {
            title: `${m.senderName || '학생회'}님의 학생회 채팅`,
            body: String(m.text || '').slice(0, 80),
          },
          data: { url: './index.html' },
        });
        res.responses.forEach((resp, idx) => {
          if (resp.success) return;
          const code = resp.error && resp.error.code;
          if (
            code === 'messaging/invalid-registration-token' ||
            code === 'messaging/registration-token-not-registered'
          ) {
            invalidTokens.add(tokens[idx]);
          }
        });
        sentCount++;
      }
    }
    console.log(`[councilChatNotify] 새 메시지 ${newCouncilMsgsSnap.size}건 확인, 알림 발송 시도`);
  }
  nextState.lastCouncilChatCheck = councilChatRunStartedAt;

  if (!sentCount) {
    console.log('보낼 알림 없음 — 종료');
  }

  // 상태 저장 (중복 발송 방지용 커서)
  await db.collection('shared').doc('notifyState').set(
    {
      notifiedNoticeIds: [...notifiedNotice, ...newNotices.map((n) => n.id)].slice(-KEEP_IDS),
      notifiedPollIds: [...notifiedPoll, ...newPolls.map((p) => p.id)].slice(-KEEP_IDS),
      warnedPollEndIds: [...warnedPollEnd, ...endingSoon.map((p) => p.id)].slice(-KEEP_IDS),
      sentMealKeys: [...sentMealKeys, ...newMealKeys].slice(-30),
      notifiedBugReportIds: [...notifiedBugReport, ...newBugReports.map((r) => r.id)].slice(-KEEP_IDS),
      notifiedSuggestionAnswerIds: [...notifiedSuggestionAnswer, ...newAnswers.map((s) => s.id)].slice(-KEEP_IDS),
      notifiedSuggestionNewIds: [...notifiedSuggestionNew, ...newSuggestions.map((s) => s.id)].slice(-KEEP_IDS),
      updatedAt: Date.now(),
      ...nextState,
    },
    { merge: true }
  );

  await purgeOldTombstones();
  await purgePendingAuthDeletes();
  await purgeOldChatMessages();
  await purgeOldCouncilChatMessages();

  // 만료/무효 토큰 정리 — 배열에서 해당 토큰만 빼고, 단일 필드는 그 토큰일 때만 지운다.
  if (invalidTokens.size) {
    const batch = db.batch();
    const byUid = new Map();
    for (const [token, uid] of tokenToUid.entries()) {
      if (!invalidTokens.has(token)) continue;
      if (!byUid.has(uid)) byUid.set(uid, []);
      byUid.get(uid).push(token);
    }
    for (const [uid, tokens] of byUid.entries()) {
      const ref = db.collection('users').doc(uid);
      const update = { fcmTokens: FieldValue.arrayRemove(...tokens) };
      const current = usersSnap.docs.find((d) => d.id === uid);
      if (current && tokens.includes(current.data().fcmToken)) {
        update.fcmToken = FieldValue.delete();
      }
      batch.update(ref, update);
    }
    await batch.commit();
    console.log(`만료된 토큰 ${invalidTokens.size}개 정리 완료`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
