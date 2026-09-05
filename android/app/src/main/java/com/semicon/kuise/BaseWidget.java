package com.semicon.kuise;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.Context;
import android.content.Intent;
import android.widget.RemoteViews;

import org.json.JSONObject;

/**
 * 위젯 6종이 공통으로 쓰는 부분 — 데이터 읽기, 색/투명도 적용, "탭하면 앱 열기", 갱신 루프.
 *
 * 각 위젯은 render()만 구현하면 된다.
 */
public abstract class BaseWidget extends AppWidgetProvider {

    /** 위젯 종류마다 다른 레이아웃 리소스 */
    protected abstract int layoutId();

    /** 실제로 값을 채워 넣는 부분 */
    protected abstract void render(Context ctx, RemoteViews views, JSONObject data, WidgetTheme theme);

    /**
     * 이 위젯의 글씨 크기를 따로 조절할 때 쓰는 키. MY탭 위젯 설정의 WIDGET_TYPES 키와
     * 정확히 같아야 한다 (timetable/nextClass/meal/schedule/week/calendar/date).
     */
    protected abstract String widgetKey();

    /**
     * 지금 그리는 위젯이 홈 화면에서 차지하는 크기(dp). 시간표처럼 "남는 높이에 맞춰
     * 시간 간격을 계산해야 하는" 위젯이 쓴다. 세로 화면 기준값(MIN_WIDTH/MIN_HEIGHT).
     */
    protected int widgetWidthDp = 0;
    protected int widgetHeightDp = 0;

    @Override
    public void onUpdate(Context ctx, AppWidgetManager mgr, int[] ids) {
        JSONObject data = WidgetData.load(ctx);
        WidgetTheme theme = WidgetTheme.from(data, widgetKey());
        for (int id : ids) {
            android.os.Bundle opts = mgr.getAppWidgetOptions(id);
            if (opts != null) {
                widgetWidthDp = opts.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 0);
                widgetHeightDp = opts.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, 0);
            }
            RemoteViews views = new RemoteViews(ctx.getPackageName(), layoutId());
            theme.applyBackground(views);
            applyCommonHeader(views, theme);
            render(ctx, views, data, theme);
            views.setOnClickPendingIntent(R.id.widget_root, openAppIntent(ctx));
            mgr.updateAppWidget(id, views);
        }
    }

    /**
     * 제목 줄은 모든 위젯이 같은 id를 쓰므로 여기서 한 번에 색/크기를 입힌다.
     * (레이아웃에 없는 id에 대한 호출은 무시되므로 위젯마다 분기할 필요가 없다)
     */
    private void applyCommonHeader(RemoteViews views, WidgetTheme theme) {
        views.setInt(R.id.widget_accent, "setColorFilter", theme.accent);
        theme.title(views, R.id.widget_title);
        theme.size(views, R.id.widget_title, 13f);
    }

    /** 사용자가 위젯 크기를 바꾸면 새 크기에 맞춰 다시 그린다 (시간표 격자 높이 계산 때문에 필요). */
    @Override
    public void onAppWidgetOptionsChanged(Context ctx, AppWidgetManager mgr, int id, android.os.Bundle newOptions) {
        super.onAppWidgetOptionsChanged(ctx, mgr, id, newOptions);
        onUpdate(ctx, mgr, new int[]{ id });
    }

    /**
     * 위젯 종류별로 눌렀을 때 앱의 어느 화면으로 바로 이동할지. null이면 그냥 홈 화면.
     * 값은 웹(index.html)의 applyWidgetDeepLink()가 아는 키와 맞춰야 한다.
     */
    protected String deepLinkTarget() {
        return null;
    }

    /** 위젯을 누르면 앱 본체를 연다 (deepLinkTarget이 있으면 해당 화면으로 바로 이동). */
    protected PendingIntent openAppIntent(Context ctx) {
        Intent intent = new Intent(ctx, MainActivity.class);
        intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        String target = deepLinkTarget();
        if (target != null) intent.putExtra(MainActivity.EXTRA_WIDGET_TARGET, target);
        // 같은 target이라도 매번 새 PendingIntent로 취급해야 onNewIntent가 확실히 불린다.
        int reqCode = target == null ? 0 : target.hashCode();
        return PendingIntent.getActivity(
            ctx, reqCode, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
    }

    /** 데이터가 아직 한 번도 안 들어온 상태인지 (앱을 한 번도 안 켠 경우) */
    protected boolean isEmpty(JSONObject data) {
        return data == null || data.length() == 0;
    }
}
