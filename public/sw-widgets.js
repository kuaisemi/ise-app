// ===== Windows 11 위젯 (Edge로 설치한 PWA) =====
// 앱(index.html)이 pushWidgetData에서 안드로이드 위젯과 똑같은 재료를 IndexedDB에 넣어 두면,
// 여기서 그걸 읽어 위젯 카드(Adaptive Card)를 만들어 위젯 보드에 보낸다.
// 서비스워커는 localStorage·Firestore 로그인에 접근할 수 없어서, 앱을 열었던 때의 데이터를 쓴다.
// "지금 몇 번째 수업인지" 같은 시간 판단은 위젯이 보일 때(widgetresume) 여기서 다시 계산한다.
// sw.js 맨 위에서 importScripts로 불러온다 (이벤트 리스너는 최상위에서 등록해야 하므로).
const WIDGET_DB = 'ise-widgets';
function widgetDbOpen(){
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(WIDGET_DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function widgetDbGet(key){
  const db = await widgetDbOpen();
  return new Promise((resolve, reject) => {
    const q = db.transaction('kv').objectStore('kv').get(key);
    q.onsuccess = () => resolve(q.result);
    q.onerror = () => reject(q.error);
  });
}

const WD_DAYS = ['일','월','화','수','목','금','토'];
const WD_PAD = (n) => String(n).padStart(2, '0');
const WD_YMD = (d) => `${d.getFullYear()}-${WD_PAD(d.getMonth()+1)}-${WD_PAD(d.getDate())}`;
const WD_HM = (m) => `${WD_PAD(Math.floor(m/60))}:${WD_PAD(m%60)}`;

function wdText(text, o){ return Object.assign({ type: 'TextBlock', text: String(text), wrap: true }, o || {}); }
function wdCard(body){
  return { type: 'AdaptiveCard', $schema: 'http://adaptivecards.io/schemas/adaptive-card.json', version: '1.5', body };
}
// 카드 아무 데나 누르면 앱의 해당 화면으로 (widgetclick → open)
function wdOpen(card, target){ card.selectAction = { type: 'Action.Execute', verb: 'open', data: { target } }; return card; }
function wdEmpty(msg){ return [wdText(msg, { isSubtle: true, horizontalAlignment: 'Center', spacing: 'Large' })]; }

// 앱 데이터가 오늘 것인지 — 어제 열었던 데이터면 식단/일정은 "오늘" 기준으로 그대로 쓰면 안 된다.
function wdFreshness(p, now){
  const yest = new Date(now); yest.setDate(yest.getDate() - 1);
  const ud = WD_YMD(new Date(p.updatedAt || 0));
  return { sameDay: ud === WD_YMD(now), dayBefore: ud === WD_YMD(yest) };
}

function wdClassesOf(p, di){ return (di >= 0 && di < 5 && p.weekClasses && p.weekClasses[di]) || []; }

function wdBuildTimetable(p, s, now){
  const di = (now.getDay() + 6) % 7, mins = now.getHours() * 60 + now.getMinutes();
  const list = wdClassesOf(p, di);
  const head = wdText(`오늘의 시간표 · ${now.getMonth()+1}월 ${now.getDate()}일 (${WD_DAYS[now.getDay()]})`, { weight: 'Bolder', size: 'Medium' });
  if(!list.length) return wdOpen(wdCard([head, ...wdEmpty('오늘은 수업이 없어요')]), 'timetable');
  const rows = list.map((c) => {
    const ongoing = c.start <= mins && mins < c.end, done = c.end <= mins;
    return {
      type: 'ColumnSet', spacing: 'Small',
      columns: [
        { type: 'Column', width: '78px', items: [wdText(`${WD_HM(c.start)}–${WD_HM(c.end)}`, { size: 'Small', isSubtle: !ongoing, color: ongoing ? 'Accent' : 'Default' })] },
        { type: 'Column', width: 'stretch', items: [wdText(`${ongoing ? '▶ ' : ''}${c.subject}${c.room ? ' · ' + c.room : ''}`, { weight: ongoing ? 'Bolder' : 'Default', isSubtle: done, color: ongoing ? 'Accent' : 'Default' })] },
      ],
    };
  });
  return wdOpen(wdCard([head, ...rows]), 'timetable');
}

function wdBuildNextClass(p, s, now){
  const di = (now.getDay() + 6) % 7, mins = now.getHours() * 60 + now.getMinutes();
  const today = wdClassesOf(p, di);
  const cur = today.find((c) => c.start <= mins && mins < c.end);
  let label, c, when;
  if(cur){ label = '수업 중'; c = cur; when = `${WD_HM(c.start)}–${WD_HM(c.end)} (${WD_HM(c.end)}에 끝나요)`; }
  else {
    const nxt = today.find((x) => x.start > mins);
    if(nxt){ label = '다음 수업'; c = nxt; when = `${WD_HM(c.start)} 시작`; }
    else {
      for(let i = 1; i <= 7 && !c; i++){
        const d = (di + i) % 7, list = wdClassesOf(p, d);
        if(list.length){ c = list[0]; label = i === 1 ? '내일 첫 수업' : `${WD_DAYS[(d + 1) % 7]}요일 첫 수업`; when = `${WD_HM(c.start)} 시작`; }
      }
    }
  }
  if(!c) return wdOpen(wdCard([wdText('다음 수업', { weight: 'Bolder' }), ...wdEmpty('등록된 수업이 없어요')]), 'timetable');
  return wdOpen(wdCard([
    wdText(label, { size: 'Small', isSubtle: true }),
    wdText(c.subject, { size: 'Large', weight: 'Bolder', color: 'Accent' }),
    wdText(when, { spacing: 'Small' }),
    ...(c.room ? [wdText(`📍 ${c.room}`, { isSubtle: true, spacing: 'None' })] : []),
  ]), 'timetable');
}

function wdBuildWeek(p, s, now){
  const di = (now.getDay() + 6) % 7;
  const cols = [0, 1, 2, 3, 4].map((d) => ({
    type: 'Column', width: 'stretch',
    items: [
      wdText(WD_DAYS[(d + 1) % 7], { weight: 'Bolder', horizontalAlignment: 'Center', color: d === di ? 'Accent' : 'Default' }),
      ...wdClassesOf(p, d).map((c) => ({
        type: 'Container', spacing: 'Small', style: d === di ? 'emphasis' : 'default',
        items: [
          wdText(c.subject, { size: 'Small', weight: 'Bolder', spacing: 'None' }),
          ...(s.weekShowTime ? [wdText(`${WD_HM(c.start)}–${WD_HM(c.end)}`, { size: 'Small', isSubtle: true, spacing: 'None' })] : []),
          ...(s.weekShowRoom && c.room ? [wdText(c.room, { size: 'Small', isSubtle: true, spacing: 'None' })] : []),
        ],
      })),
    ],
  }));
  return wdOpen(wdCard([wdText(`주간 시간표${p.semester ? ' · ' + p.semester : ''}`, { weight: 'Bolder' }), { type: 'ColumnSet', columns: cols }]), 'timetable');
}

function wdBuildMeal(p, s, now){
  const f = wdFreshness(p, now), m = p.meals || {};
  const day = f.sameDay ? m.today : (f.dayBefore ? m.tomorrow : null);
  const head = wdText(`오늘의 학식 · ${now.getMonth()+1}월 ${now.getDate()}일`, { weight: 'Bolder', size: 'Medium' });
  if(!day) return wdOpen(wdCard([head, ...wdEmpty('앱을 한 번 열면 오늘 식단이 보여요')]), 'meal');
  const h = now.getHours();
  const focus = h < 9 ? 'breakfast' : h < 14 ? 'lunch' : 'dinner';
  const block = (title, text, hot) => ({
    type: 'Container', spacing: 'Small',
    items: [wdText(title, { size: 'Small', weight: 'Bolder', color: hot ? 'Accent' : 'Default', spacing: 'None' }), wdText(text || '운영 안 함', { size: 'Small', isSubtle: !text, spacing: 'None' })],
  });
  const body = [head];
  if(s.mealShowJinri) body.push(block('진리관 · 조식', day.breakfast, focus === 'breakfast'), block('진리관 · 중식', day.lunch, focus === 'lunch'), block('진리관 · 석식', day.dinner, focus === 'dinner'));
  if(s.mealShowMirae) body.push(block('미래관 · 중식', day.staffLunch, false));
  if(!s.mealShowJinri && !s.mealShowMirae) body.push(...wdEmpty('표시할 식당이 꺼져 있어요'));
  return wdOpen(wdCard(body), 'meal');
}

function wdBuildSchedule(p, s, now){
  const f = wdFreshness(p, now);
  const body = [wdText('일정 · 메모', { weight: 'Bolder', size: 'Medium' })];
  const evs = p.events || [];
  if(evs.length) evs.forEach((e) => body.push({ type: 'ColumnSet', spacing: 'Small', columns: [
    { type: 'Column', width: '64px', items: [wdText(e.date, { size: 'Small', color: 'Accent' })] },
    { type: 'Column', width: 'stretch', items: [wdText(e.title, { size: 'Small' })] },
  ] }));
  else body.push(...wdEmpty('다가오는 일정이 없어요'));
  if(f.sameDay && p.memo) body.push(wdText('📝 ' + p.memo, { size: 'Small', isSubtle: true, spacing: 'Medium' }));
  return wdOpen(wdCard(body), 'schedule');
}

function wdBuildCalendar(p, s, now){
  const y = now.getFullYear(), mo = now.getMonth(), today = now.getDate();
  const first = new Date(y, mo, 1).getDay(), last = new Date(y, mo + 1, 0).getDate();
  const marked = p.markedDates || {};
  const upd = new Date(p.updatedAt || 0);
  const sameMonth = upd.getMonth() === mo && upd.getFullYear() === y;   // 점 정보는 앱을 열었던 달 것만 맞다
  const cell = (txt, o) => ({ type: 'Column', width: 'stretch', items: [wdText(txt, Object.assign({ horizontalAlignment: 'Center', size: 'Small', spacing: 'None' }, o || {}))] });
  const rows = [{ type: 'ColumnSet', columns: WD_DAYS.map((d, i) => cell(d, { isSubtle: true, color: i === 0 ? 'Attention' : 'Default' })) }];
  let n = 1 - first;
  while(n <= last){
    const cols = [];
    for(let i = 0; i < 7; i++, n++){
      if(n < 1 || n > last){ cols.push(cell(' ')); continue; }
      const key = `${y}-${WD_PAD(mo + 1)}-${WD_PAD(n)}`;
      const isToday = n === today, dot = sameMonth && marked[key];
      cols.push(cell(String(n), { weight: isToday || dot ? 'Bolder' : 'Default', color: isToday ? 'Accent' : (dot ? 'Good' : (i === 0 ? 'Attention' : 'Default')) }));
    }
    rows.push({ type: 'ColumnSet', spacing: 'Small', columns: cols });
  }
  const body = [wdText(`${y}년 ${mo + 1}월`, { weight: 'Bolder' }), ...rows];
  if(s.calendarShowMemo && wdFreshness(p, now).sameDay && p.memo) body.push(wdText('📝 ' + p.memo, { size: 'Small', isSubtle: true, spacing: 'Medium' }));
  return wdOpen(wdCard(body), 'examCal');
}

function wdTodayEventTitles(p, now, official, council){
  if(!wdFreshness(p, now).sameDay) return [];
  return (p.todayEvents || []).filter((e) => (e.official ? official : council)).map((e) => e.title);
}

function wdBuildCalendarWide(p, s, now){
  const titles = wdTodayEventTitles(p, now, s.calendarShowOfficial, s.calendarShowCouncil);
  const right = [wdText('오늘 일정', { size: 'Small', isSubtle: true })];
  titles.slice(0, 6).forEach((t) => right.push(wdText('• ' + t, { size: 'Small', spacing: 'Small' })));
  if(s.calendarShowMemo && wdFreshness(p, now).sameDay && p.memo) right.push(wdText('📝 ' + p.memo, { size: 'Small', isSubtle: true, spacing: 'Small' }));
  if(right.length === 1) right.push(wdText('오늘은 일정이 없어요', { size: 'Small', isSubtle: true }));
  return wdOpen(wdCard([{ type: 'ColumnSet', columns: [
    { type: 'Column', width: '90px', items: [
      wdText(`${now.getMonth() + 1}월`, { size: 'Small', isSubtle: true, horizontalAlignment: 'Center' }),
      wdText(String(now.getDate()), { size: 'ExtraLarge', weight: 'Bolder', color: 'Accent', horizontalAlignment: 'Center', spacing: 'None' }),
      wdText(`${WD_DAYS[now.getDay()]}요일`, { size: 'Small', horizontalAlignment: 'Center', spacing: 'None' }),
    ] },
    { type: 'Column', width: 'stretch', items: right },
  ] }]), 'examCal');
}

function wdBuildDate(p, s, now){
  const body = [
    wdText(`${now.getFullYear()}년 ${now.getMonth() + 1}월`, { size: 'Small', isSubtle: true, horizontalAlignment: 'Center' }),
    wdText(String(now.getDate()), { size: 'ExtraLarge', weight: 'Bolder', color: 'Accent', horizontalAlignment: 'Center', spacing: 'None' }),
    wdText(`${WD_DAYS[now.getDay()]}요일`, { horizontalAlignment: 'Center', spacing: 'None' }),
  ];
  if(s.dateShowEvents) wdTodayEventTitles(p, now, true, true).slice(0, 2).forEach((t) => body.push(wdText(t, { size: 'Small', isSubtle: true, horizontalAlignment: 'Center', spacing: 'Small' })));
  return wdOpen(wdCard(body), 'schedule');
}

const WD_BUILDERS = {
  timetable: wdBuildTimetable, week: wdBuildWeek, nextClass: wdBuildNextClass, meal: wdBuildMeal,
  schedule: wdBuildSchedule, calendar: wdBuildCalendar, calendarWide: wdBuildCalendarWide, date: wdBuildDate,
};
const WD_DEFAULTS = { weekShowTime: true, weekShowRoom: false, mealShowJinri: true, mealShowMirae: true, calendarShowMemo: true, calendarShowOfficial: true, calendarShowCouncil: true, dateShowEvents: true };

async function wdRenderOne(widget){
  const tag = widget.definition && widget.definition.tag;
  const build = WD_BUILDERS[tag];
  if(!build) return;
  const rec = await widgetDbGet('payload').catch(() => null);
  const card = (rec && rec.payload)
    ? build(rec.payload, Object.assign({}, WD_DEFAULTS, (rec.settings || {})[tag]), new Date())
    : wdCard(wdEmpty('ISE 앱을 한 번 열고 로그인하면 여기에 보여요'));
  await self.widgets.updateByInstanceId(widget.instanceId, { template: JSON.stringify(card), data: '{}' });
}
async function wdRenderAll(){
  if(!self.widgets) return;
  for(const tag of Object.keys(WD_BUILDERS)){
    const list = await self.widgets.getByTag(tag).catch(() => []);
    for(const w of list) await wdRenderOne(w).catch((e) => console.warn('[widget]', tag, e));
  }
}

if(self.widgets){
  self.addEventListener('widgetinstall', (e) => e.waitUntil(wdRenderOne(e.widget)));
  self.addEventListener('widgetresume', (e) => e.waitUntil(wdRenderOne(e.widget)));
  self.addEventListener('widgetclick', (e) => {
    const target = (e.action === 'open' && e.data && e.data.target) || 'timetable';
    e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for(const c of list){
        if('focus' in c){ c.postMessage({ type: 'widget-deeplink', target }); return c.focus(); }
      }
      return self.clients.openWindow(`./index.html?widget=${encodeURIComponent(target)}`);
    }));
  });
}
self.addEventListener('message', (e) => {
  if(e.data && e.data.type === 'widgets-refresh') e.waitUntil(wdRenderAll());
});
self.addEventListener('periodicsync', (e) => {
  if(e.tag === 'widgets-refresh') e.waitUntil(wdRenderAll());
});
