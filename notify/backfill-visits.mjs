// 1회용: 오늘(KST 00:00 이후) 마지막 접속 기록이 있는 가입자를 dailyVisits/{오늘}에 채워 넣는다.
// 방문 기록 방식이 바뀌기 전 버전을 쓰던 사람이나, 앱을 닫지 않고 다시 열어서 누락된 사람을 메운다.
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
if (!raw) { console.error('FIREBASE_SERVICE_ACCOUNT 환경변수가 없습니다.'); process.exit(1); }
initializeApp({ credential: cert(JSON.parse(raw)) });
const db = getFirestore();

const kst = new Date(Date.now() + 9 * 3600 * 1000);
const day = kst.toISOString().slice(0, 10);
const midnight = Date.parse(day + 'T00:00:00+09:00');

const snap = await db.collection('users').get();
const visits = {};
snap.forEach((d) => {
  const u = d.data();
  if (u.withdrawn || !u.lastSeen) return;
  if (Number(u.lastSeen) >= midnight) visits[d.id] = Number(u.lastSeen);
});
const before = (await db.collection('dailyVisits').doc(day).get()).data() || {};
const merged = { ...visits, ...before };       // 이미 적힌 값은 그대로 둔다
await db.collection('dailyVisits').doc(day).set(merged, { merge: true });
await db.collection('shared').doc('ver').set({ dailyVisits: Date.now() }, { merge: true });
console.log(`${day}: 가입자 ${snap.size}명 중 오늘 접속 ${Object.keys(visits).length}명, 기존 기록 ${Object.keys(before).length}명 → 합계 ${Object.keys(merged).length}명`);
