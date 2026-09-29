import fs from 'fs';
import vm from 'vm';
import path from 'path';
import crypto from 'crypto';

const html = fs.readFileSync('public/index.html', 'utf8');
const a = html.indexOf('/* ===== 웹 패치(OTA) =====');
const b = html.indexOf('let updateBannerShown = false;');
if (a < 0 || b < a) throw new Error('OTA block not found');
const block = html.slice(a, b).replace("const OTA_BASE = '__OTA_BASE__';", "const OTA_BASE = 'https://ota.example/';");

const DIST = 'dist';
const manifest = JSON.parse(fs.readFileSync(path.join(DIST, 'ota-manifest.json'), 'utf8'));

function run({ serverManifest, serverFiles, localManifest, otaState, buildId, tamper }) {
  const written = {};
  const calls = [];
  const rm = [];
  const sandbox = {
    console,
    window: { addEventListener() {} },
    document: { addEventListener() {}, activeElement: null, hidden: false, getElementById: () => null, createElement: () => ({ set innerHTML(v) {}, className: '', id: '' }), body: { appendChild() {} } },
    APP: { innerHTML: 'x'.repeat(600) },
    BUILD_ID: buildId,
    ANDROID_VERSION_CODE: manifest.minApk, // 지금 dist가 요구하는 APK 버전과 같은 앱으로 시험한다
    state: {},
    toast: (m) => calls.push(['toast', m]),
    isNativePlatformNow: () => true,
    crypto: crypto.webcrypto,
    btoa, atob, unescape, encodeURIComponent, Uint8Array, JSON, Date, Array, String, Number, Promise, Error, setTimeout: (fn, ms) => { if (typeof fn === 'function' && (ms || 0) <= 1000) Promise.resolve().then(fn); return 0; }, setInterval: () => 0,
    Capacitor: {
      Plugins: {
        Ota: {
          state: async () => otaState,
          arm: async (o) => { calls.push(['arm', o]); },
          confirm: async (o) => { calls.push(['confirm', o]); },
        },
        Filesystem: {
          writeFile: async (o) => { written[o.path] = Buffer.from(o.data, 'base64'); },
          rmdir: async (o) => { rm.push(o.path); },
          readdir: async () => ({ files: [{ name: 'old1' }, { name: buildId }] }),
          getUri: async (o) => ({ uri: 'file:///data/user/0/x/files/' + o.path }),
        },
        WebView: {
          setServerBasePath: async (o) => { calls.push(['setServerBasePath', o]); },
        },
      },
    },
    fetch: async (url) => {
      const u = String(url).split('?')[0];
      if (u === 'https://ota.example/ota-manifest.json') return { ok: true, json: async () => serverManifest };
      if (u === './ota-manifest.json') return localManifest ? { ok: true, json: async () => localManifest } : { ok: false };
      let file = null;
      if (u.startsWith('https://ota.example/')) { calls.push(['net', u.slice(20)]); file = serverFiles(u.slice(20)); }
      else if (u.startsWith('./')) { calls.push(['local', u.slice(2)]); file = fs.readFileSync(path.join(DIST, u.slice(2))); }
      if (!file) return { ok: false, status: 404 };
      if (tamper && u.endsWith(tamper)) file = Buffer.concat([file, Buffer.from('x')]);
      return { ok: true, status: 200, arrayBuffer: async () => file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength) };
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(block + '\nthis.__ota = { otaCheck, otaApply, otaConfirmBoot, get ready(){ return otaReady; } };', sandbox);
  return { sandbox, written, calls, rm };
}

const serverFiles = (p) => fs.readFileSync(path.join(DIST, p));
const newer = { ...manifest, build: '99999999999999' };
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok  ', m); } else { fail++; console.log('  FAIL', m); } };

// 1) 새 패치, 로컬 매니페스트 없음 → 전부 서버에서 받아 저장하고 적용 대기
{
  console.log('1) 새 패치 전체 다운로드');
  const t = run({ serverManifest: newer, serverFiles, localManifest: null, otaState: { pending: '', failed: '' }, buildId: '20260101000000' });
  const r = await t.sandbox.__ota.otaCheck();
  ok(r === 'ready', 'otaCheck → ready (' + r + ')');
  ok(Object.keys(t.written).length === manifest.files.length + 1, '파일 ' + Object.keys(t.written).length + '개 저장(매니페스트 포함)');
  ok(t.written['ota/99999999999999/index.html'] && t.written['ota/99999999999999/index.html'].length === manifest.files.find(f => f.path === 'index.html').size, 'index.html 크기 일치');
  await t.sandbox.__ota.otaApply();
  const arm = t.calls.find(c => c[0] === 'arm'), set = t.calls.find(c => c[0] === 'setServerBasePath');
  ok(arm && arm[1].version === '99999999999999' && arm[1].path === '/data/user/0/x/files/ota/99999999999999', 'arm 호출 인자');
  ok(set && set[1].path === arm[1].path, 'setServerBasePath 경로');
}
// 2) 로컬 매니페스트와 해시가 같은 파일은 네트워크 대신 로컬 복사
{
  console.log('2) 같은 해시는 로컬 복사');
  const changed = { ...newer, files: newer.files.map(f => f.path === 'index.html' ? { ...f, sha256: crypto.createHash('sha256').update(fs.readFileSync('dist/index.html')).digest('hex') } : f) };
  const t = run({ serverManifest: changed, serverFiles, localManifest: manifest, otaState: { pending: '', failed: '' }, buildId: '20260101000000' });
  const r = await t.sandbox.__ota.otaCheck();
  ok(r === 'ready', 'ready');
  ok(t.calls.filter(c => c[0] === 'net').length === 0, '네트워크 다운로드 0건');
  ok(t.calls.filter(c => c[0] === 'local').length === manifest.files.length, '로컬 복사 ' + t.calls.filter(c => c[0] === 'local').length + '건');
}
// 3) 손상된 파일 → 버린다
{
  console.log('3) 해시 불일치');
  const t = run({ serverManifest: newer, serverFiles, localManifest: null, otaState: { pending: '', failed: '' }, buildId: '20260101000000', tamper: 'index.html' });
  const r = await t.sandbox.__ota.otaCheck();
  ok(r === 'fail', '손상 → fail (' + r + ')');
  ok(!t.sandbox.__ota.ready, '적용 대기 없음');
  await t.sandbox.__ota.otaApply();
  ok(!t.calls.some(c => c[0] === 'arm' || c[0] === 'setServerBasePath'), 'arm/전환 호출 안 됨');
}
// 4) 같거나 오래된 버전, 실패했던 버전, pending 중, minApk 초과
for (const [label, opt, want] of [
  ['같은 버전', { serverManifest: manifest, otaState: { pending: '', failed: '' }, buildId: manifest.build }, 'latest'],
  ['오래된 버전', { serverManifest: { ...manifest, build: '20200101000000' }, otaState: { pending: '', failed: '' }, buildId: manifest.build }, 'latest'],
  ['이전에 실패한 버전', { serverManifest: newer, otaState: { pending: '', failed: newer.build }, buildId: '20260101000000' }, 'failed-before'],
  ['확인 대기 중', { serverManifest: newer, otaState: { pending: 'zzz', failed: '' }, buildId: '20260101000000' }, 'pending'],
  ['APK 버전 부족', { serverManifest: { ...newer, minApk: 999 }, otaState: { pending: '', failed: '' }, buildId: '20260101000000' }, 'need-apk'],
]) {
  console.log('4) ' + label);
  const t = run({ serverFiles, localManifest: null, ...opt });
  const r = await t.sandbox.__ota.otaCheck();
  ok(r === want, r + ' == ' + want);
  ok(Object.keys(t.written).length === 0, '아무것도 저장 안 함');
}
// 5) 확인 로직
{
  console.log('5) 부팅 확인');
  let t = run({ serverManifest: manifest, serverFiles, localManifest: null, otaState: { pending: 'B1', failed: '' }, buildId: 'B1' });
  await t.sandbox.__ota.otaConfirmBoot();
  ok(t.calls.some(c => c[0] === 'confirm' && c[1].version === 'B1'), '정상 → confirm');
  ok(t.rm.length === 1 && t.rm[0] === 'ota/old1', '옛 폴더 정리 (' + t.rm.join(',') + ')');
  t = run({ serverManifest: manifest, serverFiles, localManifest: null, otaState: { pending: 'B1', failed: '' }, buildId: 'B1' });
  t.sandbox.APP.innerHTML = '';
  await t.sandbox.__ota.otaConfirmBoot();
  ok(!t.calls.some(c => c[0] === 'confirm'), '화면이 안 그려지면 confirm 안 함');
  t = run({ serverManifest: manifest, serverFiles, localManifest: null, otaState: { pending: 'OTHER', failed: '' }, buildId: 'B1' });
  await t.sandbox.__ota.otaConfirmBoot();
  ok(!t.calls.some(c => c[0] === 'confirm'), '다른 버전이면 confirm 안 함');
}
// 6) 자동 모드: 받아 두면 다음 시작 때 열 화면으로 등록(arm)하고, 전환은 otaTrySwitch가 안전할 때 한다
{
  console.log('6) 자동 모드');
  const mk = (hidden) => {
    const t6 = run({ serverManifest: newer, serverFiles, localManifest: null, otaState: { pending: '', failed: '' }, buildId: '20260101000000' });
    t6.sandbox.document.hidden = hidden;
    return t6;
  };
  let t6 = mk(false);
  let r = await t6.sandbox.__ota.otaCheck({ auto: true });
  ok(r === 'ready', 'ready (' + r + ')');
  ok(t6.calls.some(c => c[0] === 'arm'), 'arm 호출(다음 시작에 열 화면 등록)');
  await new Promise(res => setTimeout(res, 50));
  await t6.sandbox.__ota.otaApply();
  ok(t6.calls.some(c => c[0] === 'setServerBasePath'), 'otaApply로 화면 전환');
  t6 = mk(true);
  r = await t6.sandbox.__ota.otaCheck({ auto: true });
  ok(r === 'ready' && t6.calls.some(c => c[0] === 'arm'), '화면 밖: 등록됨');
}
console.log(`\n통과 ${pass} / 실패 ${fail}`);
process.exit(fail ? 1 : 0);
