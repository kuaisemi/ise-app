package com.semicon.kuise;

import android.content.Context;
import android.graphics.Color;
import android.view.View;
import android.widget.RemoteViews;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * "오늘의 시간표" 위젯 — 그날 수업을 최대 5개까지 보여준다.
 *
 * 위젯에서 목록을 그리려면 보통 RemoteViewsService가 필요한데, 하루 수업은 많아야
 * 대여섯 개라 고정된 행 5개를 만들어 두고 필요한 만큼만 보이게 하는 쪽이 훨씬 가볍다.
 */
public class TimetableWidget extends BaseWidget {

    private static final int MAX_ROWS = 5;

    private static final int[] ROW_IDS = {
        R.id.row_0, R.id.row_1, R.id.row_2, R.id.row_3, R.id.row_4
    };
    private static final int[] BAR_IDS = {
        R.id.bar_0, R.id.bar_1, R.id.bar_2, R.id.bar_3, R.id.bar_4
    };
    private static final int[] SUBJECT_IDS = {
        R.id.subject_0, R.id.subject_1, R.id.subject_2, R.id.subject_3, R.id.subject_4
    };
    private static final int[] META_IDS = {
        R.id.meta_0, R.id.meta_1, R.id.meta_2, R.id.meta_3, R.id.meta_4
    };

    @Override
    protected int layoutId() {
        return R.layout.widget_timetable;
    }

    @Override
    protected String widgetKey() {
        return "timetable";
    }

    @Override
    protected void render(Context ctx, RemoteViews views, JSONObject data, WidgetTheme theme) {
        views.setTextViewText(R.id.widget_date, data.optString("todayLabel", ""));
        theme.sub(views, R.id.widget_date);
        theme.sub(views, R.id.widget_empty);
        theme.sub(views, R.id.widget_more);
        theme.size(views, R.id.widget_date, 11f);
        theme.size(views, R.id.widget_empty, 12f);
        theme.size(views, R.id.widget_more, 10f);

        JSONArray classes = data.optJSONArray("classes");
        int count = classes == null ? 0 : Math.min(classes.length(), MAX_ROWS);

        if (isEmpty(data)) {
            views.setTextViewText(R.id.widget_empty, "앱을 한 번 실행하면 시간표가 표시돼요");
        } else if (count == 0) {
            views.setTextViewText(R.id.widget_empty, "오늘은 수업이 없어요");
        }
        views.setViewVisibility(R.id.widget_empty, count == 0 ? View.VISIBLE : View.GONE);

        for (int i = 0; i < MAX_ROWS; i++) {
            if (i < count) {
                JSONObject c = classes.optJSONObject(i);
                if (c == null) {
                    views.setViewVisibility(ROW_IDS[i], View.GONE);
                    continue;
                }
                views.setViewVisibility(ROW_IDS[i], View.VISIBLE);
                views.setTextViewText(SUBJECT_IDS[i], c.optString("subject", ""));
                theme.body(views, SUBJECT_IDS[i]);
                theme.size(views, SUBJECT_IDS[i], 13f);

                String time = c.optString("time", "");
                String room = c.optString("room", "");
                views.setTextViewText(META_IDS[i], room.isEmpty() ? time : time + "  ·  " + room);
                theme.sub(views, META_IDS[i]);
                theme.size(views, META_IDS[i], 11f);

                views.setInt(BAR_IDS[i], "setColorFilter", parseColor(c.optString("color", ""), theme.accent));
            } else {
                views.setViewVisibility(ROW_IDS[i], View.GONE);
            }
        }

        // 5개를 넘으면 아래에 몇 개 더 있는지만 알려준다.
        int total = classes == null ? 0 : classes.length();
        if (total > MAX_ROWS) {
            views.setViewVisibility(R.id.widget_more, View.VISIBLE);
            views.setTextViewText(R.id.widget_more, "+ " + (total - MAX_ROWS) + "개 더");
        } else {
            views.setViewVisibility(R.id.widget_more, View.GONE);
        }
    }

    /** 웹에서 넘어온 "#RRGGBB" 문자열을 색으로 바꾼다. 이상하면 기본색을 쓴다. */
    static int parseColor(String hex, int fallback) {
        if (hex == null || hex.isEmpty()) return fallback;
        try {
            return Color.parseColor(hex);
        } catch (IllegalArgumentException e) {
            return fallback;
        }
    }
}
