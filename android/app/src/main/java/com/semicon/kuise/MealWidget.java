package com.semicon.kuise;

import android.content.Context;
import android.text.SpannableStringBuilder;
import android.text.Spanned;
import android.text.style.ForegroundColorSpan;
import android.view.View;
import android.widget.RemoteViews;

import org.json.JSONObject;

import java.util.Calendar;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * "오늘의 학식" 위젯 — 진리관(학생식당)·미래관(교직원식당, 중식만) 식단을 시간대에 맞춰 보여준다.
 *
 * 조식/중식/석식 중 무엇을 보여줄지는 앱 홈 화면과 같은 규칙을 쓴다
 * (조식 21시~09시 / 중식 09시~14시 / 석식 14시~21시). 시간이 지나면 바뀌어야 하므로
 * 앱이 넣어준 세 끼 데이터를 모두 갖고 있다가 위젯이 그릴 때 골라 쓴다.
 */
public class MealWidget extends BaseWidget {

    // "[일품] 돈까스" 처럼 앞에 붙은 카테고리 태그.
    private static final Pattern CAT_PATTERN = Pattern.compile("^\\[([^\\]]+)]\\s*(.*)$");

    // 한식/일품/분식 [태그] 색. 서로 헷갈리지 않게 초록/파랑/주황으로 확실히 구분한다.
    // plus는 홈 화면 미리보기와 마찬가지로 위젯에서도 아예 숨긴다(코너 메뉴라 매번 안 바뀌고
    // 자리만 차지해서).
    private static final int COLOR_HANSIK = 0xFF4CC98A;
    private static final int COLOR_ILPUM = 0xFF6FA3F5;
    private static final int COLOR_BUNSIK = 0xFFFF8A5C;

    @Override
    protected int layoutId() {
        return R.layout.widget_meal;
    }

    @Override
    protected String widgetKey() {
        return "meal";
    }

    @Override
    protected String deepLinkTarget() {
        return "meal";
    }

    private static int categoryColor(String cat) {
        if (cat.contains("한식")) return COLOR_HANSIK;
        if (cat.contains("일품")) return COLOR_ILPUM;
        if (cat.contains("분식")) return COLOR_BUNSIK;
        return 0;
    }

    /**
     * 한식/일품/분식을 줄바꿈으로 나누고, [태그] 글자에만 색을 입힌다(메뉴 이름 자체는 그대로
     * 기본 색). plus 항목은 통째로 뺀다.
     */
    private static CharSequence buildMealText(String raw) {
        SpannableStringBuilder sb = new SpannableStringBuilder();
        String[] lines = raw.split("\\r?\\n");
        boolean first = true;
        for (String rawLine : lines) {
            String line = rawLine.trim();
            if (line.isEmpty()) continue;
            Matcher m = CAT_PATTERN.matcher(line);
            if (m.matches() && m.group(1).toLowerCase().contains("plus")) continue; // PLUS 메뉴는 숨김

            if (!first) sb.append("\n");
            first = false;
            if (m.matches()) {
                String cat = m.group(1).trim();
                String rest = m.group(2).trim();
                int color = categoryColor(cat);
                int tagStart = sb.length();
                sb.append('[').append(cat).append(']');
                if (color != 0) {
                    sb.setSpan(new ForegroundColorSpan(color), tagStart, sb.length(), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
                }
                if (!rest.isEmpty()) sb.append(' ').append(rest);
            } else {
                sb.append(line);
            }
        }
        return sb;
    }

    @Override
    protected void render(Context ctx, RemoteViews views, JSONObject data, WidgetTheme theme) {
        views.setInt(R.id.meal_accent, "setColorFilter", theme.accent);
        views.setInt(R.id.meal_accent2, "setColorFilter", theme.accent);
        theme.title(views, R.id.meal_label);
        theme.title(views, R.id.meal_label2);
        theme.body(views, R.id.meal_text);
        theme.body(views, R.id.meal_text2);
        theme.sub(views, R.id.meal_empty);
        theme.size(views, R.id.meal_label, 13f);
        theme.size(views, R.id.meal_label2, 13f);
        theme.size(views, R.id.meal_text, 12f);
        theme.size(views, R.id.meal_text2, 12f);
        theme.size(views, R.id.meal_empty, 12f);

        boolean showJinri = WidgetTheme.flag(data, widgetKey(), "mealShowJinri", true);
        boolean showMirae = WidgetTheme.flag(data, widgetKey(), "mealShowMirae", true);

        Calendar now = Calendar.getInstance();
        int minutesNow = now.get(Calendar.HOUR_OF_DAY) * 60 + now.get(Calendar.MINUTE);

        String slotKey;
        String slotLabel;
        boolean tomorrow = false;
        boolean isLunch;
        if (minutesNow >= 9 * 60 && minutesNow < 14 * 60) {
            slotKey = "lunch";
            slotLabel = "중식";
            isLunch = true;
        } else if (minutesNow >= 14 * 60 && minutesNow < 21 * 60) {
            slotKey = "dinner";
            slotLabel = "석식";
            isLunch = false;
        } else {
            slotKey = "breakfast";
            slotLabel = "조식";
            tomorrow = minutesNow >= 21 * 60; // 21시 넘으면 "내일 조식"을 봐야 한다
            isLunch = false;
        }

        // meals: { today: {breakfast, lunch, dinner, staffLunch}, tomorrow: {...} }
        JSONObject meals = data.optJSONObject("meals");
        JSONObject day = meals == null ? null : meals.optJSONObject(tomorrow ? "tomorrow" : "today");
        String text = day == null ? "" : day.optString(slotKey, "");

        views.setViewVisibility(R.id.meal_jinri_section, showJinri ? View.VISIBLE : View.GONE);
        if (showJinri) {
            views.setTextViewText(R.id.meal_label, "진리관 " + slotLabel);
            if (text == null || text.trim().isEmpty()) {
                views.setViewVisibility(R.id.meal_text, View.GONE);
                views.setViewVisibility(R.id.meal_empty, View.VISIBLE);
                views.setTextViewText(R.id.meal_empty,
                    isEmpty(data) ? "앱을 한 번 실행해주세요" : slotLabel + " 정보가 없어요");
            } else {
                views.setViewVisibility(R.id.meal_text, View.VISIBLE);
                views.setViewVisibility(R.id.meal_empty, View.GONE);
                views.setTextViewText(R.id.meal_text, buildMealText(text));
            }
        }

        // 미래관(교직원식당)은 중식만 운영 — 그 시간대가 아니면 토글을 켜뒀어도 보여줄 게 없다.
        String staffText = (isLunch && day != null) ? day.optString("staffLunch", "") : "";
        boolean showStaffSection = showMirae && isLunch && staffText != null && !staffText.trim().isEmpty();
        views.setViewVisibility(R.id.meal_staff_section, showStaffSection ? View.VISIBLE : View.GONE);
        if (showStaffSection) {
            views.setTextViewText(R.id.meal_label2, "미래관 중식");
            views.setTextViewText(R.id.meal_text2, buildMealText(staffText));
        }
    }
}
