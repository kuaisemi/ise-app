package com.semicon.kuise;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import java.io.OutputStream;
import android.view.Window;

import androidx.core.graphics.ColorUtils;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * 웹(index.html) ↔ 네이티브 위젯 사이의 다리.
 *
 * 이 앱은 번들러를 쓰지 않아서 npm 플러그인을 추가하기 번거로운데, Capacitor는 네이티브에
 * 등록된 플러그인을 자동으로 Capacitor.Plugins.<name> 으로 노출해준다. 그래서 JS 쪽에서
 * 추가 설치 없이 바로 Capacitor.Plugins.WidgetBridge.update({ payload }) 로 호출할 수 있다.
 *
 * 위젯을 눌러서 특정 화면으로 바로 이동하는 것(딥링크)도 이 플러그인이 담당한다:
 *   - 앱이 꺼져있다가 위젯 클릭으로 켜진 경우(콜드 스타트): JS가 부팅 후 한 번
 *     consumeDeepLink()를 불러서 대기 중인 목적지를 가져간다.
 *   - 앱이 이미 떠 있는데 위젯을 누른 경우(launchMode singleTop이라 onNewIntent만 옴):
 *     MainActivity가 notifyDeepLink()를 호출해 'deepLink' 이벤트를 즉시 쏴준다.
 */
@CapacitorPlugin(name = "WidgetBridge")
public class WidgetBridgePlugin extends Plugin {

    // Capacitor는 화면 회전 등으로 플러그인 인스턴스를 다시 만들 수 있어서, 정적 필드가 아니라
    // "가장 최근 로드된 인스턴스"를 인스턴스 메서드로 갱신해 안전하게 참조한다.
    private static WidgetBridgePlugin activeInstance;
    private static String pendingTarget;

    @Override
    public void load() {
        activeInstance = this;
    }

    /**
     * 상태표시줄(맨 위 시계 줄)과 내비게이션 바 색을 앱 배경색에 맞춘다.
     * 웹이 테마를 바꿀 때마다 { color: "#rrggbb" }로 부른다. 배경이 밝으면 아이콘을 어둡게 한다.
     * (삼성 태블릿 하단 작업표시줄은 시스템 소유라 앱이 칠할 수 없다.)
     */
    @PluginMethod
    public void setBars(final PluginCall call) {
        final String color = call.getString("color");
        if (color == null || getActivity() == null) {
            call.resolve();
            return;
        }
        getActivity().runOnUiThread(new Runnable() {
            @Override
            public void run() {
                try {
                    int c = Color.parseColor(color);
                    Window w = getActivity().getWindow();
                    w.setStatusBarColor(c);
                    w.setNavigationBarColor(c);
                    // targetSdk 36(edge-to-edge)에서는 위 두 호출이 무시되므로, 막대 뒤에 비치는 창 배경을 직접 칠한다
                    w.getDecorView().setBackgroundColor(c);
                    w.setBackgroundDrawable(new android.graphics.drawable.ColorDrawable(c));
                    WindowInsetsControllerCompat ctrl = WindowCompat.getInsetsController(w, w.getDecorView());
                    if (ctrl != null) {
                        boolean lightBg = ColorUtils.calculateLuminance(c) > 0.5;
                        ctrl.setAppearanceLightStatusBars(lightBg);
                        ctrl.setAppearanceLightNavigationBars(lightBg);
                    }
                } catch (Exception ignored) {
                }
            }
        });
        call.resolve();
    }

    /**
     * PNG(base64)를 기기의 사진 보관함(Pictures/ISE)에 저장한다. 공유 창 없이 바로 저장되고,
     * Android 10 이상에서는 별도 권한이 필요 없다(MediaStore).
     */
    @PluginMethod
    public void saveImage(PluginCall call) {
        String b64 = call.getString("data");
        String name = call.getString("name", "timetable.png");
        if (b64 == null) {
            call.reject("data가 없습니다");
            return;
        }
        try {
            byte[] bytes = Base64.decode(b64, Base64.DEFAULT);
            ContentResolver resolver = getContext().getContentResolver();
            ContentValues values = new ContentValues();
            values.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
            values.put(MediaStore.MediaColumns.MIME_TYPE, "image/png");
            if (Build.VERSION.SDK_INT >= 29) {
                values.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_PICTURES + "/ISE");
                values.put(MediaStore.MediaColumns.IS_PENDING, 1);
            }
            Uri uri = resolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values);
            if (uri == null) {
                call.reject("저장 위치를 만들지 못했습니다");
                return;
            }
            OutputStream os = resolver.openOutputStream(uri);
            if (os == null) {
                call.reject("저장 위치를 열지 못했습니다");
                return;
            }
            os.write(bytes);
            os.close();
            if (Build.VERSION.SDK_INT >= 29) {
                ContentValues done = new ContentValues();
                done.put(MediaStore.MediaColumns.IS_PENDING, 0);
                resolver.update(uri, done, null, null);
            }
            JSObject ret = new JSObject();
            ret.put("ok", true);
            ret.put("uri", uri.toString());
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("이미지를 저장하지 못했습니다: " + e.getMessage());
        }
    }

    /** payload(JSON 문자열)를 저장하고 홈 화면 위젯을 즉시 다시 그린다. */
    @PluginMethod
    public void update(PluginCall call) {
        String payload = call.getString("payload");
        if (payload == null) {
            call.reject("payload가 없습니다");
            return;
        }
        WidgetData.save(getContext(), payload);
        WidgetData.refreshAll(getContext());
        JSObject ret = new JSObject();
        ret.put("ok", true);
        call.resolve(ret);
    }

    /** 부팅 직후 한 번 호출 — 위젯 클릭으로 콜드 스타트됐다면 대기 중인 목적지를 돌려주고 비운다. */
    @PluginMethod
    public void consumeDeepLink(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("target", pendingTarget);
        pendingTarget = null;
        call.resolve(ret);
    }

    /** MainActivity가 새 인텐트를 받았을 때(앱이 이미 떠 있던 경우) 호출한다. */
    static void setPendingTarget(String target) {
        pendingTarget = target;
    }

    /**
     * 앱이 이미 떠 있을 때(웜 스타트, onNewIntent) 호출 — 'deepLink' 이벤트로 즉시 알린다.
     * JS가 이미 살아있는 상태라고 가정하므로 pendingTarget에는 남기지 않는다
     * (남겨두면 다음에 완전히 새로 켤 때 엉뚱하게 재사용될 수 있음).
     */
    static void notifyDeepLink(String target) {
        if (activeInstance != null) {
            JSObject data = new JSObject();
            data.put("target", target);
            activeInstance.notifyListeners("deepLink", data);
        } else {
            // 혹시 인스턴스가 아직 없다면(이론상 거의 없음) 콜드 스타트 경로로라도 전달되게 남겨둔다.
            setPendingTarget(target);
        }
    }
}
