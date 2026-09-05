package com.semicon.kuise;

import android.content.Context;
import android.view.View;
import android.widget.RemoteViews;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * "달력 (가로형)" 위젯 — 삼성 기본 캘린더 위젯처럼 왼쪽에 이번 달 달력, 오른쪽에 오늘 일정을
 * 나란히 보여준다. 달력 그리기는 세로형과 완전히 같아서 CalendarWidget의 것을 그대로 쓴다.
 */
public class CalendarWideWidget extends BaseWidget {

    private static final int[] EV_IDS = { R.id.wide_ev_0, R.id.wide_ev_1, R.id.wide_ev_2 };

    @Override
    protected int layoutId() {
        return R.layout.widget_calendar_wide;
    }

    @Override
    protected String widgetKey() {
        return "calendarWide";
    }

    @Override
    protected String deepLinkTarget() {
        return "examCal"; // 학사정보 > 학사 달력 탭
    }

    @Override
    protected void render(Context ctx, RemoteViews views, JSONObject data, WidgetTheme theme) {
        CalendarWidget.drawMonthGrid(ctx, views, data, theme);
        views.setInt(R.id.wide_divider, "setColorFilter", theme.divider);

        views.setTextViewText(R.id.wide_today, data.optString("todayLabel", ""));
        theme.title(views, R.id.wide_today);
        theme.size(views, R.id.wide_today, 13f);

        // 오늘 걸쳐 있는 일정 (없으면 "오늘 일정이 없습니다")
        JSONArray todayEvents = data.optJSONArray("todayEvents");
        int count = todayEvents == null ? 0 : Math.min(todayEvents.length(), EV_IDS.length);
        for (int i = 0; i < EV_IDS.length; i++) {
            if (i < count) {
                views.setViewVisibility(EV_IDS[i], View.VISIBLE);
                views.setTextViewText(EV_IDS[i], "· " + todayEvents.optString(i, ""));
                theme.body(views, EV_IDS[i]);
                theme.size(views, EV_IDS[i], 11.5f);
            } else {
                views.setViewVisibility(EV_IDS[i], View.GONE);
            }
        }
        views.setViewVisibility(R.id.wide_empty, count == 0 ? View.VISIBLE : View.GONE);
        if (count == 0) {
            views.setTextViewText(R.id.wide_empty,
                isEmpty(data) ? "앱을 한 번 실행해주세요" : "오늘 일정이 없습니다");
            theme.sub(views, R.id.wide_empty);
            theme.size(views, R.id.wide_empty, 11f);
        }

        // 오늘 내가 적어둔 메모 (설정에서 끌 수 있음 — 세로형 달력과 같은 스위치를 쓴다)
        boolean showMemo = WidgetTheme.flag(data, widgetKey(), "calendarShowMemo", true);
        String memo = showMemo ? data.optString("memo", "") : "";
        boolean hasMemo = memo != null && !memo.trim().isEmpty();
        views.setViewVisibility(R.id.wide_memo, hasMemo ? View.VISIBLE : View.GONE);
        if (hasMemo) {
            views.setTextViewText(R.id.wide_memo, "메모 · " + memo.replaceAll("\\s*\\r?\\n\\s*", " · "));
            theme.accent(views, R.id.wide_memo);
            theme.size(views, R.id.wide_memo, 11f);
        }
    }
}
