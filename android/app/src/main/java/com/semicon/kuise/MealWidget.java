package com.semicon.kuise;

import android.content.Context;
import android.view.View;
import android.widget.RemoteViews;

import org.json.JSONObject;

import java.util.Calendar;

/**
 * "오늘의 학식" 위젯 — 진리관 학생식당 식단을 시간대에 맞춰 보여준다.
 *
 * 조식/중식/석식 중 무엇을 보여줄지는 앱 홈 화면과 같은 규칙을 쓴다
 * (조식 21시~09시 / 중식 09시~14시 / 석식 14시~21시). 시간이 지나면 바뀌어야 하므로
 * 앱이 넣어준 세 끼 데이터를 모두 갖고 있다가 위젯이 그릴 때 골라 쓴다.
 */
public class MealWidget extends BaseWidget {

    @Override
    protected int layoutId() {
        return R.layout.widget_meal;
    }

    @Override
    protected void render(Context ctx, RemoteViews views, JSONObject data, WidgetTheme theme) {
        views.setInt(R.id.meal_accent, "setColorFilter", theme.accent);
        theme.title(views, R.id.meal_label);
        theme.body(views, R.id.meal_text);
        theme.sub(views, R.id.meal_empty);

        Calendar now = Calendar.getInstance();
        int minutesNow = now.get(Calendar.HOUR_OF_DAY) * 60 + now.get(Calendar.MINUTE);

        String slotKey;
        String slotLabel;
        boolean tomorrow = false;
        if (minutesNow >= 9 * 60 && minutesNow < 14 * 60) {
            slotKey = "lunch";
            slotLabel = "중식";
        } else if (minutesNow >= 14 * 60 && minutesNow < 21 * 60) {
            slotKey = "dinner";
            slotLabel = "석식";
        } else {
            slotKey = "breakfast";
            slotLabel = "조식";
            tomorrow = minutesNow >= 21 * 60; // 21시 넘으면 "내일 조식"을 봐야 한다
        }

        views.setTextViewText(R.id.meal_label, "진리관 " + slotLabel);

        // meals: { today: {breakfast, lunch, dinner}, tomorrow: {...} }
        JSONObject meals = data.optJSONObject("meals");
        String text = "";
        if (meals != null) {
            JSONObject day = meals.optJSONObject(tomorrow ? "tomorrow" : "today");
            if (day != null) text = day.optString(slotKey, "");
        }

        if (text == null || text.trim().isEmpty()) {
            views.setViewVisibility(R.id.meal_text, View.GONE);
            views.setViewVisibility(R.id.meal_empty, View.VISIBLE);
            views.setTextViewText(R.id.meal_empty,
                isEmpty(data) ? "앱을 한 번 실행해주세요" : slotLabel + " 정보가 없어요");
        } else {
            views.setViewVisibility(R.id.meal_text, View.VISIBLE);
            views.setViewVisibility(R.id.meal_empty, View.GONE);
            // 앱에 저장된 메뉴는 줄바꿈으로 구분돼 있어 위젯에서는 가운뎃점으로 이어 붙인다.
            views.setTextViewText(R.id.meal_text, text.replaceAll("\\s*\\r?\\n\\s*", " · "));
        }
    }
}
