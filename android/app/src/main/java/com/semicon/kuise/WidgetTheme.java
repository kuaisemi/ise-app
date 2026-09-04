package com.semicon.kuise;

import android.graphics.Color;
import android.util.TypedValue;
import android.widget.RemoteViews;

import org.json.JSONObject;

/**
 * 위젯 7종이 공통으로 쓰는 색/투명도/글씨크기 설정.
 *
 * 사용자가 앱(MY 탭 → 위젯 설정)에서 고른 값이 payload의 opts로 넘어온다.
 *   opacity   : 0~100 (카드 배경만 투명해지고 글씨는 그대로 선명하게 남는다)
 *   bg        : dark | light | crimson
 *   accent    : "#RRGGBB" (제목 옆 막대·강조 글씨 색)
 *   fontScale : { timetable, nextClass, meal, schedule, week, calendar, date } 각 0.7~1.6
 *               (위젯 종류마다 따로 조절 — 달력처럼 칸이 작은 위젯은 키우고 싶을 수 있어서)
 *
 * 배경을 통째로 반투명하게 만들려고 루트 뷰에 알파를 주면 글씨까지 흐려지므로,
 * 배경 전용 ImageView를 따로 깔고 그 ImageView의 알파만 조절한다.
 */
public class WidgetTheme {

    public int bgRes;
    public int bgAlpha;      // 0~255
    public int textPrimary;
    public int textSub;
    public int accent;
    public int divider;
    public float fontScale = 1f;

    /** widgetKey는 각 위젯 클래스의 widgetKey()가 주는 값(JS의 WIDGET_TYPES 키와 동일). */
    public static WidgetTheme from(JSONObject data, String widgetKey) {
        WidgetTheme t = new WidgetTheme();
        JSONObject opts = data == null ? null : data.optJSONObject("opts");

        String bg = opts == null ? "dark" : opts.optString("bg", "dark");
        int opacity = opts == null ? 92 : opts.optInt("opacity", 92);
        String accentHex = opts == null ? "" : opts.optString("accent", "");

        if (opacity < 0) opacity = 0;
        if (opacity > 100) opacity = 100;
        t.bgAlpha = Math.round(opacity * 255f / 100f);

        if (opts != null && widgetKey != null) {
            JSONObject fontScales = opts.optJSONObject("fontScale");
            if (fontScales != null) {
                double v = fontScales.optDouble(widgetKey, 1.0);
                if (!Double.isNaN(v) && v >= 0.7 && v <= 1.6) t.fontScale = (float) v;
            }
        }

        if ("light".equals(bg)) {
            t.bgRes = R.drawable.widget_bg_light;
            t.textPrimary = 0xFF1A1D24;
            t.textSub = 0xFF6C7484;
            t.divider = 0xFFD8DBE2;
            t.accent = parse(accentHex, 0xFFB20923);
        } else if ("crimson".equals(bg)) {
            t.bgRes = R.drawable.widget_bg_crimson;
            t.textPrimary = 0xFFFFFFFF;
            t.textSub = 0xCCFFE8EC;
            t.divider = 0xFFB5424F;
            t.accent = parse(accentHex, 0xFFF5C563);
        } else {
            t.bgRes = R.drawable.widget_bg_dark;
            t.textPrimary = 0xFFF2F4F8;
            t.textSub = 0xFF7C8598;
            t.divider = 0xFF3A3F4D;
            t.accent = parse(accentHex, 0xFFF5C563);
        }
        return t;
    }

    /** 배경 이미지와 투명도를 적용한다. 모든 위젯 레이아웃이 같은 id를 쓴다. */
    public void applyBackground(RemoteViews views) {
        views.setImageViewResource(R.id.widget_bg, bgRes);
        views.setInt(R.id.widget_bg, "setImageAlpha", bgAlpha);
    }

    public void title(RemoteViews views, int viewId) {
        views.setTextColor(viewId, textPrimary);
    }

    public void body(RemoteViews views, int viewId) {
        views.setTextColor(viewId, textPrimary);
    }

    public void sub(RemoteViews views, int viewId) {
        views.setTextColor(viewId, textSub);
    }

    public void accent(RemoteViews views, int viewId) {
        views.setTextColor(viewId, accent);
    }

    /** 레이아웃 XML에 적어둔 기본 sp 크기에 이 위젯의 글씨 배율을 곱해서 적용한다. */
    public void size(RemoteViews views, int viewId, float baseSp) {
        views.setTextViewTextSize(viewId, TypedValue.COMPLEX_UNIT_SP, baseSp * fontScale);
    }

    /** "#RRGGBB" 문자열을 색으로. 비었거나 이상하면 기본값을 쓴다. */
    public static int parse(String hex, int fallback) {
        if (hex == null || hex.isEmpty()) return fallback;
        try {
            return Color.parseColor(hex);
        } catch (IllegalArgumentException e) {
            return fallback;
        }
    }
}
