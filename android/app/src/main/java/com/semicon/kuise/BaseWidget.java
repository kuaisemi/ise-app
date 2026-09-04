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

    @Override
    public void onUpdate(Context ctx, AppWidgetManager mgr, int[] ids) {
        JSONObject data = WidgetData.load(ctx);
        WidgetTheme theme = WidgetTheme.from(data);
        for (int id : ids) {
            RemoteViews views = new RemoteViews(ctx.getPackageName(), layoutId());
            theme.applyBackground(views);
            applyCommonHeader(views, theme);
            render(ctx, views, data, theme);
            views.setOnClickPendingIntent(R.id.widget_root, openAppIntent(ctx));
            mgr.updateAppWidget(id, views);
        }
    }

    /**
     * 제목 줄은 모든 위젯이 같은 id를 쓰므로 여기서 한 번에 색을 입힌다.
     * (레이아웃에 없는 id에 대한 호출은 무시되므로 위젯마다 분기할 필요가 없다)
     */
    private void applyCommonHeader(RemoteViews views, WidgetTheme theme) {
        views.setInt(R.id.widget_accent, "setColorFilter", theme.accent);
        theme.title(views, R.id.widget_title);
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
