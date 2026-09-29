// GitHub Actions 크론(1시간 간격)으로 실행되는 무료 알림 발송 스크립트.
// Firebase Cloud Functions(=Blaze 요금제 필요) 없이도 푸시 알림을 보내기 위한 대안 —
// 신뢰할 수 있는 실행 환경에서 서비스 계정 키로 Firestore를 읽고 firebase-admin으로 직접 발송한다.
//
// 새 공지·투표·구인글·버그제보·건의사항(+답변)·친구채팅·학생회채팅·학번별채팅처럼 "감지 즉시"
// 필요한 알림은 전부 Cloudflare Worker(worker-notify, notifyQueue를 1분마다 확인)로 옮겨졌다
// (2026-09-28, 커밋 e7bdcca). 이 스크립트는 시각이 고정됐거나(식단·투표 리마인더) 어차피
// 1시간 정도 지연돼도 괜찮은 것만 남아서, 예전엔 5분마다 users 컬렉션 전체를 읽어야 해서
// Firestore 무료 할당량(하루 5만 읽기)을 다 썼는데 이제 1시간마다로 늘려 읽기량을 12분의 1로
// 줄였다. pushAudience(Worker가 수신자 판단에 쓰는 캐시)도 이제 1시간에 한 번만 갱신된다 —
// 채팅 알림 설정을 막 바꾸거나 새 기기 토큰이 생긴 경우 최대 1시간 지연될 수 있지만, 채팅
// 메시지 자체가 오는 속도(Worker 몫)는 영향 없다.
//
// 보내는 알림 종류
//   3) 진행 중인 투표    → 매일 20:00 KST 한 번
//   3.5) 새 버전 안내    → 매일 12:00 KST, 구버전 쓰는 사람에게 그 버전 기준 딱 한 번만
//   4) 투표 마감 임박    → 투표당 한 번 (1시간 주기라 사각지대 없이 잡히도록 넉넉한 창을 둠)
//   5) 식단             → 조식 07:00 / 중식 10:30 / 석식 16:30 KST
//   8.6) 학생회 채팅 상단 고정 공지 갱신 → 감지 즉시(최대 1시간 지연)
//   8.7) 친구 요청 도착 / 친구 수락 → 감지 즉시(최대 1시간 지연), 알림 설정과 무관하게 항상
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

// 1년 이상 미접속으로 자동 잠금(disabled)된 계정을 학생회장이 다시 풀어주는 큐.
// 클라이언트는 Admin SDK 권한이 없어 계정 잠금을 직접 못 풀어서, pendingAuthDeletes와
// 같은 방식으로 여기 쌓아두면 이 크론이 대신 처리한다. 정보(프로필·시간표 등)는
// 애초에 지운 적이 없으니 그대로 두고 잠금 상태와 withdrawn 표시만 되돌린다.
async function processPendingAuthReactivations() {
  const ref = db.collection('shared').doc('pendingAuthReactivations');
  const snap = await ref.get();
  if (!snap.exists) return;
  const list = Array.isArray(snap.data().list) ? snap.data().list : [];
  if (!list.length) return;

  const remaining = [];
  let done = 0;
  for (const entry of list) {
    const uid = typeof entry === 'string' ? entry : entry && entry.uid;
    if (!uid) continue;
    try {
      await getAuth().updateUser(uid, { disabled: false });
      await db.collection('users').doc(uid).set(
        { withdrawn: false, dormant: false, reactivatedAt: Date.now() },
        { merge: true }
      );
      done++;
      console.log('[authReactivate] 잠금 해제', uid, (entry && entry.studentId) || '');
    } catch (e) {
      remaining.push(entry);
      console.error('[authReactivate] 실패', uid, (e && e.code) || e);
    }
  }
  await ref.set({ list: remaining }, { merge: true });
  console.log(`[authReactivate] ${done}건 해제, ${remaining.length}건 남음`);
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

// 6개월 이상 미접속 → 휴면 표시만(dormant). 1년 이상 미접속 → 로그인 계정을 잠그되(disabled),
// "탈퇴"(kick-member)와 달리 users 문서·시간표·게시물 등 정보는 전혀 지우지 않고 그대로 둔다.
// lastSeen이 아예 없는(한 번도 안 남은) 계정은 판단 기준이 없어 건드리지 않는다.
const DORMANT_MS = 180 * 24 * 60 * 60 * 1000;
const AUTO_WITHDRAW_MS = 365 * 24 * 60 * 60 * 1000;
async function processInactiveAccounts(usersSnap) {
  const nowTs = Date.now();
  let dormantCount = 0;
  let withdrawnCount = 0;
  for (const docSnap of usersSnap.docs) {
    const u = docSnap.data();
    const uid = docSnap.id;
    if (!u.lastSeen || u.withdrawn) continue;
    const inactiveMs = nowTs - u.lastSeen;
    if (inactiveMs >= AUTO_WITHDRAW_MS) {
      try {
        await getAuth().updateUser(uid, { disabled: true });
        await db.collection('users').doc(uid).set(
          { withdrawn: true, withdrawnAt: nowTs, withdrawnReason: 'inactive_1y' },
          { merge: true }
        );
        withdrawnCount++;
        console.log('[autoWithdraw] 1년 이상 미접속, 계정 잠금(정보 유지):', uid);
      } catch (e) {
        console.warn('[autoWithdraw] 실패', uid, (e && e.code) || e);
      }
    } else if (inactiveMs >= DORMANT_MS && !u.dormant) {
      try {
        await db.collection('users').doc(uid).set({ dormant: true, dormantAt: nowTs }, { merge: true });
        dormantCount++;
      } catch (e) {
        console.warn('[dormant] 실패', uid, (e && e.code) || e);
      }
    }
  }
  if (dormantCount) console.log(`[dormant] 6개월 이상 미접속 ${dormantCount}건 휴면 표시`);
  if (withdrawnCount) console.log(`[autoWithdraw] 1년 이상 미접속 ${withdrawnCount}건 계정 잠금`);
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

// 친구 채팅은 게시물과 달리 "삭제 표시(tombstone)" 없이, 메시지가 생긴 지 일정 기간이
// 지나면 그냥 완전히 지운다. 대화 내용을 보관할 이유가 없고(신고 시에는 이미 신고
// 접수 시점에 최근 대화를 별도로 복사해 남겨둔다), 계속 쌓아두면 문서 수만 늘어난다.
// chats/{pairId}/messages 서브컬렉션이 계정 쌍마다 따로 있어서, 하나씩 돌지 않고
// collectionGroup으로 전체 메시지 컬렉션을 한 번에 훑는다.
// 학생회·학번별 채팅과 같은 7일로 통일한다(예전엔 24시간이었다).
const FRIEND_CHAT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
async function purgeOldChatMessages() {
  const cutoff = Date.now() - FRIEND_CHAT_TTL_MS;
  const snap = await db.collectionGroup('messages').where('createdAt', '<', cutoff).get();
  if (snap.empty) return;
  const batchSize = 400; // Firestore 배치 쓰기 한도(500)보다 여유 있게
  const docs = snap.docs;
  for (let i = 0; i < docs.length; i += batchSize) {
    const batch = db.batch();
    docs.slice(i, i + batchSize).forEach((d) => batch.delete(d.ref));
    await batch.commit();
  }
  console.log(`[chatPurge] 7일 지난 메시지 ${docs.length}건 삭제`);
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

// cohortChats/{yy} 부모 문서는 실제로 만든 적이 없어(메시지만 서브컬렉션에 addDoc으로 쌓임)
// db.collection('cohortChats').get()으로는 하나도 안 잡힌다("유령 부모" — 필드값 없는 문서 경로는
// 컬렉션 목록에 안 뜬다). 그래서 있을 법한 학번 범위를 직접 돌면서 확인한다.
async function purgeOldCohortChatMessages() {
  const cutoff = Date.now() - COUNCIL_CHAT_TTL_MS;
  const d = kstNow();
  const ay = d.getUTCMonth() >= 1 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
  const latestY2 = ay % 100;
  for (let y = 21; y <= latestY2; y++) {
    const yy = String(y).padStart(2, '0');
    const snap = await db.collection('cohortChats').doc(yy).collection('messages').where('createdAt', '<', cutoff).get();
    if (snap.empty) continue;
    const batchSize = 400;
    const docs = snap.docs;
    for (let i = 0; i < docs.length; i += batchSize) {
      const batch = db.batch();
      docs.slice(i, i + batchSize).forEach((dd) => batch.delete(dd.ref));
      await batch.commit();
    }
    console.log(`[cohortChatPurge] ${yy}학번 7일 지난 메시지 ${docs.length}건 삭제`);
  }
}

async function main() {
  // friendLinks·councilChatNotice는 예전엔 여기서 매번 통째로 읽었는데(친구요청/학생회 공지
  // 감지용), 그 감지 로직 자체가 Worker로 옮겨가면서 더 이상 안 쓰여서 읽기를 아예 없앴다.
  const [noticesSnap, pollsSnap, mealsSnap, bugReportsSnap, suggestionsSnap, recruitmentsSnap, stateSnap, usersSnap] = await Promise.all([
    db.collection('shared').doc('notices').get(),
    db.collection('shared').doc('polls').get(),
    db.collection('shared').doc('meals').get(),
    db.collection('shared').doc('bugReports').get(),
    db.collection('shared').doc('suggestions').get(),
    db.collection('shared').doc('recruitments').get(),
    db.collection('shared').doc('notifyState').get(),
    db.collection('users').get(),
  ]);

  // 앱은 삭제를 tombstone(deleted:true)으로 처리하므로 반드시 걸러내야 한다.
  const notices = live(noticesSnap.exists ? noticesSnap.data().list : []);
  const polls = live(pollsSnap.exists ? pollsSnap.data().list : []);
  const mealsByDate = (mealsSnap.exists ? mealsSnap.data().byDate : {}) || {};
  const bugReports = live(bugReportsSnap.exists ? bugReportsSnap.data().list : []);
  const suggestions = live(suggestionsSnap.exists ? suggestionsSnap.data().list : []);
  const recruitments = live(recruitmentsSnap.exists ? recruitmentsSnap.data().list : []);
  const st = stateSnap.exists ? stateSnap.data() : {};

  const warnedPollEnd = new Set(st.warnedPollEndIds || []);
  const sentMealKeys = new Set(st.sentMealKeys || []);
  const notifiedOrgMsg = new Set(st.notifiedOrgMsgIds || []);
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
  const cohortChatOkUids = new Set(); // 학번별 채팅 알림을 켜둔 사람만 (학번 구분 없이 하나로)
  const councilChatTokens = []; // 학생회 채팅 알림을 켠 학생회 구성원 토큰 (즉시 발송용)
  const cohortChatByYear = {}; // { '24': [tokens...] } — 학번별 채팅 알림을 켠 그 학번 사람들
  const tokenToUid = new Map();
  // 같은 기기에서 계정을 바꿔 로그인하면 그 기기 토큰이 여러 계정 문서에 남는다. 그대로 두면
  // 예전 계정이 켜둔 알림(예: 조식)이 지금 로그인한 계정 설정과 무관하게 그 폰으로 온다.
  // 토큰마다 "주인"을 한 계정으로 정한다: 그 계정의 현재 토큰(fcmToken)인 쪽이 우선이고,
  // 그래도 같으면 가장 최근에 등록한(fcmTokenUpdatedAt) 계정.
  const tokensOf = (u) => [...new Set([...(u.fcmTokens || []), ...(u.fcmToken ? [u.fcmToken] : [])])];
  const tokenOwner = new Map(); // token -> { uid, current, at }
  usersSnap.forEach((docSnap) => {
    const u = docSnap.data();
    const at = Number(u.fcmTokenUpdatedAt) || 0;
    for (const t of tokensOf(u)) {
      const cand = { uid: docSnap.id, current: u.fcmToken === t ? 1 : 0, at };
      const prev = tokenOwner.get(t);
      if (!prev || cand.current > prev.current || (cand.current === prev.current && cand.at > prev.at)) {
        tokenOwner.set(t, cand);
      }
    }
  });
  usersSnap.forEach((docSnap) => {
    const u = docSnap.data();
    let tokens = tokensOf(u).filter((t) => tokenOwner.get(t).uid === docSnap.id);
    if (!tokens.length) return;
    // 계정당 폰 하나 + PC 브라우저 하나까지만 보낸다. 폰 브라우저·PWA(아이폰)·앱(안드로이드)이
    // 같이 울리면 안 되므로 폰 쪽은 앱 > PWA > 폰 브라우저 순으로 하나만 고른다(폰 브라우저는
    // 앱·PWA가 없을 때의 대체 창구). PC 브라우저는 폰과 별개로 따로 울린다.
    // 종류 기록이 없는 옛 토큰은 PWA로 본다. 같은 순위끼리는 마지막으로 등록한 것
    // (fcmToken, 없으면 배열의 마지막).
    // Worker는 FCM v1에 멀티캐스트가 없어 토큰 하나당 외부 요청 1개(실행당 한도 50개)를
    // 쓰기 때문에, 토큰 수를 줄이는 것이 한도 관리에도 필요하다.
    const PHONE_RANK = { apk: 0, pwa: 1, mobileWeb: 2 };
    const kinds = u.fcmTokenKinds || {};
    const kindOf = (t) => kinds[t] || 'pwa';
    const pickBest = (list, rankOf) => {
      if (!list.length) return null;
      const best = Math.min(...list.map(rankOf));
      const top = list.filter((t) => rankOf(t) === best);
      return top.includes(u.fcmToken) ? u.fcmToken : top[top.length - 1];
    };
    const phonePick = pickBest(tokens.filter((t) => kindOf(t) !== 'desktop'), (t) => PHONE_RANK[kindOf(t)] ?? 1);
    const desktopPick = pickBest(tokens.filter((t) => kindOf(t) === 'desktop'), () => 0);
    tokens = [phonePick, desktopPick].filter(Boolean);
    const prefs = u.notifyPrefs || {};
    if (u.studentId) tokensByStudentId.set(u.studentId, tokens);
    if (u.studentId && prefs.poll) pollTokensByStudentId.set(u.studentId, tokens);
    tokensByUid.set(docSnap.id, tokens);
    if (prefs.chat) chatOkUids.add(docSnap.id);
    if (prefs.cohortChat) cohortChatOkUids.add(docSnap.id);
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
      if (prefs.councilChat && u.role && u.role !== 'student') councilChatTokens.push(t);
      // 학번별 채팅은 방이 학번마다 따로 있어서, 토큰도 그 학번 배열에만 넣는다.
      if (prefs.cohortChat && u.cohortYear) {
        if (!cohortChatByYear[u.cohortYear]) cohortChatByYear[u.cohortYear] = [];
        cohortChatByYear[u.cohortYear].push(t);
      }
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
  // 구인글 참여자 공지(2.7)는 클라이언트가 "공지하기"를 누르는 즉시 notifyQueue에 넣는
  // 방식으로 이전했다(public/index.html의 notifyRecruitmentOrgMessage). 예전엔 여기서
  // notify:true 표시를 5분마다 찾아 보냈는데, 그대로 두면 클라이언트가 이미 보낸 걸
  // 여기서 또 보내는 중복이 생긴다.
  const newOrgMsgSentIds = [];

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

  // 3.5) 새 버전 안내 — 매일 낮 12시에 한 번, GitHub 최신 릴리즈보다 낮은 버전을 쓰는 사람에게만
  //      "새 버전이 있어요"를 보낸다. 앱을 켤 때마다 서버에 물어보면 로딩이 느려져 보여서
  //      자동 확인 자체를 뺐었는데(그럼 업데이트가 나온 줄 아예 모르게 됨), 그 대신 이 크론이
  //      하루에 한 번만 물어보고 필요한 사람에게만 푸시로 알려준다. 같은 버전으로는 한 사람당
  //      딱 한 번만 보내고, 업데이트를 안 해도 다음날 또 조르지 않는다(다음 버전이 나와야 재발송).
  if (isDue(12, 0)) {
    try {
      const res = await fetch('https://api.github.com/repos/kuaisemi/ise-app/releases/latest', {
        headers: { Accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(8000),
      });
      if (res.ok) {
        const j = await res.json();
        const m = String(j.tag_name || '').match(/(\d+)/);
        const latestVersion = m ? parseInt(m[1], 10) : 0;
        if (latestVersion > 0) {
          const notifiedUids = new Set(
            st.notifiedUpdateVersion === latestVersion ? st.notifiedUpdateUids || [] : []
          );
          let sentThisRun = 0;
          for (const docSnap of usersSnap.docs) {
            const u = docSnap.data();
            const uid = docSnap.id;
            if (!u.androidVersionCode || u.androidVersionCode >= latestVersion) continue;
            if (notifiedUids.has(uid)) continue;
            const tokens = tokensByUid.get(uid) || [];
            if (!tokens.length) continue;
            await sendToTokens(tokens, '새로운 버전이 있어요', '업데이트하면 최신 기능과 버그 수정을 받을 수 있어요', 'update');
            notifiedUids.add(uid);
            sentThisRun++;
          }
          if (sentThisRun) console.log(`[updateNotify] v${latestVersion} 안내 ${sentThisRun}명에게 발송`);
          nextState.notifiedUpdateVersion = latestVersion;
          nextState.notifiedUpdateUids = [...notifiedUids];
        }
      }
    } catch (e) {
      console.warn('[updateNotify] 실패', e && e.message);
    }
  }

  // 4) 투표 마감 임박 (투표당 한 번) — 이미 참여한 사람은 종료 임박 알림을 받을 필요가 없다.
  // 예전엔 30분 전이었는데, 이 크론이 5분이 아니라 1시간마다 돌게 되면서 창을 30분으로 두면
  // 두 번의 실행 사이(최대 60분) 그 창을 완전히 비껴가는 투표가 생길 수 있었다(사각지대).
  // 그래서 창을 크론 주기(60분)보다 넉넉하게 90분으로 넓혀서, 어떤 실행이든 마감 전에 최소
  // 한 번은 반드시 걸리도록 한다.
  const endingSoon = activePolls.filter((p) => {
    if (warnedPollEnd.has(p.id)) return false;
    const end = pollEndsAt(p);
    if (!end) return false;
    const minutesLeft = (end.getTime() - Date.now()) / 60000;
    return minutesLeft > 0 && minutesLeft <= 90;
  });
  for (const p of endingSoon) {
    const tokens = nonVoterPollTokens(p);
    if (!tokens.length) {
      console.log('투표 마감 임박(이미 전원 참여, 알림 생략):', p.question);
      continue;
    }
    console.log(`투표 마감 임박 알림 (미참여자 ${tokens.length}명):`, p.question);
    await sendToTokens(tokens, '곧 마감되는 투표가 있어요', `제목: ${p.question} (곧 마감돼요)`, 'poll');
  }

  // 5) 식단 — 조식 07:00 / 중식 10:30 / 석식 16:30 KST
  // 진리관(학생식당)은 세 끼 다, 미래관(교직원식당)은 중식만 운영한다. 지점·끼니를 각각
  // 따로 켤 수 있으니, 지점별로 그 지점 메뉴가 있고 대상자가 있을 때만 따로 보낸다.
  const MEAL_SLOTS = [
    // 조식만 유예 시간을 길게 준다. 그 주 식단 정보는 월요일 오전 10시부터 가져오기
    // 시작하는데(runMeals, 화~금은 월요일에 이미 받아둔 데이터로 문제없음), 월요일
    // 아침 07~08시는 그보다 이른 시각이라 항상 데이터가 없어서 조식 알림이 통째로
    // 빠지고 있었다. 데이터가 늦게 들어와도(예: 10시 13분) 오전 중에는 따라잡아
    // 보내도록 유예를 4시간(240분)으로 늘렸다 — 늦게라도 오는 게 영영 안 오는 것보다 낫다.
    { key: 'breakfast', label: '조식', h: 7, m: 0, grace: 240 },
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
      if (!isDue(slot.h, slot.m, slot.grace)) continue;
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

  // 친구 요청/수락, 학생회 채팅 공지 갱신 알림은 클라이언트가 enqueuePush()로 notifyQueue에
  // 바로 넣고 Cloudflare Worker(1분 주기)가 보내는 방식으로 옮겨졌다(2026-09-28) — 이 크론이
  // 감지할 필요가 없어졌다. friendLinks·councilChatNotice를 여기서 더 이상 안 읽는다.

  if (!sentCount) {
    console.log('보낼 알림 없음 — 종료');
  }

  // 상태 저장 (중복 발송 방지용 커서)
  await db.collection('shared').doc('notifyState').set(
    {
      notifiedOrgMsgIds: [...notifiedOrgMsg, ...newOrgMsgSentIds].slice(-KEEP_IDS),
      warnedPollEndIds: [...warnedPollEnd, ...endingSoon.map((p) => p.id)].slice(-KEEP_IDS),
      sentMealKeys: [...sentMealKeys, ...newMealKeys].slice(-30),
      updatedAt: Date.now(),
      ...nextState,
    },
    { merge: true }
  );

  await purgeOldTombstones();
  await purgePendingAuthDeletes();
  await processPendingAuthReactivations();
  const authUsers = await listAllAuthUsers();
  await purgeGhostAuthAccounts(authUsers);
  await purgeOrphanedDirectoryAndFriendLinks(authUsers);
  await purgeOldChatMessages();
  await purgeOldCouncilChatMessages();
  await purgeOldCohortChatMessages();
  await processInactiveAccounts(usersSnap);

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

  // 다른 계정이 주인이 된 토큰은 예전 계정 문서에서 지운다. 주인이 그 토큰을 "현재 토큰"으로
  // 확실히 갖고 있을 때만 지운다(등록 시각 기록이 없는 옛 데이터끼리의 다툼은 건드리지 않는다).
  {
    const stale = new Map(); // uid -> [tokens]
    usersSnap.forEach((docSnap) => {
      const u = docSnap.data();
      for (const t of tokensOf(u)) {
        const owner = tokenOwner.get(t);
        if (owner.uid === docSnap.id || !owner.current || !owner.at) continue;
        if (!stale.has(docSnap.id)) stale.set(docSnap.id, []);
        stale.get(docSnap.id).push(t);
      }
    });
    if (stale.size) {
      const batch = db.batch();
      for (const [uid, tokens] of stale) {
        const cur = usersSnap.docs.find((d) => d.id === uid).data();
        const update = { fcmTokens: FieldValue.arrayRemove(...tokens) };
        if (tokens.includes(cur.fcmToken)) update.fcmToken = FieldValue.delete();
        batch.update(db.collection('users').doc(uid), update);
      }
      await batch.commit();
      console.log(`다른 계정으로 넘어간 토큰 정리: ${stale.size}개 계정`);
    }
  }

  // Cloudflare Worker가 쓸 수신 대상 캐시를 남긴다.
  //
  // Worker는 매분 도는데, 거기서 users 컬렉션을 통째로 읽으면 무료 플랜의 CPU 10ms 예산을
  // 넘기기 쉽다(사람 수만큼 JSON 파싱). 어차피 이 스크립트가 5분마다 users를 다 읽고 있으니,
  // "누구에게 어떤 토큰으로 보내면 되는지"만 추려 작은 문서 하나로 남겨두고 Worker는 그것만
  // 읽게 한다. 무효 토큰 정리가 끝난 뒤에 만들어야 방금 지운 토큰이 안 들어간다.
  {
    const byUid = {};
    for (const [uid, tokens] of tokensByUid) {
      const alive = tokens.filter((t) => !invalidTokens.has(t));
      if (alive.length) byUid[uid] = alive;
    }
    const night = [...nightOkTokens].filter((t) => !invalidTokens.has(t));
    const alive = (arr) => arr.filter((t) => !invalidTokens.has(t));
    await db.collection('shared').doc('pushAudience').set({
      byUid,
      night,
      // 카테고리 전체 구독자 토큰 목록 — Worker가 새 공지·투표·구인글·버그제보·건의사항을
      // 즉시(1분 안에) 보낼 때 "누구에게 보낼지"를 여기서 그대로 가져다 쓴다. 이 스크립트가
      // 어차피 5분마다 users 전체를 읽어 계산해두는 값이라 추가 비용이 없다.
      notice: alive(tokensBy.notice),
      poll: alive(tokensBy.poll),
      recruit: alive(tokensBy.recruit),
      bugAlert: alive(bugAlertTokens),
      councilAlert: alive(councilAlertTokens),
      // 학생회 채팅 — 방이 하나뿐이라 배열 하나로 충분하다.
      councilChat: alive(councilChatTokens),
      // 학번별 채팅 — 방이 학번마다 따로 있어서 학번별 배열로 쪼갠다.
      cohortChat: Object.fromEntries(Object.entries(cohortChatByYear).map(([y, t]) => [y, alive(t)])),
      // 채팅처럼 "특정 한 사람"에게 보내는 알림(audience:'user')은 그 사람이 해당 알림
      // 종류를 켰는지를 uid 목록으로 따로 남겨서 Worker가 확인한다(친구 채팅용).
      chatOkUids: [...chatOkUids],
      updatedAt: Date.now(),
    });
  }

  // 전교생 발송용 FCM 토픽 구독.
  //
  // FCM HTTP v1에는 멀티캐스트가 없어서 토큰 하나당 요청 하나다. Worker의 무료 한도는
  // 실행당 외부 요청 50개라, 전교생에게 토큰으로 쏘면 한 번에 다 못 보낸다. 토픽으로 보내면
  // 받는 사람이 몇 명이든 요청 1회로 끝나므로, 구독만 여기서 미리 해둔다.
  //   ise_all   — 전체
  //   ise_night — 야간(22~07시) 알림에 동의한 사람만. 토픽은 "누구를 빼고 보내기"가 안 돼서,
  //               야간에 쓸 대상만 따로 모은 토픽이 필요하다.
  // 이미 구독한 토큰을 또 구독해도 무해하지만 호출이 아깝다 — 한 번 구독한 토큰은
  // notifyState에 적어두고 새 토큰만 처리한다.
  {
    const allTokens = [];
    for (const [, tokens] of tokensByUid) allTokens.push(...tokens);
    const liveTokens = [...new Set(allTokens)].filter((t) => !invalidTokens.has(t));
    const liveNight = [...nightOkTokens].filter((t) => !invalidTokens.has(t));
    const already = new Set(st.topicSubscribed || []);
    const alreadyNight = new Set(st.topicSubscribedNight || []);
    const newAll = liveTokens.filter((t) => !already.has(t));
    const newNight = liveNight.filter((t) => !alreadyNight.has(t));
    try {
      // subscribeToTopic은 한 번에 1000개까지 받는다.
      for (let i = 0; i < newAll.length; i += 1000) {
        await messaging.subscribeToTopic(newAll.slice(i, i + 1000), 'ise_all');
      }
      for (let i = 0; i < newNight.length; i += 1000) {
        await messaging.subscribeToTopic(newNight.slice(i, i + 1000), 'ise_night');
      }
      // 야간 동의를 끈 사람은 그 토픽에서 빼야 한다 — 안 그러면 껐는데도 야간에 계속 온다.
      const dropNight = [...alreadyNight].filter((t) => !liveNight.includes(t));
      for (let i = 0; i < dropNight.length; i += 1000) {
        await messaging.unsubscribeFromTopic(dropNight.slice(i, i + 1000), 'ise_night');
      }
      if (newAll.length || newNight.length || dropNight.length) {
        console.log(`토픽 구독 갱신 — 전체 +${newAll.length}, 야간 +${newNight.length}/-${dropNight.length}`);
      }
      // notifyState는 위(1067줄 근처)에서 이미 저장이 끝난 뒤라 nextState에 넣어봐야 반영되지
      // 않는다 — 여기서 따로 merge로 덧쓴다. 이걸 놓치면 매 실행마다 전원을 다시 구독시키고,
      // 야간 동의를 끈 사람을 토픽에서 빼지도 못한다(껐는데 계속 오는 버그).
      await db.collection('shared').doc('notifyState').set(
        {
          topicSubscribed: liveTokens.slice(-500),
          topicSubscribedNight: liveNight.slice(-500),
        },
        { merge: true }
      );
    } catch (e) {
      console.warn('[topic] 구독 실패(다음 실행에서 재시도):', e && e.message);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
