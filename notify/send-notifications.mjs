// GitHub Actions 크론(5분 간격)으로 실행되는 무료 알림 발송 스크립트.
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
//   8.7) 친구 요청 도착 / 친구 수락 → 감지 즉시 (알림 설정과 무관하게 항상)
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
    let authGone = false;
    try {
      await getAuth().deleteUser(uid);
      authGone = true;
      removed++;
      console.log('[authPurge] 삭제', uid, (entry && entry.studentId) || '');
    } catch (e) {
      if (e && e.code === 'auth/user-not-found') {
        authGone = true;
        removed++;                            // 이미 없으면 처리된 것으로 본다
      } else {
        remaining.push(entry);                // 그 밖의 오류는 다음 실행에서 다시 시도
        console.error('[authPurge] 실패', uid, (e && e.code) || e);
      }
    }
    if (authGone) {
      // 친구 검색용 studentDirectory/{uid}는 본인만 지울 수 있게 규칙이 걸려 있어서
      // (남의 uid라 클라이언트가 못 지움), Admin SDK로 여기서 대신 지운다. 안 지우면
      // 탈퇴시킨 학번으로도 계속 "친구 추가" 검색이 되는 유령 학번 문제가 생긴다.
      await db.collection('studentDirectory').doc(uid).delete().catch(() => {});
    }
  }
  await ref.set({ list: remaining }, { merge: true });
  console.log(`[authPurge] ${removed}건 삭제, ${remaining.length}건 남음`);
}

// 가입 중 프로필(users/{uid}) 저장이 실패하면(네트워크 끊김 등) 로그인 계정만 남아
// 그 학번으로 다시는 가입할 수 없는 유령 계정이 된다. 클라이언트가 실패 시 즉시
// 되돌리도록 고쳤지만(2026-09-08), 그 전에 이미 생긴 것과 향후 놓치는 경우를 대비해
// 여기서도 주기적으로 훑어서 프로필 없는 계정을 지운다.
// 가입 진행 중(계정 생성 → 프로필 저장 사이, 명단 대조 대기 5초 포함)인 계정을 실수로
// 지우지 않을 정도의 여유만 두고, 크론(5분 간격)이 도는 대로 바로바로 정리되게
// 짧게 잡는다.
const GHOST_ACCOUNT_GRACE_MS = 2 * 60 * 1000;
async function listAllAuthUsers() {
  const all = [];
  let pageToken;
  do {
    const page = await getAuth().listUsers(1000, pageToken);
    all.push(...page.users);
    pageToken = page.pageToken;
  } while (pageToken);
  return all;
}
async function purgeGhostAuthAccounts(authUsers) {
  const usersSnap = await db.collection('users').get();
  const profiledUids = new Set(usersSnap.docs.map((d) => d.id));
  let removed = 0;
  for (const u of authUsers) {
    if (profiledUids.has(u.uid)) continue;
    const createdAt = new Date(u.metadata.creationTime).getTime();
    if (Date.now() - createdAt < GHOST_ACCOUNT_GRACE_MS) continue;
    try {
      await getAuth().deleteUser(u.uid);
      removed++;
      console.log('[ghostPurge] 삭제', u.uid, u.email || '');
    } catch (e) {
      console.warn('[ghostPurge] 실패', u.uid, (e && e.code) || e);
    }
  }
  if (removed) console.log(`[ghostPurge] 프로필 없는 계정 ${removed}건 삭제`);
}

// 예전에 계정이 지워졌는데(직접 탈퇴, 관리자 탈퇴, 유령 계정 정리 등) 그 uid로 만들어둔
// studentDirectory(친구 검색용 공개 명단) 항목이 같이 안 지워지고 남는 경우가 있었다 —
// 로그인 계정은 없는데 "친구 추가"에서는 검색되는 유령 학번이 되는 원인. 학과 명단
// (roster/shared)은 절대 건드리지 않고, studentDirectory와 그걸 참조하는 friendLinks만
// 로그인 계정 존재 여부로 대조해서 정리한다.
async function purgeOrphanedDirectoryAndFriendLinks(authUsers) {
  const authUids = new Set(authUsers.map((u) => u.uid));
  const dirSnap = await db.collection('studentDirectory').get();
  let dirRemoved = 0;
  for (const d of dirSnap.docs) {
    if (authUids.has(d.id)) continue;
    try {
      await d.ref.delete();
      dirRemoved++;
      console.log('[dirPurge] 삭제', d.id, (d.data() && d.data().studentId) || '');
    } catch (e) {
      console.warn('[dirPurge] 실패', d.id, (e && e.code) || e);
    }
  }
  if (dirRemoved) console.log(`[dirPurge] 로그인 계정 없는 학번 검색 정보 ${dirRemoved}건 삭제`);

  const linksSnap = await db.collection('friendLinks').get();
  let linksRemoved = 0;
  for (const d of linksSnap.docs) {
    const uids = d.data().uids || [];
    if (uids.length && uids.every((u) => authUids.has(u))) continue;
    try {
      await d.ref.delete();
      linksRemoved++;
      console.log('[friendLinkPurge] 삭제', d.id);
    } catch (e) {
      console.warn('[friendLinkPurge] 실패', d.id, (e && e.code) || e);
    }
  }
  if (linksRemoved) console.log(`[friendLinkPurge] 유령 계정 관련 친구 관계 ${linksRemoved}건 삭제`);
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
  const [noticesSnap, pollsSnap, mealsSnap, bugReportsSnap, suggestionsSnap, recruitmentsSnap, stateSnap, usersSnap, friendLinksSnap] = await Promise.all([
    db.collection('shared').doc('notices').get(),
    db.collection('shared').doc('polls').get(),
    db.collection('shared').doc('meals').get(),
    db.collection('shared').doc('bugReports').get(),
    db.collection('shared').doc('suggestions').get(),
    db.collection('shared').doc('recruitments').get(),
    db.collection('shared').doc('notifyState').get(),
    db.collection('users').get(),
    db.collection('friendLinks').get(),
  ]);
  // pairId -> { uid: true } — 그 사람이 이 채팅만 콕 집어 알림을 꺼둔 경우.
  const mutedByPair = new Map();
  // pairId -> { uid: ts } — 그 사람이 이 채팅을 마지막으로 읽어본 시각. 크론이 도는 사이에
  // 앱을 직접 열어서 이미 읽었으면(메시지 시각보다 이 값이 더 최근이면) 굳이 푸시를 또 보낼
  // 필요가 없다.
  const lastSeenByPair = new Map();
  friendLinksSnap.forEach((d) => {
    const data = d.data();
    if (data.mutedBy) mutedByPair.set(d.id, data.mutedBy);
    if (data.lastSeenAt) lastSeenByPair.set(d.id, data.lastSeenAt);
  });

  // 앱은 삭제를 tombstone(deleted:true)으로 처리하므로 반드시 걸러내야 한다.
  const notices = live(noticesSnap.exists ? noticesSnap.data().list : []);
  const polls = live(pollsSnap.exists ? pollsSnap.data().list : []);
  const mealsByDate = (mealsSnap.exists ? mealsSnap.data().byDate : {}) || {};
  const bugReports = live(bugReportsSnap.exists ? bugReportsSnap.data().list : []);
  const suggestions = live(suggestionsSnap.exists ? suggestionsSnap.data().list : []);
  const recruitments = live(recruitmentsSnap.exists ? recruitmentsSnap.data().list : []);
  const st = stateSnap.exists ? stateSnap.data() : {};

  const notifiedNotice = new Set(st.notifiedNoticeIds || []);
  const notifiedPoll = new Set(st.notifiedPollIds || []);
  const warnedPollEnd = new Set(st.warnedPollEndIds || []);
  const sentMealKeys = new Set(st.sentMealKeys || []);
  const notifiedBugReport = new Set(st.notifiedBugReportIds || []);
  const notifiedSuggestionAnswer = new Set(st.notifiedSuggestionAnswerIds || []);
  const notifiedSuggestionNew = new Set(st.notifiedSuggestionNewIds || []);
  const notifiedRecruitment = new Set(st.notifiedRecruitmentIds || []);
  const lastPollReminderDate = st.lastPollReminderDate || '';

  // 카테고리별 수신 대상 토큰 수집.
  // 한 사람이 폰 앱 + PC 브라우저를 같이 쓸 수 있어 토큰은 배열(fcmTokens)로 관리한다.
  // fcmToken(단일 필드)은 구버전 클라이언트 호환용.
  const tokensBy = { notice: [], poll: [], recruit: [] };
  const mealPrefsByUid = new Map(); // uid -> { jinri, mirae, breakfast, lunch, dinner } — 학식은 지점·끼니를 각자 따로 켤 수 있어 카테고리 하나로 뭉뚱그릴 수 없다.
  const bugAlertTokens = []; // 개발자 · 학생회장: 버그 제보는 알림 설정과 무관하게 항상 받음
  const councilAlertTokens = []; // 학생회(국장 이상): 새 건의사항은 알림 설정과 무관하게 항상 받음
  const nightOkTokens = new Set(); // 야간(22시~7시) 알림에 동의한 토큰만
  const tokensByStudentId = new Map(); // 건의사항 답변처럼 "그 사람에게만" 보낼 때 씀
  const pollTokensByStudentId = new Map(); // 투표 알림(prefs.poll 켠 사람)을 학번별로 묶어둔 것 — 그 투표에 아직 투표 안 한 사람만 골라 보낼 때 씀
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
    if (u.studentId && prefs.poll) pollTokensByStudentId.set(u.studentId, tokens);
    tokensByUid.set(docSnap.id, tokens);
    if (prefs.chat) chatOkUids.add(docSnap.id);
    if (prefs.councilChat && u.role && u.role !== 'student') councilChatOkUids.add(docSnap.id);
    mealPrefsByUid.set(docSnap.id, {
      jinri: !!prefs.mealJinri,
      mirae: !!prefs.mealMirae,
      breakfast: !!prefs.mealBreakfast,
      lunch: !!prefs.mealLunch,
      dinner: !!prefs.mealDinner,
    });
    for (const t of tokens) {
      tokenToUid.set(t, docSnap.id);
      if (prefs.notice) tokensBy.notice.push(t);
      if (prefs.poll) tokensBy.poll.push(t);
      if (prefs.recruit) tokensBy.recruit.push(t);
      if (prefs.night) nightOkTokens.add(t);
      if (u.role === 'developer' || u.role === 'president') bugAlertTokens.push(t);
      if (u.role && u.role !== 'student') councilAlertTokens.push(t);
    }
  });
  // 학식 알림 수신 대상: 지점(진리관/미래관)과 끼니(조식/중식/석식)를 둘 다 켠 사람만.
  function mealTokensFor(cafeteriaKey, slotKey) {
    const out = [];
    for (const [uid, tokens] of tokensByUid) {
      const p = mealPrefsByUid.get(uid);
      if (p && p[cafeteriaKey] && p[slotKey]) out.push(...tokens);
    }
    return out;
  }

  const invalidTokens = new Set();
  let sentCount = 0;

  // 투표 하나를 두고 아직 투표하지 않은 사람(그중에서도 투표 알림을 켜둔 사람)의 토큰만 골라낸다.
  // p.votes는 { 학번: 선택값 } 형태라 Object.keys가 곧 "이미 투표한 학번" 목록이다.
  function nonVoterPollTokens(p) {
    const voted = new Set(Object.keys(p.votes || {}));
    const tokens = [];
    for (const [sid, toks] of pollTokensByStudentId) {
      if (!voted.has(sid)) tokens.push(...toks);
    }
    return tokens;
  }

  async function sendToTokens(tokens, title, body, quietLabel) {
    if (isQuietHour()) {
      tokens = tokens.filter((t) => nightOkTokens.has(t));
      if (!tokens.length) {
        console.log(`(야간 시간대 — ${quietLabel || title} 알림에 동의한 사람이 없어 발송 생략)`);
        return;
      }
    }
    if (!tokens.length) return;
    // quietLabel은 대부분 카테고리 이름과 같아서(poll/meal/notice/recruit) 그대로 재사용한다 —
    // 앱이 이 값을 보고 알림을 눌렀을 때 어느 화면으로 바로 이동할지 정한다.
    const data = { url: './index.html' };
    if (quietLabel) data.category = quietLabel;
    for (let i = 0; i < tokens.length; i += CHUNK) {
      const batch = tokens.slice(i, i + CHUNK);
      const res = await messaging.sendEachForMulticast({
        tokens: batch,
        notification: { title, body },
        data,
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

  async function send(category, title, body) {
    return sendToTokens(tokensBy[category], title, body, category);
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

  // 2.5) 새 구인글 — 학생 누구나 쓸 수 있는 글이라 공지·투표처럼 작성자가 켜는 스위치는 없다.
  //      대신 받는 쪽 알림 설정(prefs.recruit)이 기본 꺼짐이라 원하는 사람만 받는다.
  const newRecruitments = recruitments.filter((r) => !notifiedRecruitment.has(r.id));
  for (const r of newRecruitments) {
    console.log('새 구인글 알림:', r.title);
    await send('recruit', '새 구인글이 올라왔어요', `제목: ${r.title}`);
  }

  // 2.7) 구인글 참여자 공지 — 구인자가 poll.orgMessages에 새 공지를 남기면 "참여" 누른
  //      사람에게만 보낸다. 개인 일정 안내라 알림 설정(prefs.recruit)과 무관하게 항상 보낸다.
  const lastOrgMsgCheck = st.lastOrgMsgCheck || Date.now() - 24 * 60 * 60 * 1000;
  const orgMsgRunStartedAt = Date.now();
  for (const r of recruitments) {
    if (!r.poll || !Array.isArray(r.poll.orgMessages)) continue;
    const newOrgMsgs = r.poll.orgMessages.filter((m) => (m.time || 0) > lastOrgMsgCheck);
    if (!newOrgMsgs.length) continue;
    const votes = r.poll.votes || {};
    const yesStudentIds = Object.keys(votes).filter((sid) => votes[sid].choice === 'yes' && sid !== r.authorId);
    if (!yesStudentIds.length) continue;
    const title = `${r.title} 참여자 공지`;
    const body = newOrgMsgs.length === 1 ? String(newOrgMsgs[0].text || '').slice(0, 80) : `새 공지 ${newOrgMsgs.length}개가 있어요`;
    for (const sid of yesStudentIds) {
      const allTokens = tokensByStudentId.get(sid) || [];
      const tokens = isQuietHour() ? allTokens.filter((t) => nightOkTokens.has(t)) : allTokens;
      if (!tokens.length) continue;
      const res = await messaging.sendEachForMulticast({
        tokens,
        notification: { title, body },
        data: { url: './index.html', category: 'recruit' },
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
    console.log(`[recruitOrgNotify] "${r.title}" 새 공지 ${newOrgMsgs.length}건, 참여자 ${yesStudentIds.length}명에게 발송 시도`);
  }
  nextState.lastOrgMsgCheck = orgMsgRunStartedAt;

  // 3) 진행 중인 투표 — 매일 20:00 KST 한 번만, 그 투표에 아직 참여 안 한 사람에게만 보낸다.
  //    투표마다 안 한 사람이 다를 수 있어서 한 번에 묶어 보내지 않고 투표별로 따로 보낸다.
  //    알림 발송을 끈 투표는 리마인더 대상에서도 빠진다.
  const today = kstDateStr();
  const activePolls = polls.filter((p) => isPollActive(p) && p.notifyPush);
  if (activePolls.length && lastPollReminderDate !== today && isDue(20, 0)) {
    for (const p of activePolls) {
      const tokens = nonVoterPollTokens(p);
      if (!tokens.length) {
        console.log('진행 중 투표 리마인더(이미 전원 참여, 건너뜀):', p.question);
        continue;
      }
      console.log(`진행 중 투표 리마인더 (미참여자 ${tokens.length}명):`, p.question);
      await sendToTokens(tokens, '아직 참여하지 않은 투표가 있어요', `제목: ${p.question}`, 'poll');
    }
    nextState.lastPollReminderDate = today;
  }

  // 4) 투표 마감 30분 전 (투표당 한 번) — 이미 참여한 사람은 종료 임박 알림을 받을 필요가 없다.
  const endingSoon = activePolls.filter((p) => {
    if (warnedPollEnd.has(p.id)) return false;
    const end = pollEndsAt(p);
    if (!end) return false;
    const minutesLeft = (end.getTime() - Date.now()) / 60000;
    return minutesLeft > 0 && minutesLeft <= 30;
  });
  for (const p of endingSoon) {
    const tokens = nonVoterPollTokens(p);
    if (!tokens.length) {
      console.log('투표 마감 임박(이미 전원 참여, 알림 생략):', p.question);
      continue;
    }
    console.log(`투표 마감 임박 알림 (미참여자 ${tokens.length}명):`, p.question);
    await sendToTokens(tokens, '곧 마감되는 투표가 있어요', `제목: ${p.question} (30분 후 마감)`, 'poll');
  }

  // 5) 식단 — 조식 07:00 / 중식 10:30 / 석식 16:30 KST
  // 진리관(학생식당)은 세 끼 다, 미래관(교직원식당)은 중식만 운영한다. 지점·끼니를 각각
  // 따로 켤 수 있으니, 지점별로 그 지점 메뉴가 있고 대상자가 있을 때만 따로 보낸다.
  const MEAL_SLOTS = [
    { key: 'breakfast', label: '조식', h: 7, m: 0 },
    { key: 'lunch', label: '중식', h: 10, m: 30 },
    { key: 'dinner', label: '석식', h: 16, m: 30 },
  ];
  const MEAL_CAFETERIAS = [
    { key: 'jinri', label: '진리관 학생식당', slots: ['breakfast', 'lunch', 'dinner'] },
    { key: 'mirae', label: '미래관 교직원식당', slots: ['lunch'] },
  ];
  const todayMealsByCafeteria = {
    jinri: (mealsByDate[today] && mealsByDate[today].student) || null,
    mirae: (mealsByDate[today] && mealsByDate[today].staff) || null,
  };
  const newMealKeys = [];
  for (const cafe of MEAL_CAFETERIAS) {
    const todayMeal = todayMealsByCafeteria[cafe.key];
    if (!todayMeal) continue;
    for (const slot of MEAL_SLOTS) {
      if (!cafe.slots.includes(slot.key)) continue;
      const dedupKey = `${today}_${cafe.key}_${slot.key}`;
      if (sentMealKeys.has(dedupKey)) continue;
      if (!isDue(slot.h, slot.m)) continue;
      const menu = (todayMeal[slot.key] || '').trim();
      if (!menu) continue;
      const tokens = mealTokensFor(cafe.key, slot.key);
      if (!tokens.length) { newMealKeys.push(dedupKey); continue; }
      // 저장된 메뉴는 "[한식] 밥, 국..." 처럼 줄바꿈으로 구분되어 있어 한 줄로 합쳐 보낸다.
      const body = menu.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).join(' / ').slice(0, 200);
      console.log(`식단 알림(${cafe.label} ${slot.label}):`, body.slice(0, 40));
      await sendToTokens(tokens, `오늘의 ${slot.label} (${cafe.label})`, body, 'meal');
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
  //    크론이 5분에 한 번만 도니 그사이 한 사람에게 여러 건이 쌓일 수 있다 — 메시지마다 따로
  //    보내면 알림이 줄줄이 뜨므로, 받는 사람별로 모아서 딱 1건이면 그 내용을, 여러 건이면
  //    "새 메시지 N개" 식으로 뭉쳐서 한 번만 보낸다.
  const lastChatCheck = st.lastChatCheck || Date.now() - 15 * 60 * 1000; // 처음 실행이면 최근 15분만
  const chatRunStartedAt = Date.now();
  const newMsgsSnap = await db.collectionGroup('messages').where('createdAt', '>', lastChatCheck).get();
  if (!newMsgsSnap.empty) {
    const byRecipient = new Map(); // recipientUid -> [{ senderUid, text, pairId }]
    for (const d of newMsgsSnap.docs) {
      const m = d.data();
      const pairId = d.ref.parent.parent.id; // chats/{pairId}/messages/{msgId}
      const uids = pairId.split('_');
      const recipientUid = uids.find((u) => u !== m.senderUid);
      if (!recipientUid || !chatOkUids.has(recipientUid)) continue;
      const muted = mutedByPair.get(pairId);
      if (muted && muted[recipientUid]) continue; // 이 친구 채팅만 콕 집어 꺼둔 경우
      const seenAt = lastSeenByPair.get(pairId);
      if (seenAt && seenAt[recipientUid] && seenAt[recipientUid] >= (m.createdAt || 0)) continue; // 크론 돌기 전에 이미 앱에서 읽음
      if (!byRecipient.has(recipientUid)) byRecipient.set(recipientUid, []);
      byRecipient.get(recipientUid).push({ senderUid: m.senderUid, text: m.text, pairId });
    }
    for (const [recipientUid, msgs] of byRecipient) {
      const allTokens = tokensByUid.get(recipientUid) || [];
      const tokens = isQuietHour() ? allTokens.filter((t) => nightOkTokens.has(t)) : allTokens;
      if (!tokens.length) continue;
      let notification, data;
      if (msgs.length === 1) {
        const only = msgs[0];
        const senderName = nameByUid.get(only.senderUid) || '친구';
        notification = { title: `${senderName}님의 메시지`, body: String(only.text || '').slice(0, 80) };
        data = { url: './index.html', category: 'chat', pairId: only.pairId };
      } else {
        notification = { title: '새로운 채팅이 있어요', body: `새 메시지 ${msgs.length}개가 도착했어요` };
        data = { url: './index.html', category: 'friend' }; // 여러 대화가 섞여 있어 특정 채팅방으로는 못 보내고 친구 목록으로
      }
      const res = await messaging.sendEachForMulticast({ tokens, notification, data });
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
    console.log(`[chatNotify] 새 메시지 ${newMsgsSnap.size}건 확인, 대상자 ${byRecipient.size}명에게 발송 시도`);
  }
  nextState.lastChatCheck = chatRunStartedAt;

  // 8.7) 친구 요청 도착 / 친구가 됨 — 개인적인 일회성 알림이라 알림 설정(chat 등)과
  //      무관하게 항상 보낸다(건의사항 답변 알림과 같은 취급).
  const lastFriendLinkCheck = st.lastFriendLinkCheck || Date.now() - 15 * 60 * 1000;
  const friendLinkRunStartedAt = Date.now();
  const newRequestsSnap = await db
    .collection('friendLinks')
    .where('createdAt', '>', lastFriendLinkCheck)
    .get();
  for (const d of newRequestsSnap.docs) {
    const f = d.data();
    if (f.status !== 'pending' || !f.requestedBy) continue;
    const recipientUid = (f.uids || []).find((u) => u !== f.requestedBy);
    if (!recipientUid) continue;
    const allTokens = tokensByUid.get(recipientUid) || [];
    const tokens = isQuietHour() ? allTokens.filter((t) => nightOkTokens.has(t)) : allTokens;
    if (!tokens.length) continue;
    const senderName = nameByUid.get(f.requestedBy) || '누군가';
    const res = await messaging.sendEachForMulticast({
      tokens,
      notification: { title: '새 친구 요청이 왔어요', body: `${senderName}님이 친구 요청을 보냈어요` },
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
  const acceptedSnap = await db
    .collection('friendLinks')
    .where('acceptedAt', '>', lastFriendLinkCheck)
    .get();
  for (const d of acceptedSnap.docs) {
    const f = d.data();
    if (f.status !== 'accepted' || !f.requestedBy) continue;
    const allTokens = tokensByUid.get(f.requestedBy) || [];
    const tokens = isQuietHour() ? allTokens.filter((t) => nightOkTokens.has(t)) : allTokens;
    if (!tokens.length) continue;
    const otherUid = (f.uids || []).find((u) => u !== f.requestedBy);
    const otherName = nameByUid.get(otherUid) || '상대방';
    const res = await messaging.sendEachForMulticast({
      tokens,
      notification: { title: '친구가 됐어요', body: `${otherName}님과 친구가 됐어요` },
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
  nextState.lastFriendLinkCheck = friendLinkRunStartedAt;

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
      notifiedRecruitmentIds: [...notifiedRecruitment, ...newRecruitments.map((r) => r.id)].slice(-KEEP_IDS),
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
  const authUsers = await listAllAuthUsers();
  await purgeGhostAuthAccounts(authUsers);
  await purgeOrphanedDirectoryAndFriendLinks(authUsers);
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
