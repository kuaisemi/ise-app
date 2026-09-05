package com.semicon.kuise;

import android.content.Context;
import android.os.Build;
import android.util.TypedValue;
import android.view.View;
import android.widget.RemoteViews;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.Calendar;

/**
 * "주간 시간표" 위젯 — 앱 안의 시간표 화면처럼 왼쪽에 시간축을 두고, 수업을 실제 시각 위치에
 * 실제 길이만큼의 높이로 놓는다 (9시 수업은 위, 3시 수업은 아래, 두 시간짜리는 두 배 높이).
 *
 * 위젯은 자기 높이를 XML로 정할 수 없어서, 홈 화면에서 차지한 크기(widgetHeightDp)를 받아
 * "1분당 몇 dp"를 계산한 뒤 칸 높이를 코드로 지정한다. 이때 쓰는 setViewLayoutHeight는
 * 안드로이드 12(API 31)부터라, 그 아래 버전에서는 예전처럼 수업을 순서대로 쌓아서 보여준다.
 */
public class WeekWidget extends BaseWidget {

    private static final String[] DAY_LABELS = { "월", "화", "수", "목", "금" };

    /** 수업이 하나도 없을 때 기본으로 보여줄 시간대 */
    private static final int DEFAULT_START_HOUR = 9;
    private static final int DEFAULT_END_HOUR = 18;
    /** 시간 칸이 이보다 낮으면 과목명만 넣는다 (시간 줄까지 넣으면 글씨가 잘린다) */
    private static final float TIME_LINE_MIN_DP = 34f;
    /** 한 시간에 이만큼도 못 주는 크기면 시간축 격자를 포기하고 목록으로 보여준다 */
    private static final float HOUR_MIN_DP = 16f;

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

        // weekClasses: [[월 수업들], [화], [수], [목], [금]], 각 수업은 start/end(분 단위)를 갖는다
        JSONArray week = data.optJSONArray("weekClasses");
        int total = 0;
        int minStart = Integer.MAX_VALUE, maxEnd = Integer.MIN_VALUE;
        if (week != null) {
            for (int d = 0; d < week.length(); d++) {
                JSONArray day = week.optJSONArray(d);
                if (day == null) continue;
                total += day.length();
                for (int i = 0; i < day.length(); i++) {
                    JSONObject c = day.optJSONObject(i);
                    if (c == null) continue;
                    int s = c.optInt("start", -1), e = c.optInt("end", -1);
                    if (s >= 0 && s < minStart) minStart = s;
                    if (e >= 0 && e > maxEnd) maxEnd = e;
                }
            }
        }

        boolean has = total > 0;
        views.setViewVisibility(R.id.week_empty, has ? View.GONE : View.VISIBLE);
        views.setViewVisibility(R.id.week_cols, has ? View.VISIBLE : View.GONE);
        if (!has) {
            views.setTextViewText(R.id.week_empty,
                isEmpty(data) ? "앱을 한 번 실행하면 시간표가 표시돼요" : "등록된 수업이 없어요");
            return;
        }

        boolean showFullDay = WidgetTheme.flag(data, widgetKey(), "weekShowFullDay", false);
        boolean showRoom = WidgetTheme.flag(data, widgetKey(), "weekShowRoom", false);

        // 보여줄 시간 범위 — 기본은 수업이 있는 구간만 정각 단위로 잘라 쓴다(빈 새벽/밤을 안 띄우려고).
        // "시간 전체 표시"를 켜면 9~18시를 기본으로 깔되, 그 밖에 수업이 있으면 그만큼 더 넓힌다.
        int startHour = minStart == Integer.MAX_VALUE ? DEFAULT_START_HOUR : minStart / 60;
        int endHour = maxEnd == Integer.MIN_VALUE ? DEFAULT_END_HOUR : (maxEnd + 59) / 60;
        if (showFullDay) {
            startHour = Math.min(startHour, DEFAULT_START_HOUR);
            endHour = Math.max(endHour, DEFAULT_END_HOUR);
        }
        if (endHour <= startHour) endHour = startHour + 1;
        int startMin = startHour * 60;
        int totalMin = (endHour - startHour) * 60;

        // 제목 줄·요일 머리글·여백으로 빠지는 높이를 뺀 나머지를 시간 길이로 나눠 "1분당 dp"를 구한다.
        // (여백 28 + 제목 아래 10 + 요일 아래 4) + 글씨 배율을 탄 제목/요일 줄 높이
        int chromeDp = Math.round(42 + 31 * theme.fontScale);
        int availDp = widgetHeightDp > 0 ? widgetHeightDp - chromeDp : (endHour - startHour) * 26;
        if (availDp < 60) availDp = 60;
        float dpPerMin = availDp / (float) totalMin;

        // 시간축 격자로 그릴 수 있는 조건 — 높이 지정이 되는 안드로이드 12 이상이고(setViewLayoutHeight),
        // 위젯이 한 시간마다 최소한의 높이는 줄 만큼 큰 경우. 아니면 예전처럼 수업을 차례로 쌓는다.
        boolean canSize = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
            && dpPerMin * 60 >= HOUR_MIN_DP * theme.fontScale;

        // 오늘이 평일이면 그 요일 머리글을 강조색으로.
        int todayIdx = Calendar.getInstance().get(Calendar.DAY_OF_WEEK) - Calendar.MONDAY;
        if (todayIdx < 0 || todayIdx > 4) todayIdx = -1;

        views.removeAllViews(R.id.week_cols);

        // 맨 왼쪽 시간축 (9, 10, 11 …). 요일 열과 머리글 구조가 같아야 눈금 높이가 안 어긋난다.
        if (canSize) {
            RemoteViews timeCol = new RemoteViews(ctx.getPackageName(), R.layout.widget_week_timecol);
            timeCol.setTextViewText(R.id.time_head, "");
            theme.size(timeCol, R.id.time_head, 10f);
            for (int h = startHour; h < endHour; h++) {
                RemoteViews hour = new RemoteViews(ctx.getPackageName(), R.layout.widget_week_hour);
                hour.setTextViewText(R.id.hour_text, String.valueOf(h));
                hour.setTextColor(R.id.hour_text, theme.textSub);
                theme.size(hour, R.id.hour_text, 8f);
                hour.setViewLayoutHeight(R.id.hour_text, 60 * dpPerMin, TypedValue.COMPLEX_UNIT_DIP);
                timeCol.addView(R.id.time_items, hour);
            }
            views.addView(R.id.week_cols, timeCol);
        }

        for (int d = 0; d < 5; d++) {
            RemoteViews col = new RemoteViews(ctx.getPackageName(), R.layout.widget_week_col);
            col.setTextViewText(R.id.col_day, DAY_LABELS[d]);
            col.setTextColor(R.id.col_day, d == todayIdx ? theme.accent : theme.textSub);
            theme.size(col, R.id.col_day, 10f);

            JSONArray day = week.optJSONArray(d);
            int cursor = startMin; // 이 요일에서 지금까지 채운 시각
            if (day != null) {
                for (int i = 0; i < day.length(); i++) {
                    JSONObject c = day.optJSONObject(i);
                    if (c == null) continue;
                    int s = c.optInt("start", cursor);
                    int e = c.optInt("end", s + 60);
                    if (s < cursor) s = cursor;   // 겹치는 수업은 앞 수업 뒤로 밀어 그린다
                    if (e <= s) e = s + 60;

                    // 앞 수업이 끝난 시각부터 이 수업 시작까지의 빈 시간만큼 여백을 넣는다
                    if (canSize && s > cursor) {
                        RemoteViews gap = new RemoteViews(ctx.getPackageName(), R.layout.widget_week_gap);
                        gap.setViewLayoutHeight(R.id.gap_root, (s - cursor) * dpPerMin, TypedValue.COMPLEX_UNIT_DIP);
                        col.addView(R.id.col_items, gap);
                    }

                    float blockDp = (e - s) * dpPerMin;
                    RemoteViews chip = new RemoteViews(ctx.getPackageName(), R.layout.widget_week_chip);
                    chip.setTextViewText(R.id.chip_subject, c.optString("subject", ""));
                    theme.size(chip, R.id.chip_subject, 9.5f);
                    if (!canSize || blockDp >= TIME_LINE_MIN_DP * theme.fontScale) {
                        // 밑줄 한 줄은 강의실 표시가 켜져 있으면 강의실을, 아니면 시작 시각을 보여준다
                        // (둘을 한 줄에 욱여넣으면 좁은 칸에서 잘려서 둘 다 따로 고를 수 있게 함).
                        String room = c.optString("room", "");
                        String line = (showRoom && !room.isEmpty()) ? room : c.optString("startLabel", "");
                        chip.setViewVisibility(R.id.chip_time, View.VISIBLE);
                        chip.setTextViewText(R.id.chip_time, line);
                        theme.size(chip, R.id.chip_time, 8f);
                    } else {
                        chip.setViewVisibility(R.id.chip_time, View.GONE);
                    }
                    chip.setInt(R.id.chip_bg, "setColorFilter",
                        TimetableWidget.parseColor(c.optString("color", ""), theme.accent));
                    if (canSize) {
                        chip.setViewLayoutHeight(R.id.chip_root, blockDp, TypedValue.COMPLEX_UNIT_DIP);
                    }
                    col.addView(R.id.col_items, chip);
                    cursor = e;
                }
            }
            views.addView(R.id.week_cols, col);
        }
    }
}
