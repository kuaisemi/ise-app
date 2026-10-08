// ISE 앱 서비스워커
// 목적: PWA 설치 가능 조건 충족 + 오프라인 시 기본 화면(껍데기) 표시
// 주의: Firebase Auth/Firestore 통신은 캐시하지 않음 (항상 최신 데이터 필요)

const CACHE_NAME = 'ies-app-shell-v2';
const APP_SHELL = [
  './index.html',
  './manifest.json',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Firebase, Google API, 외부 CDN 요청은 서비스워커가 손대지 않고 그대로 통과 (항상 네트워크 우선)
  if (
    url.origin.includes('firebaseio.com') ||
    url.origin.includes('googleapis.com') ||
    url.origin.includes('gstatic.com') ||
    url.origin.includes('jsdelivr.net') ||
    url.origin.includes('fonts.googleapis.com') ||
    url.origin.includes('allorigins.win') ||
    url.origin.includes('corsproxy.io') ||
    // 새 버전 확인용 파일은 항상 네트워크에서 그대로 받아야 한다.
    // 캐시된 값이 돌아오면 새 버전이 떠도 영영 눈치채지 못한다.
    url.pathname.endsWith('/version.json') ||
    event.request.method !== 'GET'
  ) {
    return; // 브라우저 기본 동작에 맡김
  }

  // 같은 출처(앱 셸) 요청만 네트워크 우선 + 실패 시 캐시로 대체
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        const resClone = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, resClone));
        return res;
      })
      .catch(() => caches.match(event.request).then((cached) => cached || caches.match('./index.html')))
  );
});

// ===== 푸시 알림 (공지/투표) =====
// Firebase Admin SDK가 FCM으로 보낸 웹 푸시를 여기서 받아 OS 알림으로 띄움.
// firebase-messaging 라이브러리를 쓰지 않고 표준 Push API로 직접 처리 — 이 SW는
// 앱 셸 캐싱도 겸하고 있어서, 별도 firebase-messaging-sw.js를 추가로 등록하면
// 스코프가 겹쳐 서비스워커 두 개가 충돌할 수 있음.
self.addEventListener('push', (event) => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; } catch (e) {}
  const n = payload.notification || {};
  const title = n.title || 'ISE 지능형반도체공학과';
  const options = {
    body: n.body || '',
    icon: './icons/icon-192.png',
    badge: './icons/icon-96.png',
    data: { url: (payload.data && payload.data.url) || './index.html' },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || './index.html';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) { if ('focus' in c) return c.focus(); }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});
