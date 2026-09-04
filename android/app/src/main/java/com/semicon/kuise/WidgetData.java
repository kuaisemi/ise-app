package com.semicon.kuise;

import android.appwidget.AppWidgetManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.Intent;

import org.json.JSONException;
import org.json.JSONObject;

/**
 * 위젯이 그릴 데이터를 담아두는 공용 저장소.
 *
 * 웹뷰(=앱 본체)는 Firestore/localStorage에 데이터를 갖고 있지만, 홈 화면 위젯은
 * 앱과 다른 프로세스에서 잠깐 깨어나 그림만 그리는 구조라 웹 데이터에 접근할 수 없다.
 * 그래서 앱이 켜질 때마다 웹에서 필요한 값만 JSON으로 만들어 SharedPreferences에 넣어두고,
 * 위젯은 그걸 읽어서 그린다. (WidgetBridgePlugin이 저장 담당)
 */
public class WidgetData {

    private static final String PREFS = "ise_widget";
    private static final String KEY_PAYLOAD = "payload";

    public static SharedPreferences prefs(Context ctx) {
        return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    public static void save(Context ctx, String json) {
        prefs(ctx).edit().putString(KEY_PAYLOAD, json).apply();
    }

    /** 저장된 값이 없거나 깨져 있으면 빈 JSON을 돌려줘서 위젯이 죽지 않게 한다. */
    public static JSONObject load(Context ctx) {
        String raw = prefs(ctx).getString(KEY_PAYLOAD, null);
        if (raw == null) return new JSONObject();
        try {
            return new JSONObject(raw);
        } catch (JSONException e) {
            return new JSONObject();
        }
    }

    /** 앱에서 데이터가 바뀌었을 때 홈 화면에 놓인 위젯 전부를 다시 그리게 한다. */
    public static void refreshAll(Context ctx) {
        Class<?>[] providers = {
            TimetableWidget.class,
            NextClassWidget.class,
            MealWidget.class,
            ScheduleWidget.class,
        };
        AppWidgetManager mgr = AppWidgetManager.getInstance(ctx);
        for (Class<?> provider : providers) {
            ComponentName cn = new ComponentName(ctx, provider);
            int[] ids = mgr.getAppWidgetIds(cn);
            if (ids == null || ids.length == 0) continue;
            Intent intent = new Intent(ctx, provider);
            intent.setAction(AppWidgetManager.ACTION_APPWIDGET_UPDATE);
            intent.putExtra(AppWidgetManager.EXTRA_APPWIDGET_IDS, ids);
            ctx.sendBroadcast(intent);
        }
    }
}
