package com.semicon.kuise;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.Context;
import android.content.Intent;
import android.widget.RemoteViews;

import org.json.JSONObject;

/**
 * 위젯 4종이 공통으로 쓰는 부분 — 데이터 읽기, "탭하면 앱 열기" 연결, 갱신 루프.
 *
 * 각 위젯은 render()만 구현하면 된다.
 */
public abstract class BaseWidget extends AppWidgetProvider {

    /** 위젯 종류마다 다른 레이아웃 리소스 */
    protected abstract int layoutId();

    /** 실제로 값을 채워 넣는 부분 */
    protected abstract void render(Context ctx, RemoteViews views, JSONObject data);

    /** 위젯 아무 데나 누르면 앱이 열리도록 감쌀 최상위 뷰 id */
    protected int rootViewId() {
        return R.id.widget_root;
    }

    @Override
    public void onUpdate(Context ctx, AppWidgetManager mgr, int[] ids) {
        JSONObject data = WidgetData.load(ctx);
        for (int id : ids) {
            RemoteViews views = new RemoteViews(ctx.getPackageName(), layoutId());
            render(ctx, views, data);
            views.setOnClickPendingIntent(rootViewId(), openAppIntent(ctx));
            mgr.updateAppWidget(id, views);
        }
    }

    /** 위젯을 누르면 앱 본체를 연다. */
    protected PendingIntent openAppIntent(Context ctx) {
        Intent intent = new Intent(ctx, MainActivity.class);
        intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        return PendingIntent.getActivity(
            ctx, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
    }

    /** 데이터가 아직 한 번도 안 들어온 상태인지 (앱을 한 번도 안 켠 경우) */
    protected boolean isEmpty(JSONObject data) {
        return data == null || data.length() == 0;
    }
}
