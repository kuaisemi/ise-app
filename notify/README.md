# 알림 발송 (무료, Cloud Functions 없이)

새 공지·투표가 올라오면 FCM 푸시를 보내는 스크립트. Firebase Cloud Functions(Blaze 요금제 필요)
대신 GitHub Actions의 무료 스케줄러(cron)로 10분마다 실행해서 새 항목을 확인하고 보낸다.
카드 등록이 전혀 필요 없고, 이 저장소 규모에서는 100% 무료.

## 처음 설정할 때 딱 한 번 해야 하는 것

### 1. VAPID 키 발급 (웹 푸시용)
1. [Firebase 콘솔](https://console.firebase.google.com/project/ku-ise-d95ee/settings/cloudmessaging) → 프로젝트 설정 → **Cloud Messaging** 탭
2. "웹 구성" → "웹 푸시 인증서"에서 키 쌍 생성 (없으면 "키 쌍 생성" 버튼)
3. 생성된 키 문자열을 복사해서 `public/index.html`의 `FCM_VAPID_KEY = ''` 자리에 붙여넣기

### 2. 서비스 계정 키 발급 (서버가 FCM을 보낼 권한)
1. Firebase 콘솔 → 프로젝트 설정 → **서비스 계정** 탭
2. "새 비공개 키 생성" → JSON 파일 다운로드
3. **이 파일을 절대 git에 커밋하지 말 것.** 대신:
   - GitHub 저장소 → Settings → Secrets and variables → Actions → "New repository secret"
   - Name: `FIREBASE_SERVICE_ACCOUNT`
   - Value: 다운로드한 JSON 파일 내용 전체를 그대로 붙여넣기
4. 로컬에 남은 JSON 파일은 등록 후 삭제 권장

### 3. GitHub 저장소에 올리기
로컬에서 이미 `git init` + 첫 커밋까지는 되어 있음. 아래만 하면 됨:
```bash
git remote add origin <새로 만든 GitHub 저장소 URL>
git push -u origin main
```
Public/Private 아무거나 상관없음 (Private도 GitHub Actions 무료 사용량 안에서 충분히 돌아감).

## 이후에는?
위 3가지가 끝나면, 저장소에 push될 때마다 워크플로가 자동으로 최신 코드를 쓰고,
`.github/workflows/notify.yml`이 10분마다 자동 실행되며 새 공지/투표를 감지해서 보냄.
수동으로 바로 테스트하고 싶으면 GitHub 저장소 → Actions 탭 → "Send push notifications" →
"Run workflow" 버튼으로 즉시 실행 가능.

## 참고
- `shared/notifyState` Firestore 문서에 "이미 보낸 id" 목록을 최근 300개까지 저장해서 중복 발송을 막음.
- 만료되거나 무효화된 기기 토큰은 매 실행마다 자동으로 사용자 문서에서 정리됨.
- Firestore 보안 규칙에서 `users/{uid}` 컬렉션 전체 읽기와 `shared/notifyState` 쓰기를
  서비스 계정(Admin SDK)이 우회하므로 별도 규칙 수정은 필요 없음 — Admin SDK는 보안 규칙을 따르지 않음.
