package com.semicon.kuise;

import android.content.Context;
import android.view.View;
import android.widget.RemoteViews;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.Calendar;

/**
 * "주간 시간표" 위젯 — 월~금 다섯 칸에 그 주 수업을 전부 보여준다.
 *
 * 요일마다 수업 개수가 달라서 고정 행으로는 못 그리는데, RemoteViews는 실행 중에
 * removeAllViews + addView로 자식을 붙일 수 있어서 그 방식으로 채운다.
 */
public class WeekWidget extends BaseWidget {

    private static final String[] DAY_LABELS = { "월", "화", "수", "목", "금" };

    @Override
    protected int layoutId() {
        return R.layout.widget_week;
    }

    @Override
    protected String widgetKey() {
        return "week";
    }

    @Override
    protected void render(Context ctx, RemoteViews views, JSONObject data, WidgetTheme theme) {
        views.setTextViewText(R.id.widget_sem, data.optString("semester", ""));
        theme.sub(views, R.id.widget_sem);
        theme.sub(views, R.id.week_empty);
        theme.size(views, R.id.widget_sem, 11f);
        theme.size(views, R.id.week_empty, 12f);

        // weekClasses: [[월 수업들], [화], [수], [목], [금]]
        JSONArray week = data.optJSONArray("weekClasses");
        JSONArray weekDates = data.optJSONArray("weekDates"); // ["8","9","10","11","12"]
        int total = 0;
        if (week != null) {
            for (int d = 0; d < week.length(); d++) {
                JSONArray day = week.optJSONArray(d);
                if (day != null) total += day.length();
            }
        }

        views.setViewVisibility(R.id.week_empty, total == 0 ? View.VISIBLE : View.GONE);
        views.setViewVisibility(R.id.week_cols, total == 0 ? View.GONE : View.VISIBLE);
        if (total == 0) {
            views.setTextViewText(R.id.week_empty,
                isEmpty(data) ? "앱을 한 번 실행하면 시간표가 표시돼요" : "등록된 수업이 없어요");
            return;
        }

        // 오늘이 평일이면 그 요일 머리글을 강조한다.
        int todayIdx = Calendar.getInstance().get(Calendar.DAY_OF_WEEK) - Calendar.MONDAY;
        if (todayIdx < 0 || todayIdx > 4) todayIdx = -1;

        views.removeAllViews(R.id.week_cols);
        for (int d = 0; d < 5; d++) {
            RemoteViews col = new RemoteViews(ctx.getPackageName(), R.layout.widget_week_col);
            boolean isToday = d == todayIdx;
            col.setTextViewText(R.id.col_day, DAY_LABELS[d]);
            col.setTextColor(R.id.col_day, isToday ? theme.accent : theme.textSub);
            theme.size(col, R.id.col_day, 10f);
            col.setTextViewText(R.id.col_date, weekDates == null ? "" : weekDates.optString(d, ""));
            col.setTextColor(R.id.col_date, isToday ? theme.accent : theme.textSub);
            theme.size(col, R.id.col_date, 9f);

            JSONArray day = week == null ? null : week.optJSONArray(d);
            if (day == null || day.length() == 0) {
                // 수업이 없는 요일도 칸 높이가 맞게 빈 자리를 하나 넣어 다른 요일과 시각적으로 나란히 보이게 한다.
                RemoteViews placeholder = new RemoteViews(ctx.getPackageName(), R.layout.widget_week_empty_slot);
                theme.sub(placeholder, R.id.week_empty_dash);
                col.addView(R.id.col_items, placeholder);
            } else {
                for (int i = 0; i < day.length(); i++) {
                    JSONObject c = day.optJSONObject(i);
                    if (c == null) continue;
                    RemoteViews chip = new RemoteViews(ctx.getPackageName(), R.layout.widget_week_chip);
                    chip.setTextViewText(R.id.chip_subject, c.optString("subject", ""));
                    chip.setTextViewText(R.id.chip_time, c.optString("startLabel", ""));
                    theme.size(chip, R.id.chip_subject, 10f);
                    theme.size(chip, R.id.chip_time, 8.5f);
                    chip.setInt(R.id.chip_bg, "setColorFilter",
                        TimetableWidget.parseColor(c.optString("color", ""), theme.accent));
                    col.addView(R.id.col_items, chip);
                }
            }
            views.addView(R.id.week_cols, col);
        }
    }
}
