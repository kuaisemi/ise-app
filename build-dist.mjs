// public/ 의 모든 코드 주석(HTML/CSS/JS)을 제거한 배포용 사본을 dist/ 에 만든다.
//
// 이유: 이 앱은 웹뷰를 그대로 감싼 구조라(server.url 없음) index.html이 APK 안에도,
// Firebase Hosting에도 텍스트 그대로 들어간다 — 즉 브라우저 "페이지 소스 보기"나 APK를
// 풀어보면 누구나 원문을 그대로 읽을 수 있다. 주석에는 "왜 이렇게 짰는지" 같은 내부 설계
// 판단이 그대로 담겨 있어서, 유지보수에는 필요하지만 외부에 공개될 필요는 없다.
//
// 그래서 git에는 주석이 있는 원본(public/)을 그대로 두고, 배포 직전에만 이 스크립트로
// 주석을 지운 사본(dist/)을 만들어 그걸 배포한다. firebase.json의 hosting.public과
// capacitor.config.json의 webDir이 dist를 가리키므로, 웹 배포(firebase deploy)와
// 앱 빌드(npx cap sync) 전에 반드시 이 스크립트를 먼저 실행해야 한다.
//
// JS는 정규식으로 "//"를 지우면 'https://...' 같은 문자열 안의 //까지 주석으로 오인해서
// 코드를 깨뜨릴 수 있어서, 문자열/정규식을 제대로 구분하는 terser(AST 기반)로 주석만 지운다
// (압축·이름 변경은 하지 않음 — 읽기 편하려고 지우는 게 아니라 순수 배포용이라 상관없음).

import fs from 'fs';
import path from 'path';
import { minify } from 'terser';

const ROOT = path.dirname(new URL(import.meta.url).pathname).replace(/^\/([a-zA-Z]:)/, '$1');
const SRC_DIR = path.join(ROOT, 'public');
const OUT_DIR = path.join(ROOT, 'dist');

function stripCss(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

function stripHtmlComments(html) {
  return html.replace(/<!--[\s\S]*?-->/g, '');
}

async function stripJs(js) {
  const result = await minify(js, {
    compress: false,
    mangle: false,
    format: { comments: false, beautify: true, indent_level: 2 },
  });
  if (result.error) throw result.error;
  return result.code;
}

async function processIndexHtml() {
  let html = fs.readFileSync(path.join(SRC_DIR, 'index.html'), 'utf8');

  // <style>...</style> 안의 CSS 주석 제거
  html = html.replace(/(<style[^>]*>)([\s\S]*?)(<\/style>)/g, (_, open, css, close) => {
    return open + stripCss(css) + close;
  });

  // <script type="module">...</script> 안의 JS 주석 제거 (terser, 비동기라 순서대로 처리)
  const scriptRe = /(<script type="module">)([\s\S]*?)(<\/script>)/;
  const m = scriptRe.exec(html);
  if (m) {
    const stripped = await stripJs(m[2]);
    html = html.slice(0, m.index) + m[1] + stripped + m[3] + html.slice(m.index + m[0].length);
  }

  // 나머지 HTML 주석 제거 (스크립트는 이미 처리됐고, 코드 안에 리터럴 <!-- 가 없으므로 전체에 적용해도 안전)
  html = stripHtmlComments(html);

  return html;
}

async function processSwJs() {
  const js = fs.readFileSync(path.join(SRC_DIR, 'sw.js'), 'utf8');
  return stripJs(js);
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

// 예전에는 여기서 secrets.local.json의 Gemini 키를 dist/index.html에 끼워 넣었다.
// 그런데 이 앱은 웹뷰를 그대로 감싼 구조라 dist/index.html이 배포 사이트 소스에도 APK
// 안에도 텍스트 그대로 들어간다 — 키를 깃허브에서만 숨겼을 뿐 배포하는 순간 누구나 볼 수
// 있었고, 그래서 키가 계속 폐기됐다. 지금은 키를 Firestore(shared/geminiKeys)에 두고
// 앱이 실행할 때 읽어오므로 빌드가 키를 다룰 일이 없다.
// (secrets.local.json은 더 이상 쓰이지 않는다)

// 웹/PWA에서 "새 버전 나왔어요"를 띄우려면 지금 돌고 있는 코드가 어느 빌드인지 알아야 한다.
// 빌드할 때마다 바뀌는 값을 index.html 안에 심고, 같은 값을 version.json으로도 내보낸다.
// 앱은 주기적으로 version.json을 받아 자기 값과 다르면 새로고침을 권한다.
// (terser가 따옴표를 바꿔 쓰므로 정확한 문자열이 아니라 선언 자체를 정규식으로 찾는다)
function injectBuildId(html, buildId) {
  const re = /const BUILD_ID = ["'][^"']*["'];/;
  if (!re.test(html)) {
    throw new Error('BUILD_ID 자리표시자를 못 찾음 — public/index.html이 바뀌었는지 확인');
  }
  return html.replace(re, `const BUILD_ID = "${buildId}";`);
}

async function main() {
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  copyDir(SRC_DIR, OUT_DIR);

  const buildId = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);

  let strippedHtml = await processIndexHtml();
  strippedHtml = injectBuildId(strippedHtml, buildId);
  fs.writeFileSync(path.join(OUT_DIR, 'index.html'), strippedHtml, 'utf8');
  fs.writeFileSync(path.join(OUT_DIR, 'version.json'), JSON.stringify({ build: buildId }) + '\n', 'utf8');

  const strippedSw = await processSwJs();
  fs.writeFileSync(path.join(OUT_DIR, 'sw.js'), strippedSw, 'utf8');

  const beforeSize = fs.statSync(path.join(SRC_DIR, 'index.html')).size;
  const afterSize = fs.statSync(path.join(OUT_DIR, 'index.html')).size;
  console.log(`dist/ 생성 완료 — index.html ${beforeSize} bytes → ${afterSize} bytes (주석 제거)`);
}

main().catch((e) => {
  console.error('build-dist 실패:', e);
  process.exit(1);
});
