// KU ISE — Gemini OCR 프록시 (Cloudflare Worker)
//
// 왜 필요한가:
// 예전에는 Gemini 키를 public/index.html에 넣고 빌드해서 배포했다. 그런데 이 앱은 웹뷰를
// 그대로 감싼 구조라 index.html이 배포 사이트 소스에도, APK 안에도 텍스트 그대로 들어간다.
// 즉 "페이지 소스 보기" 한 번이면 키가 그대로 나온다. 실제로 키가 반복해서 폐기됐고,
// 그때마다 새로 발급받아 갈아끼우는 일이 계속됐다.
//
// 그래서 키를 여기(서버)에만 두고, 앱은 이 Worker를 통해서만 Gemini를 부른다.
// 아무나 쓰면 남의 할당량을 태우는 공개 프록시가 되므로, 로그인한 사용자의 Firebase
// ID 토큰을 먼저 확인한다.

// 앱이 실제로 쓰는 모델만 통과시킨다. 이걸 안 막으면 남이 이 주소로 아무 모델이나
// (비싼 것 포함) 호출할 수 있다.
const ALLOWED_MODELS = new Set([
  'gemini-3.6-flash',
  'gemini-flash-latest',
  'gemini-3.5-flash',
]);

// 웹 배포본과 APK 웹뷰에서 오는 요청만 받는다. Capacitor 안드로이드 웹뷰는
// https://localhost 를 origin으로 보낸다.
const ALLOWED_ORIGINS = new Set([
  'https://ku-ise-d95ee.web.app',
  'https://ku-ise-d95ee.firebaseapp.com',
  'https://localhost',
  'http://localhost',
]);

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.has(origin) ? origin : 'https://ku-ise-d95ee.web.app';
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

function json(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
}

// Firebase ID 토큰 검증.
// JWT 서명을 직접 검증하는 대신 구글의 accounts:lookup을 부른다. 네트워크 왕복이 한 번
// 늘지만 OCR 호출 자체가 몇 초 걸리는 작업이라 체감되지 않고, 공개키 캐싱·만료·kid 회전을
// 직접 구현하다 틀리는 것보다 안전하다. 여기 쓰는 FIREBASE_API_KEY는 원래 공개되는 값이다.
async function verifyIdToken(idToken, apiKey) {
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken }),
    }
  );
  if (!res.ok) return null;
  const data = await res.json();
  const user = data.users && data.users[0];
  return user ? user.localId : null;
}

// 공식 학사일정 페이지 프록시.
// 앱이 예전엔 공개 CORS 프록시(allorigins, codetabs, proxy.cors.sh)를 여러 개 순서대로
// 시도했는데, 전부 무료 공개 서비스라 죽어있거나 막혀 있는 날이 잦아 "불러오기 실패"가
// 계속 났다. Cloudflare Worker는 서버라 애초에 CORS 제약이 없으므로, 여기서 학교 페이지를
// 직접 받아 그대로 돌려주면 남의 프록시에 기대지 않아도 된다.
// 아무 URL이나 받는 열린 프록시가 되지 않도록 이 한 페이지 주소만 고정해서 부른다.
const REGISTRAR_SCHEDULE_URL = 'https://registrar.korea.ac.kr/eduinfo/affairs/schedule.do';
async function handleScheduleProxy(origin) {
  try {
    const res = await fetch(REGISTRAR_SCHEDULE_URL, {
      cf: { cacheTtl: 3600, cacheEverything: true },
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; KUISEBot/1.0)' },
    });
    if (!res.ok) {
      return json({ error: { message: `학교 페이지 응답 오류 (${res.status})` } }, 502, origin);
    }
    const text = await res.text();
    return new Response(text, {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8', ...corsHeaders(origin) },
    });
  } catch (e) {
    return json({ error: { message: '학교 페이지에 접근하지 못했습니다.' } }, 502, origin);
  }
}

// 에브리타임 시간표 공유 링크 가져오기.
// 공유 링크(everytime.kr/@식별자) 페이지는 화면이 뜬 뒤 아래 주소에 식별자를 보내 시간표 XML을
// 받아온다. 로그인 없이 "전체 공개" 시간표만 돌려준다. 브라우저에서 바로 부르면 CORS에 막히므로
// 여기서 대신 부른다. AI를 쓰지 않으니 Gemini 사용량과 무관하다.
// 열린 프록시가 되지 않도록 식별자 하나만 받아 이 주소 하나만 부르고, 원본 XML을 그대로 넘기지 않고
// 수업 목록과 학기별 시간표 식별자만 뽑아서 돌려준다(이름 등 나머지는 버린다).
const EVERYTIME_TABLE_URL = 'https://api.everytime.kr/find/timetable/table/friend';

function xmlUnescape(s) {
  return String(s || '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&');
}
function xmlAttr(tag, name) {
  const m = tag.match(new RegExp(`\\b${name}="([^"]*)"`));
  return m ? xmlUnescape(m[1]) : '';
}

async function handleEverytime(request, origin) {
  let body;
  try { body = await request.json(); } catch (e) { body = null; }
  const identifier = body && String(body.identifier || '');
  if (!/^[A-Za-z0-9]{8,40}$/.test(identifier)) {
    return json({ error: { code: 'bad-link', message: '에브리타임 시간표 공유 링크가 아니에요.' } }, 400, origin);
  }
  let xml;
  try {
    const res = await fetch(EVERYTIME_TABLE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Origin': 'https://everytime.kr',
        'Referer': 'https://everytime.kr/',
        'User-Agent': 'Mozilla/5.0',
      },
      body: `identifier=${identifier}&friendInfo=true`,
    });
    if (!res.ok) {
      return json({ error: { code: 'upstream', message: `에브리타임 응답 오류 (${res.status})` } }, 502, origin);
    }
    xml = await res.text();
  } catch (e) {
    return json({ error: { code: 'upstream', message: '에브리타임에 접속하지 못했어요.' } }, 502, origin);
  }

  const tableTag = (xml.match(/<table\b[^>]*>/) || [])[0];
  if (!tableTag) {
    // 비공개·친구 공개 시간표이거나 없는 링크면 table 자체가 오지 않는다.
    return json({ error: { code: 'private', message: '시간표를 볼 수 없어요. 공개 범위가 전체 공개인지 확인해 주세요.' } }, 404, origin);
  }
  const classes = [];
  for (const sm of xml.matchAll(/<subject\b[^>]*>([\s\S]*?)<\/subject>/g)) {
    const inner = sm[1];
    const name = xmlAttr((inner.match(/<name\b[^>]*>/) || [''])[0], 'value');
    const professor = xmlAttr((inner.match(/<professor\b[^>]*>/) || [''])[0], 'value');
    for (const dm of inner.matchAll(/<data\b[^>]*>/g)) {
      const day = parseInt(xmlAttr(dm[0], 'day'), 10);
      const start = parseInt(xmlAttr(dm[0], 'starttime'), 10);
      const end = parseInt(xmlAttr(dm[0], 'endtime'), 10);
      if (!(day >= 0 && day <= 6) || !(start >= 0) || !(end > start)) continue;
      // 시각은 5분 단위 칸 번호다(108 → 9:00, 166 → 13:50). 분으로 바꿔 보낸다.
      classes.push({ day, start: start * 5, end: end * 5, subject: name, professor, room: xmlAttr(dm[0], 'place') });
    }
  }
  // 같은 사람의 학기별 대표 시간표 목록(앱의 "이전 학기도 모두 가져오기"용). 이름은 보내지 않는다.
  const tables = [...xml.matchAll(/<primaryTable\b[^>]*>/g)]
    .map((m) => ({ year: xmlAttr(m[0], 'year'), semester: xmlAttr(m[0], 'semester'), identifier: xmlAttr(m[0], 'identifier') }))
    .filter((t) => /^[A-Za-z0-9]{8,40}$/.test(t.identifier));
  return json({
    year: xmlAttr(tableTag, 'year'),
    semester: xmlAttr(tableTag, 'semester'),
    classes,
    tables,
  }, 200, origin);
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const pathname = new URL(request.url).pathname;

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (pathname === '/everytime') {
      if (request.method !== 'POST') {
        return json({ error: { message: 'POST만 허용됩니다.' } }, 405, origin);
      }
      return handleEverytime(request, origin);
    }
    if (pathname === '/schedule') {
      if (request.method !== 'GET') {
        return json({ error: { message: 'GET만 허용됩니다.' } }, 405, origin);
      }
      return handleScheduleProxy(origin);
    }
    if (request.method !== 'POST') {
      return json({ error: { message: 'POST만 허용됩니다.' } }, 405, origin);
    }
    if (pathname !== '/ocr') {
      return json({ error: { message: '없는 경로입니다.' } }, 404, origin);
    }

    const auth = request.headers.get('Authorization') || '';
    const idToken = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    if (!idToken) {
      return json({ error: { message: '로그인이 필요합니다.' } }, 401, origin);
    }
    const uid = await verifyIdToken(idToken, env.FIREBASE_API_KEY);
    if (!uid) {
      return json({ error: { message: '로그인 정보가 만료되었습니다. 다시 로그인해주세요.' } }, 401, origin);
    }

    let body;
    try {
      body = await request.json();
    } catch (e) {
      return json({ error: { message: '요청 형식이 올바르지 않습니다.' } }, 400, origin);
    }

    const model = body && body.model;
    const payload = body && body.payload;
    if (!model || !ALLOWED_MODELS.has(model) || !payload) {
      return json({ error: { message: '허용되지 않은 요청입니다.' } }, 400, origin);
    }

    // 키를 여러 개 넣어두고 하나가 죽으면 다음 것으로 넘어간다(앱에서 하던 fallback을
    // 그대로 서버로 옮긴 것). 쉼표로 구분해 secret 하나에 넣는다.
    const keys = String(env.GEMINI_API_KEYS || '')
      .split(',')
      .map((k) => k.trim())
      .filter(Boolean);
    if (!keys.length) {
      return json({ error: { message: '서버에 API 키가 설정되지 않았습니다.' } }, 500, origin);
    }

    let last = null;
    for (const key of keys) {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
          body: JSON.stringify(payload),
        }
      );
      const data = await res.json().catch(() => ({}));
      // 인증·권한 문제(401/403)일 때만 다음 키로 넘어간다. 429나 500은 키를 바꿔도
      // 같은 결과라 그대로 돌려준다.
      if (res.ok || (res.status !== 401 && res.status !== 403)) {
        return json(data, res.status, origin);
      }
      last = data;
    }
    return json(last || { error: { message: '모든 키가 거부되었습니다.' } }, 401, origin);
  },
};
