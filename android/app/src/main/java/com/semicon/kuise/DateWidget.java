package com.semicon.kuise;

import android.content.Context;
import android.view.View;
import android.widget.RemoteViews;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * "오늘 날짜" 위젯 — 작을 땐 날짜만, 세로로 늘리면 오늘 학사일정 요약까지 보여준다.
 *
 * 이 위젯만은 제목 줄이 없어서 BaseWidget의 공통 헤더 적용(위젯 제목 텍스트/강조 막대)이
 * 아무 효과가 없다 — 레이아웃에 해당 id가 없으면 RemoteViews가 조용히 무시하므로 안전하다.
 */
public class DateWidget extends BaseWidget {

    @Override
    protected int layoutId() {
        return R.layout.widget_date;
    }

    @Override
    protected String widgetKey() {
        return "date";
    }

    @Override
    protected void render(Context ctx, RemoteViews views, JSONObject data, WidgetTheme theme) {
        views.setTextViewText(R.id.date_weekday, data.optString("todayWeekday", "") + "요일");
        views.setTextViewText(R.id.date_day, data.optString("todayDay", ""));
        theme.accent(views, R.id.date_weekday);
        theme.title(views, R.id.date_day);
        theme.size(views, R.id.date_weekday, 12f);
        theme.size(views, R.id.date_day, 32f);

        boolean showEvents = WidgetTheme.flag(data, widgetKey(), "dateShowEvents", true);

        JSONArray eventsRaw = showEvents ? data.optJSONArray("todayEvents") : null;
        String t0 = "", t1 = "";
        int count = 0;
        if (eventsRaw != null) {
            for (int i = 0; i < eventsRaw.length() && count < 2; i++) {
                JSONObject ev = eventsRaw.optJSONObject(i);
                String title = ev == null ? "" : ev.optString("title", "");
                if (title.isEmpty()) continue;
                if (count == 0) t0 = title; else t1 = title;
                count++;
            }
        }

        views.setViewVisibility(R.id.date_events, count > 0 ? View.VISIBLE : View.GONE);
        if (count > 0) {
            views.setTextViewText(R.id.date_event_0, "· " + t0);
            theme.sub(views, R.id.date_event_0);
            theme.size(views, R.id.date_event_0, 11f);
        }
        views.setViewVisibility(R.id.date_event_1, count > 1 ? View.VISIBLE : View.GONE);
        if (count > 1) {
            views.setTextViewText(R.id.date_event_1, "· " + t1);
            theme.sub(views, R.id.date_event_1);
            theme.size(views, R.id.date_event_1, 11f);
        }
    }
}
