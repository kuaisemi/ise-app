package com.semicon.kuise;

import android.content.Context;
import android.view.View;
import android.widget.RemoteViews;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * "일정 · 메모" 위젯 — 다가오는 학사일정과 오늘 적어둔 개인 메모를 함께 보여준다.
 *
 * 달력 자체를 위젯에 그리는 것도 가능하지만, 홈 화면에서 실제로 궁금한 건
 * "앞으로 뭐가 있더라 / 오늘 할 일이 뭐더라"라서 그 두 가지만 추린다.
 */
public class ScheduleWidget extends BaseWidget {

    private static final int MAX_ROWS = 3;

    private static final int[] ROW_IDS = { R.id.ev_row_0, R.id.ev_row_1, R.id.ev_row_2 };
    private static final int[] TITLE_IDS = { R.id.ev_title_0, R.id.ev_title_1, R.id.ev_title_2 };
    private static final int[] DATE_IDS = { R.id.ev_date_0, R.id.ev_date_1, R.id.ev_date_2 };

    @Override
    protected int layoutId() {
        return R.layout.widget_schedule;
    }

    @Override
    protected void render(Context ctx, RemoteViews views, JSONObject data) {
        JSONArray events = data.optJSONArray("events");
        int count = events == null ? 0 : Math.min(events.length(), MAX_ROWS);

        for (int i = 0; i < MAX_ROWS; i++) {
            if (i < count) {
                JSONObject ev = events.optJSONObject(i);
                if (ev == null) {
                    views.setViewVisibility(ROW_IDS[i], View.GONE);
                    continue;
                }
                views.setViewVisibility(ROW_IDS[i], View.VISIBLE);
                views.setTextViewText(TITLE_IDS[i], ev.optString("title", ""));
                views.setTextViewText(DATE_IDS[i], ev.optString("date", ""));
            } else {
                views.setViewVisibility(ROW_IDS[i], View.GONE);
            }
        }

        views.setViewVisibility(R.id.ev_empty, count == 0 ? View.VISIBLE : View.GONE);
        if (count == 0) {
            views.setTextViewText(R.id.ev_empty,
                isEmpty(data) ? "앱을 한 번 실행해주세요" : "다가오는 일정이 없어요");
        }

        // 오늘 메모는 있을 때만 아래에 붙인다.
        String memo = data.optString("memo", "");
        if (memo == null || memo.trim().isEmpty()) {
            views.setViewVisibility(R.id.memo_section, View.GONE);
        } else {
            views.setViewVisibility(R.id.memo_section, View.VISIBLE);
            views.setTextViewText(R.id.memo_text, memo.replaceAll("\\s*\\r?\\n\\s*", " · "));
        }
    }
}
