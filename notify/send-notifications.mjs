// GitHub Actions 크론으로 몇 분마다 실행되는 무료 알림 발송 스크립트.
// Firebase Cloud Functions(=Blaze 요금제 필요) 없이도 "새 공지/투표가 생기면 FCM 푸시를
// 보낸다"를 구현하기 위한 대안 — 신뢰할 수 있는 실행 환경(GitHub Actions)에서
// 서비스 계정 키로 Firestore를 읽고 firebase-admin으로 직접 발송한다.
//
// 필요한 비밀값: 저장소 Settings → Secrets and variables → Actions에
//   FIREBASE_SERVICE_ACCOUNT = Firebase 콘솔에서 발급한 서비스 계정 JSON 전체 내용
// 을 등록해야 함. (README 참고)

import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { getMessaging } from 'firebase-admin/messaging';

const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
if (!raw) {
  console.error('FIREBASE_SERVICE_ACCOUNT 환경변수가 없습니다. GitHub Secrets 설정을 확인하세요.');
  process.exit(1);
}

const serviceAccount = JSON.parse(raw);
initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();
const messaging = getMessaging();

// FCM sendEachForMulticast는 한 번에 최대 500개 토큰까지만 받는다.
const CHUNK = 500;
// notifyState에 쌓아두는 "이미 알림 보낸 id" 목록은 무한정 늘어나지 않도록 최근 N개만 유지.
const KEEP_IDS = 300;

async function sendTo(tokens, notification, data, invalidTokens) {
  if (!tokens.length) return;
  for (let i = 0; i < tokens.length; i += CHUNK) {
    const batch = tokens.slice(i, i + CHUNK);
    const res = await messaging.sendEachForMulticast({ tokens: batch, notification, data });
    res.responses.forEach((r, idx) => {
      if (!r.success) {
        const code = r.error && r.error.code;
        if (
          code === 'messaging/invalid-registration-token' ||
          code === 'messaging/registration-token-not-registered'
        ) {
          invalidTokens.add(batch[idx]);
        } else {
          console.warn('발송 실패:', code, r.error && r.error.message);
        }
      }
    });
  }
}

async function main() {
  const [noticesSnap, pollsSnap, stateSnap, usersSnap] = await Promise.all([
    db.collection('shared').doc('notices').get(),
    db.collection('shared').doc('polls').get(),
    db.collection('shared').doc('notifyState').get(),
    db.collection('users').get(),
  ]);

  const notices = (noticesSnap.exists ? noticesSnap.data().list : []) || [];
  const polls = (pollsSnap.exists ? pollsSnap.data().list : []) || [];
  const st = stateSnap.exists ? stateSnap.data() : {};
  const notifiedNotice = new Set(st.notifiedNoticeIds || []);
  const notifiedPoll = new Set(st.notifiedPollIds || []);

  const newNotices = notices.filter((n) => n && n.id && !notifiedNotice.has(n.id));
  const newPolls = polls.filter((p) => p && p.id && !notifiedPoll.has(p.id));

  if (!newNotices.length && !newPolls.length) {
    console.log('새 공지/투표 없음 — 종료');
    return;
  }

  const noticeTokens = [];
  const pollTokens = [];
  const tokenToUid = new Map();
  usersSnap.forEach((docSnap) => {
    const u = docSnap.data();
    if (!u.fcmToken) return;
    const prefs = u.notifyPrefs || {};
    tokenToUid.set(u.fcmToken, docSnap.id);
    if (prefs.notice) noticeTokens.push(u.fcmToken);
    if (prefs.poll) pollTokens.push(u.fcmToken);
  });

  const invalidTokens = new Set();

  for (const n of newNotices) {
    console.log('공지 알림 전송:', n.title);
    await sendTo(
      noticeTokens,
      { title: `📢 ${n.title}`, body: (n.content || '').slice(0, 120) },
      { url: './index.html' },
      invalidTokens
    );
  }
  for (const p of newPolls) {
    console.log('투표 알림 전송:', p.question);
    await sendTo(
      pollTokens,
      { title: `🗳️ 새 투표: ${p.question}`, body: '앱에서 투표에 참여해보세요' },
      { url: './index.html' },
      invalidTokens
    );
  }

  const nextNotifiedNotice = [...notifiedNotice, ...newNotices.map((n) => n.id)].slice(-KEEP_IDS);
  const nextNotifiedPoll = [...notifiedPoll, ...newPolls.map((p) => p.id)].slice(-KEEP_IDS);
  await db.collection('shared').doc('notifyState').set({
    notifiedNoticeIds: nextNotifiedNotice,
    notifiedPollIds: nextNotifiedPoll,
    updatedAt: Date.now(),
  });

  // 만료/무효 토큰은 다음 실행부터 대상에서 빠지도록 정리
  if (invalidTokens.size) {
    const batch = db.batch();
    for (const [token, uid] of tokenToUid.entries()) {
      if (invalidTokens.has(token)) {
        batch.update(db.collection('users').doc(uid), { fcmToken: FieldValue.delete() });
      }
    }
    await batch.commit();
    console.log(`만료된 토큰 ${invalidTokens.size}개 정리 완료`);
  }

  console.log(`완료 — 공지 ${newNotices.length}건, 투표 ${newPolls.length}건 알림 전송`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
