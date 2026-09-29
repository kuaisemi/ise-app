package com.semicon.kuise;

import android.content.Context;
import android.content.SharedPreferences;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.plugin.WebView;

import java.io.File;

/**
 * 웹 패치(OTA)의 안전장치.
 *
 * 앱은 웹 화면(index.html 묶음)을 서버에서 받아 기기에 저장해 두고, 웹뷰가 APK에 든 파일 대신
 * 그 폴더를 열게 한다(Capacitor의 WebView.setServerBasePath). 그런데 새 패치가 깨져 있으면
 * 화면이 하나도 안 뜨고, 그러면 JS가 스스로를 되돌릴 방법도 없다 — 그래서 되돌리기만큼은
 * 네이티브가 맡는다.
 *
 * 흐름:
 *   1) JS가 패치를 내려받은 뒤 arm(version)을 부른다 → "확인 대기 중" 표시(pending).
 *   2) 새 패치로 화면이 정상적으로 뜨면 JS가 confirm()을 부른다 → pending 해제.
 *   3) 앱이 처음부터 다시 시작될 때마다 MainActivity가 guardBoot()를 부른다. pending인데도
 *      confirm이 없었다면 시작 횟수(attempts)를 올리고, 두 번째로도 확인이 안 되면
 *      저장해 둔 패치 경로를 지워서 APK에 든 원본 화면으로 되돌린다.
 */
@CapacitorPlugin(name = "Ota")
public class OtaPlugin extends Plugin {

    private static final String PREFS = "ku_ise_ota";
    private static final String KEY_PENDING = "pending";      // 확인 대기 중인 패치 버전 (없으면 빈 문자열)
    private static final String KEY_ATTEMPTS = "attempts";    // pending인 채로 앱이 시작된 횟수
    private static final String KEY_CONFIRMED = "confirmed";  // 마지막으로 정상 확인된 패치 버전
    private static final String KEY_FAILED = "failed";        // 확인이 안 돼서 되돌린 패치 버전(같은 버전을 다시 받지 않게)
    private static final int MAX_UNCONFIRMED_LAUNCHES = 2;

    /** MainActivity.onCreate()에서 super.onCreate() 전에 부른다(브리지가 저장된 경로를 읽기 전). */
    static void guardBoot(Context ctx) {
        SharedPreferences prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String pending = prefs.getString(KEY_PENDING, "");
        if (pending.isEmpty()) return;

        int attempts = prefs.getInt(KEY_ATTEMPTS, 0) + 1;
        if (attempts >= MAX_UNCONFIRMED_LAUNCHES) {
            rollback(ctx);
            prefs.edit().putString(KEY_FAILED, pending).putString(KEY_PENDING, "").putInt(KEY_ATTEMPTS, 0).apply();
        } else {
            prefs.edit().putInt(KEY_ATTEMPTS, attempts).apply();
        }
    }

    /** Capacitor가 다음 시작 때 읽는 "패치 폴더 경로"를 비워 APK에 든 원본 화면으로 되돌린다. */
    private static void rollback(Context ctx) {
        ctx.getSharedPreferences(WebView.WEBVIEW_PREFS_NAME, Context.MODE_PRIVATE)
            .edit()
            .putString(WebView.CAP_SERVER_PATH, "")
            .apply();
    }

    /** 패치를 내려받아 저장하는 데 성공했고 곧 그 폴더로 전환한다 — 확인이 올 때까지 pending. */
    @PluginMethod
    public void arm(PluginCall call) {
        String version = call.getString("version", "");
        String path = call.getString("path", "");
        if (version.isEmpty() || path.isEmpty() || !new File(path, "index.html").exists()) {
            call.reject("version 또는 패치 폴더(index.html 포함)가 올바르지 않습니다");
            return;
        }
        getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putString(KEY_PENDING, version)
            .putInt(KEY_ATTEMPTS, 0)
            .apply();
        // 다음 시작에도 이 폴더를 열도록 여기서 직접 저장한다. JS의 persistServerBasePath는
        // 웹뷰가 다시 열리는 도중이라 호출이 끝까지 가지 못할 수 있다.
        getContext().getSharedPreferences(WebView.WEBVIEW_PREFS_NAME, Context.MODE_PRIVATE)
            .edit()
            .putString(WebView.CAP_SERVER_PATH, path)
            .apply();
        call.resolve();
    }

    /** 새 패치로 화면이 정상적으로 떴다. pending을 풀고 이 버전을 "확인됨"으로 남긴다. */
    @PluginMethod
    public void confirm(PluginCall call) {
        String version = call.getString("version", "");
        getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putString(KEY_PENDING, "")
            .putInt(KEY_ATTEMPTS, 0)
            .putString(KEY_CONFIRMED, version)
            .apply();
        call.resolve();
    }

    /** JS가 "지금 확인 대기 중인지 / 어느 버전이 확인됐는지" 알고 싶을 때. */
    @PluginMethod
    public void state(PluginCall call) {
        SharedPreferences prefs = getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        JSObject ret = new JSObject();
        ret.put("pending", prefs.getString(KEY_PENDING, ""));
        ret.put("confirmed", prefs.getString(KEY_CONFIRMED, ""));
        ret.put("failed", prefs.getString(KEY_FAILED, ""));
        call.resolve(ret);
    }

    /** 저장돼 있던 패치 폴더 경로가 아직 실제로 있는지(지워졌으면 원본으로 도는 중이다). */
    @PluginMethod
    public void pathExists(PluginCall call) {
        String path = call.getString("path", "");
        JSObject ret = new JSObject();
        ret.put("exists", !path.isEmpty() && new File(path).exists());
        call.resolve(ret);
    }
}
