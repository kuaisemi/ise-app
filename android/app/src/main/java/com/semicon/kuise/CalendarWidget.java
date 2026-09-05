package com.semicon.kuise;

import android.content.Context;
import android.view.View;
import android.widget.RemoteViews;

import org.json.JSONObject;

import java.util.Calendar;

/**
 * "달력" 위젯 — 이번 달 달력을 그리고, 일정이나 메모가 있는 날에 점을 찍는다.
 *
 * 달력 자체는 날짜 계산만 하면 되므로 앱 데이터 없이도 그릴 수 있다. 앱에서 받는 건
 * "표시할 날짜 목록"(markedDates)뿐이라, 앱을 안 켜도 달은 항상 맞게 넘어간다.
 */
public class CalendarWidget extends BaseWidget {

    private static final String[] WEEK_HEAD = { "일", "월", "화", "수", "목", "금", "토" };

    @Override
    protected int layoutId() {
        return R.layout.widget_calendar;
    }

    @Override
    protected String deepLinkTarget() {
        return "examCal"; // 학사정보 > 학사 달력 탭
    }

    @Override
    protected String widgetKey() {
        return "calendar";
    }

    @Override
    protected void render(Context ctx, RemoteViews views, JSONObject data, WidgetTheme theme) {
        Calendar cal = Calendar.getInstance();
        int year = cal.get(Calendar.YEAR);
        int month = cal.get(Calendar.MONTH);      // 0-based
        int today = cal.get(Calendar.DAY_OF_MONTH);

        views.setTextViewText(R.id.cal_month, (month + 1) + "월");
        theme.sub(views, R.id.cal_month);
        theme.size(views, R.id.cal_month, 11f);

        // "오늘 할 일" — 학사일정이 아니라 사용자가 직접 적은 오늘 메모만 보여준다 (설정에서 끌 수 있음).
        boolean showMemo = WidgetTheme.flag(data, widgetKey(), "calendarShowMemo", true);
        String memo = showMemo ? data.optString("memo", "") : "";
        boolean hasMemo = memo != null && !memo.trim().isEmpty();
        views.setViewVisibility(R.id.cal_memo_section, hasMemo ? View.VISIBLE : View.GONE);
        if (hasMemo) {
            views.setInt(R.id.cal_memo_divider, "setColorFilter", theme.divider);
            theme.accent(views, R.id.cal_memo_label);
            theme.sub(views, R.id.cal_memo_text);
            theme.size(views, R.id.cal_memo_label, 10.5f);
            theme.size(views, R.id.cal_memo_text, 10.5f);
            views.setTextViewText(R.id.cal_memo_text, memo.replaceAll("\\s*\\r?\\n\\s*", " · "));
        }

        drawMonthGrid(ctx, views, data, theme);
    }

    /**
     * 이번 달 달력(요일 머리글 + 날짜 칸)을 그린다.
     * 세로형(CalendarWidget)과 가로형(CalendarWideWidget)이 같은 id(cal_head/cal_rows)를 쓰므로
     * 두 위젯이 이 메서드를 함께 쓴다.
     */
    static void drawMonthGrid(Context ctx, RemoteViews views, JSONObject data, WidgetTheme theme) {
        Calendar cal = Calendar.getInstance();
        int year = cal.get(Calendar.YEAR);
        int month = cal.get(Calendar.MONTH);
        int today = cal.get(Calendar.DAY_OF_MONTH);

        // 일정/메모가 있는 날 — "YYYY-MM-DD" 문자열 배열
        JSONObject marked = data.optJSONObject("markedDates");

        // 요일 머리글
        views.removeAllViews(R.id.cal_head);
        for (int i = 0; i < 7; i++) {
            RemoteViews head = new RemoteViews(ctx.getPackageName(), R.layout.widget_cal_head);
            head.setTextViewText(R.id.head_text, WEEK_HEAD[i]);
            head.setTextColor(R.id.head_text, theme.textSub);
            theme.size(head, R.id.head_text, 9f);
            views.addView(R.id.cal_head, head);
        }

        Calendar first = Calendar.getInstance();
        first.set(year, month, 1);
        int startOffset = first.get(Calendar.DAY_OF_WEEK) - Calendar.SUNDAY; // 0=일
        int daysInMonth = first.getActualMaximum(Calendar.DAY_OF_MONTH);

        views.removeAllViews(R.id.cal_rows);
        int day = 1;
        int rows = (int) Math.ceil((startOffset + daysInMonth) / 7.0);
        for (int r = 0; r < rows; r++) {
            RemoteViews row = new RemoteViews(ctx.getPackageName(), R.layout.widget_cal_row);
            for (int c = 0; c < 7; c++) {
                RemoteViews cell = new RemoteViews(ctx.getPackageName(), R.layout.widget_cal_cell);
                int cellIndex = r * 7 + c;
                theme.size(cell, R.id.cell_day, 10f);
                if (cellIndex < startOffset || day > daysInMonth) {
                    cell.setTextViewText(R.id.cell_day, "");
                } else {
                    cell.setTextViewText(R.id.cell_day, String.valueOf(day));

                    boolean isToday = day == today;
                    if (isToday) {
                        cell.setViewVisibility(R.id.cell_ring, View.VISIBLE);
                        cell.setInt(R.id.cell_ring, "setColorFilter", theme.accent);
                        // 강조 원 위에 올라가는 글씨는 배경과 대비되게 고정색을 쓴다.
                        cell.setTextColor(R.id.cell_day, 0xFF14161F);
                    } else if (c == 0) {
                        cell.setTextColor(R.id.cell_day, 0xFFE05260); // 일요일
                    } else if (c == 6) {
                        cell.setTextColor(R.id.cell_day, 0xFF5B8DEF); // 토요일
                    } else {
                        cell.setTextColor(R.id.cell_day, theme.textPrimary);
                    }

                    String key = String.format("%04d-%02d-%02d", year, month + 1, day);
                    if (marked != null && marked.optBoolean(key, false)) {
                        cell.setViewVisibility(R.id.cell_dot, View.VISIBLE);
                        cell.setInt(R.id.cell_dot, "setColorFilter", isToday ? theme.textSub : theme.accent);
                    }
                    day++;
                }
                row.addView(R.id.cal_row, cell);
            }
            views.addView(R.id.cal_rows, row);
        }
    }
}
