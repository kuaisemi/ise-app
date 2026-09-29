# Gemini OCR 프록시 (Cloudflare Worker)

시간표·학사일정 사진 인식에 쓰는 Gemini 호출을 대신 해주는 서버입니다.

## 왜 만들었나

예전에는 Gemini 키를 `public/index.html`에 넣고 빌드했습니다. 그런데 이 앱은 웹뷰를
그대로 감싼 구조라 `index.html`이 배포 사이트 소스에도, APK 안에도 텍스트 그대로
들어갑니다. 페이지 소스 보기 한 번이면 키가 그대로 나오는 상태였고, 실제로 키가
반복해서 폐기돼 그때마다 새로 발급받아 갈아끼워야 했습니다.

키를 서버에만 두면 이 문제가 없어집니다.

## 배포

Cloudflare 계정이 필요합니다(무료, 카드 불필요, 하루 10만 요청).

```bash
cd worker
npx wrangler login          # 브라우저가 열립니다
npx wrangler deploy         # 배포되면 https://ku-ise-ocr.<계정>.workers.dev 주소가 나옵니다

# 비밀값 등록 (붙여넣기 후 엔터)
npx wrangler secret put GEMINI_API_KEYS    # 키 여러 개면 쉼표로 구분: AQ.xxx,AQ.yyy
npx wrangler secret put FIREBASE_API_KEY   # public/index.html의 firebaseConfig.apiKey
```

배포 후 나온 주소를 `public/index.html`의 `GEMINI_PROXY_URL`에 넣으면 됩니다.

## 동작

- `POST /ocr` 만 받습니다.
- `Authorization: Bearer <Firebase ID 토큰>` 이 있어야 하고, 구글에 실제로 유효한
  토큰인지 물어본 뒤에만 통과시킵니다. 안 그러면 아무나 쓸 수 있는 공개 프록시가 됩니다.
- 앱이 쓰는 모델만 허용합니다(`ALLOWED_MODELS`).
- 키를 여러 개 넣어두면 401/403이 난 키는 건너뛰고 다음 것으로 넘어갑니다.
  429·500은 키를 바꿔도 같은 결과라 그대로 돌려줍니다.

## 키를 새로 발급받았을 때

앱을 다시 빌드할 필요가 없습니다. 이것만 하면 됩니다:

```bash
npx wrangler secret put GEMINI_API_KEYS
```
