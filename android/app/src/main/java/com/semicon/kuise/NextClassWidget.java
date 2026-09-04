package com.semicon.kuise;

import android.content.Context;
import android.view.View;
import android.widget.RemoteViews;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.Calendar;

/**
 * "다음 수업" 위젯 — 지금 시각 기준으로 진행 중이거나 다음에 올 수업 하나만 크게 보여준다.
 *
 * 어떤 수업이 "다음"인지는 시간이 흐르면 계속 바뀌므로, 앱이 데이터를 새로 넣어주기를
 * 기다리지 않고 위젯이 그릴 때마다 현재 시각으로 직접 고른다.
 */
public class NextClassWidget extends BaseWidget {

    @Override
    protected int layoutId() {
        return R.layout.widget_next_class;
    }

    @Override
    protected void render(Context ctx, RemoteViews views, JSONObject data) {
        JSONArray classes = data.optJSONArray("classes");

        Calendar now = Calendar.getInstance();
        int minutesNow = now.get(Calendar.HOUR_OF_DAY) * 60 + now.get(Calendar.MINUTE);

        JSONObject current = null;  // 지금 진행 중인 수업
        JSONObject next = null;     // 아직 시작 안 한 수업 중 가장 빠른 것

        if (classes != null) {
            for (int i = 0; i < classes.length(); i++) {
                JSONObject c = classes.optJSONObject(i);
                if (c == null) continue;
                int start = c.optInt("start", -1);
                int end = c.optInt("end", -1);
                if (start < 0 || end < 0) continue;

                if (minutesNow >= start && minutesNow < end) {
                    current = c;
                    break;
                }
                if (start > minutesNow && (next == null || start < next.optInt("start", 99999))) {
                    next = c;
                }
            }
        }

        JSONObject target = current != null ? current : next;

        if (target == null) {
            views.setViewVisibility(R.id.next_body, View.GONE);
            views.setViewVisibility(R.id.next_empty, View.VISIBLE);
            views.setTextViewText(R.id.next_empty,
                isEmpty(data) ? "앱을 한 번 실행해주세요" : "오늘 남은 수업이 없어요");
            views.setTextViewText(R.id.next_label, "다음 수업");
            return;
        }

        views.setViewVisibility(R.id.next_body, View.VISIBLE);
        views.setViewVisibility(R.id.next_empty, View.GONE);

        if (current != null) {
            int leftMin = current.optInt("end", 0) - minutesNow;
            views.setTextViewText(R.id.next_label, "수업 중 · " + leftMin + "분 남음");
        } else {
            int untilMin = target.optInt("start", 0) - minutesNow;
            String until = untilMin >= 60
                ? (untilMin / 60) + "시간 " + (untilMin % 60) + "분 후"
                : untilMin + "분 후";
            views.setTextViewText(R.id.next_label, "다음 수업 · " + until);
        }

        views.setTextViewText(R.id.next_subject, target.optString("subject", ""));

        String time = target.optString("time", "");
        String room = target.optString("room", "");
        views.setTextViewText(R.id.next_meta, room.isEmpty() ? time : time + "  ·  " + room);

        views.setInt(R.id.next_bar, "setBackgroundColor",
            TimetableWidget.parseColor(target.optString("color", ""), 0xFF3DDC97));
    }
}
