package com.semicon.kuise;

import android.content.Context;
import android.content.res.Configuration;
import android.graphics.Color;
import android.util.TypedValue;
import android.widget.RemoteViews;

import org.json.JSONObject;

/**
 * 위젯 7종이 공통으로 쓰는 색/투명도/글씨크기 설정.
 *
 * 사용자가 앱(MY 탭 → 위젯 설정)에서 고른 값이 payload의 opts로 넘어온다.
 *   opacity   : 0~100 (카드 배경만 투명해지고 글씨는 그대로 선명하게 남는다)
 *   bg        : system | dark | light | custom (system은 기기의 현재 다크/라이트 설정을 따라간다)
 *   customBg  : "#RRGGBB" — bg가 custom일 때 쓰는 배경색 (앱에서 색상 선택기로 직접 고름)
 *   accent    : "#RRGGBB" (제목 옆 막대·강조 글씨 색)
 *   fontScale : { timetable, nextClass, meal, schedule, week, calendar, date } 각 0.7~1.6
 *               (위젯 종류마다 따로 조절 — 달력처럼 칸이 작은 위젯은 키우고 싶을 수 있어서)
 *
 * 배경을 통째로 반투명하게 만들려고 루트 뷰에 알파를 주면 글씨까지 흐려지므로,
 * 배경 전용 ImageView를 따로 깔고 그 ImageView의 알파만 조절한다.
 * 사용자 지정 배경은 흰 바탕 drawable(widget_bg_solid)에 setColorFilter로 색을 입혀서 만들고,
 * 글씨 색은 그 색의 밝기를 계산해 밝으면 어두운 글씨, 어두우면 밝은 글씨를 자동으로 고른다.
 */
public class WidgetTheme {

    public int bgRes;
    public int bgAlpha;      // 0~255
    public Integer bgTint;   // null이면 원본 drawable 색 그대로, 아니면 이 색으로 덧입힘
    public int textPrimary;
    public int textSub;
    public int accent;
    public int divider;
    public float fontScale = 1f;

    /**
     * widgetKey는 각 위젯 클래스의 widgetKey()가 주는 값(JS의 WIDGET_TYPES 키와 동일).
     *
     * 설정은 위젯 종류마다 따로 저장된다 — opts.per[widgetKey]에 그 위젯 값이 있으면 그걸 쓰고,
     * 없으면 예전 방식의 전역 값(opts.bg / opts.accent / …)으로 자연스럽게 넘어간다.
     */
    public static WidgetTheme from(Context ctx, JSONObject data, String widgetKey) {
        WidgetTheme t = new WidgetTheme();
        JSONObject opts = data == null ? null : data.optJSONObject("opts");
        JSONObject per = null;
        if (opts != null && widgetKey != null) {
            JSONObject perAll = opts.optJSONObject("per");
            if (perAll != null) per = perAll.optJSONObject(widgetKey);
        }

        String bg = pick(per, opts, "bg", "system");
        if ("system".equals(bg)) {
            int mode = ctx.getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK;
            bg = mode == Configuration.UI_MODE_NIGHT_YES ? "dark" : "light";
        }
        int opacity = pickInt(per, opts, "opacity", 92);
        String accentHex = pick(per, opts, "accent", "");
        String customBgHex = pick(per, opts, "customBg", "");

        if (opacity < 0) opacity = 0;
        if (opacity > 100) opacity = 100;
        t.bgAlpha = Math.round(opacity * 255f / 100f);

        // 글씨 배율: 위젯별 값(per.fontScale) → 예전 방식(opts.fontScale[widgetKey]) → 1배
        double scale = per != null ? per.optDouble("fontScale", Double.NaN) : Double.NaN;
        if (Double.isNaN(scale) && opts != null && widgetKey != null) {
            JSONObject fontScales = opts.optJSONObject("fontScale");
            if (fontScales != null) scale = fontScales.optDouble(widgetKey, Double.NaN);
        }
        if (!Double.isNaN(scale) && scale >= 0.7 && scale <= 1.6) t.fontScale = (float) scale;

        if ("light".equals(bg)) {
            t.bgRes = R.drawable.widget_bg_light;
            t.textPrimary = 0xFF1A1D24;
            t.textSub = 0xFF6C7484;
            t.divider = 0xFFD8DBE2;
            t.accent = parse(accentHex, 0xFFB20923);
        } else if ("custom".equals(bg)) {
            int custom = parse(customBgHex, 0xFF8C1D2B);
            t.bgRes = R.drawable.widget_bg_solid;
            t.bgTint = custom;
            boolean isBright = luminance(custom) > 140;
            if (isBright) {
                t.textPrimary = 0xFF1A1D24;
                t.textSub = 0xFF5C6472;
                t.divider = 0x33000000;
            } else {
                t.textPrimary = 0xFFF2F4F8;
                t.textSub = 0xFFC9CDD6;
                t.divider = 0x33FFFFFF;
            }
            // 강조색을 따로 안 골랐으면, 배경과 그냥 같은 색이라 안 보이지 않도록 텍스트색 계열로 기본값을 둔다.
            t.accent = accentHex.isEmpty() ? t.textPrimary : parse(accentHex, t.textPrimary);
        } else {
            t.bgRes = R.drawable.widget_bg_dark;
            t.textPrimary = 0xFFF2F4F8;
            t.textSub = 0xFF7C8598;
            t.divider = 0xFF3A3F4D;
            t.accent = parse(accentHex, 0xFFF5C563);
        }
        return t;
    }

    /**
     * 배경 이미지와 투명도를 적용한다. 모든 위젯 레이아웃이 같은 id를 쓴다.
     *
     * 색 필터는 조건부로 걸면 안 된다 — 런처는 위젯 뷰를 새로 만들지 않고 재사용하면서
     * RemoteViews의 명령만 덧씌우기 때문에, 사용자 지정 배경에서 걸어둔 필터가 나중에
     * 라이트/다크로 바꿔도 그대로 남아 색이 안 돌아오는 문제가 있었다.
     * 그래서 항상 호출하되, 필터가 필요 없을 땐 완전 투명(알파 0)을 넘긴다.
     * (SRC_ATOP 합성에서 알파 0은 원본을 그대로 두는 것과 같아 사실상 "필터 없음"이 된다)
     */
    public void applyBackground(RemoteViews views) {
        views.setImageViewResource(R.id.widget_bg, bgRes);
        views.setInt(R.id.widget_bg, "setImageAlpha", bgAlpha);
        views.setInt(R.id.widget_bg, "setColorFilter", bgTint != null ? bgTint : 0x00000000);
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

    /** 위젯별 설정(per) → 전역 설정(opts) → 기본값 순으로 문자열 값을 고른다. */
    private static String pick(JSONObject per, JSONObject opts, String key, String fallback) {
        if (per != null && per.has(key)) return per.optString(key, fallback);
        if (opts != null && opts.has(key)) return opts.optString(key, fallback);
        return fallback;
    }

    /** pick의 숫자 버전. */
    private static int pickInt(JSONObject per, JSONObject opts, String key, int fallback) {
        if (per != null && per.has(key)) return per.optInt(key, fallback);
        if (opts != null && opts.has(key)) return opts.optInt(key, fallback);
        return fallback;
    }

    /** 위젯별 on/off 설정(오늘 일정 표시 등)을 per → opts → 기본값 순으로 고른다. */
    public static boolean flag(JSONObject data, String widgetKey, String key, boolean fallback) {
        JSONObject opts = data == null ? null : data.optJSONObject("opts");
        if (opts == null) return fallback;
        JSONObject perAll = opts.optJSONObject("per");
        JSONObject per = perAll == null ? null : perAll.optJSONObject(widgetKey);
        if (per != null && per.has(key)) return per.optBoolean(key, fallback);
        return opts.optBoolean(key, fallback);
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

    /** 사람 눈에 보이는 밝기(0~255) — 이 값으로 밝은 배경엔 어두운 글씨를 자동으로 고른다. */
    private static int luminance(int color) {
        int r = Color.red(color), g = Color.green(color), b = Color.blue(color);
        return (int) (0.299 * r + 0.587 * g + 0.114 * b);
    }
}
