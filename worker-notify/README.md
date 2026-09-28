# 예약 알림 발송기 (Cloudflare Worker)

일정 알림처럼 "정해진 시각에 가야 하는" 푸시를 매분 확인해서 보내는 서버입니다.

## 왜 만들었나

알림 발송은 원래 GitHub Actions 크론이 5분 간격으로 돌렸습니다. 그런데 GitHub의 스케줄러는
5분을 지켜주지 않고 몇 분씩 더 밀립니다 — 실제로 10분 가까이 늦는 경우도 있습니다.
"오전 9시에 알림"처럼 시각이 중요한 기능은 이 위에 올릴 수가 없습니다.

Cloudflare Cron Trigger는 매분 돌릴 수 있어서 오차가 1분 안으로 들어옵니다.
새 공지·구인글·채팅 알림도 같이 빨라집니다(5분+ → 1분).

**실시간은 아닙니다.** 평균 30초, 최대 60초 기다립니다. 진짜 실시간(Firestore 변경을 보고
즉시 발송)은 Cloud Functions가 필요하고 그건 Blaze 유료 플랜이라 지금 구조에서는 불가능합니다.

## 처음 한 번만 하면 되는 설정

Cloudflare 계정이 필요합니다(무료, 카드 불필요). OCR Worker(`worker/`)를 이미 배포했다면
같은 계정을 그대로 쓰면 됩니다.

### 1. 로그인

```bash
cd worker-notify
npx wrangler login          # 브라우저가 열립니다
```

### 2. KV 네임스페이스 만들기

FCM 액세스 토큰과 수신 대상 목록을 캐싱하는 저장소입니다. 이게 없으면 매분 토큰을 새로
발급받느라 CPU 한도를 넘깁니다.

```bash
npx wrangler kv namespace create NOTIFY_CACHE
```

출력에 나오는 `id = "..."` 값을 `wrangler.toml`의 `PUT_KV_NAMESPACE_ID_HERE` 자리에
붙여넣으세요.

### 3. 서비스 계정 키 등록

Firebase 콘솔 → 프로젝트 설정 → **서비스 계정** 탭 → "새 비공개 키 생성" → JSON 다운로드.
(GitHub Secret `FIREBASE_SERVICE_ACCOUNT`에 넣어둔 것과 같은 값을 재사용해도 됩니다)

```bash
npx wrangler secret put FIREBASE_SERVICE_ACCOUNT
# 붙여넣기 창이 뜨면 JSON 파일 내용 전체를 그대로 붙여넣고 엔터
```

> JSON은 여러 줄이라 터미널에 따라 붙여넣기가 잘릴 수 있습니다. 잘렸다면
> `npx wrangler secret put FIREBASE_SERVICE_ACCOUNT < 키파일.json` 으로 넣으세요.

### 4. 배포

```bash
npx wrangler deploy
```

Cron Trigger는 `wrangler.toml`에 적혀 있어서 배포할 때 같이 등록됩니다. 따로 할 게 없습니다.

### 5. Firestore 인덱스 배포 (한 번만)

Worker가 쓰는 조회(`sent == false` + `at <= 지금`)에는 복합 인덱스가 필요합니다.
저장소 루트에서:

```bash
firebase deploy --only firestore:indexes,firestore:rules
```

인덱스가 만들어지는 데 몇 분 걸립니다. 그동안 Worker 로그에 조회 실패가 찍히는데 정상입니다.

## 잘 도는지 확인

```bash
npx wrangler tail          # 실시간 로그. 보낼 게 있을 때만 줄이 찍힙니다.
```

이 Worker는 **공개 주소가 없습니다**(`wrangler.toml`의 `workers_dev = false`). 크론으로만
도는 발송기라 바깥에서 부를 일이 없고, 주소가 없으면 공격 표면도 없습니다. 그래서 확인은
`wrangler tail`을 켜두고 최대 1분 기다리는 방식입니다.

`src/index.js`에는 수동 실행용 `/run` 핸들러가 들어 있지만 주소가 없어서 지금은 닿지
않습니다. 쓰고 싶으면 대시보드에서 workers.dev 서브도메인을 등록하고
`workers_dev = false`를 지우면 됩니다(서비스 계정 JSON의 `private_key_id` 마지막 8자리를
`?key=`로 넘겨야 통과합니다).

## 무료 한도와 이 코드

| 한도 | 이 Worker |
|---|---|
| 요청 10만 건/일 | 크론 1,440회/일 |
| 외부 요청 50개/실행 | `SUBREQUEST_BUDGET = 40`으로 직접 셈. 넘으면 남은 건 다음 분에 |
| CPU 10ms/실행 | 작은 JSON 몇 개 파싱만. RSA 서명(비쌈)은 KV에 55분 캐싱 |
| KV 읽기 10만 건/일 | 매분 2~3회 = 하루 4,000회 남짓 |

발송 대상이 많아도 요청 수가 안 늘어나는 이유는 **전교생 발송을 FCM 토픽으로** 하기
때문입니다(받는 사람이 몇 명이든 요청 1회). 토픽 구독은 GitHub Actions 쪽
`notify/send-notifications.mjs`가 5분마다 챙깁니다.

## 발송이 안 될 때 보는 순서

1. `npx wrangler tail` 에 `[notify] 실패:` 가 찍히는지 — 메시지에 원인이 나옵니다
2. `큐 조회 실패 400` → Firestore 복합 인덱스가 아직 안 만들어졌습니다 (위 5번)
3. `토큰 발급 실패 400` → `FIREBASE_SERVICE_ACCOUNT` 가 잘려서 들어갔습니다. 다시 넣으세요
4. 로그는 깨끗한데 푸시가 안 옴 → Firestore 콘솔에서 `notifyQueue` 문서의 `lastError` 필드 확인
5. `shared/pushAudience` 문서가 없으면 개인 알림이 안 갑니다 — GitHub Actions가 한 번은
   돌아야 생깁니다(5분 대기, 또는 Actions 탭에서 수동 실행)
