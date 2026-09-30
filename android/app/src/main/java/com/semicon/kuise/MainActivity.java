package com.semicon.kuise;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.webkit.WebSettings;
import android.webkit.WebView;

import androidx.activity.OnBackPressedCallback;
import androidx.appcompat.app.AlertDialog;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import androidx.webkit.WebSettingsCompat;
import androidx.webkit.WebViewFeature;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    /** 위젯을 눌렀을 때 어느 화면으로 갈지 담아 보내는 인텐트 extra 키. */
    static final String EXTRA_WIDGET_TARGET = "widget_target";

    /**
     * FCM 알림 채널 id. AndroidManifest.xml의 default_notification_channel_id
     * meta-data와 반드시 같은 값이어야 한다 — 둘이 어긋나면 그 채널이 존재하지 않는
     * 것으로 취급돼 시스템이 다시 자기 마음대로(기본 중요도) 채널을 만들어버린다.
     */
    static final String NOTIFICATION_CHANNEL_ID = "ku_ise_default";

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // 웹에서 홈 화면 위젯으로 데이터를 넘길 통로.
        // registerPlugin은 super.onCreate() 전에 불러야 브리지가 만들어질 때 함께 등록된다.
        registerPlugin(WidgetBridgePlugin.class);
        registerPlugin(OtaPlugin.class);
        // 웹 패치가 깨져서 화면이 안 뜨는 경우를 위한 되돌리기 — 브리지가 저장된 패치 경로를 읽기 전에 해야 한다.
        OtaPlugin.guardBoot(this);
        super.onCreate(savedInstanceState);
        disableAlgorithmicDarkening();
        setupStatusBar();
        createNotificationChannel();
        setupBackButton();

        // 콜드 스타트(앱이 꺼져있다가 위젯 클릭으로 켜짐) — 웹뷰/JS가 아직 준비 안 됐을 수 있으니
        // 플러그인에 값만 남겨두고, JS가 부팅 후 consumeDeepLink()로 직접 가져가게 한다.
        String target = getIntent() == null ? null : getIntent().getStringExtra(EXTRA_WIDGET_TARGET);
        if (target != null) WidgetBridgePlugin.setPendingTarget(target);
    }

    /**
     * 앱이 이미 떠 있는 상태(launchMode singleTop)에서 위젯을 다시 눌렀을 때 호출된다.
     * 기본 Activity는 getIntent()를 자동으로 갱신하지 않으므로 setIntent로 직접 반영하고,
     * JS가 이미 살아있다고 보고 이벤트로 즉시 알린다.
     */
    @Override
    public void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        String target = intent == null ? null : intent.getStringExtra(EXTRA_WIDGET_TARGET);
        if (target != null) WidgetBridgePlugin.notifyDeepLink(target);
    }

    /**
     * 뒤로가기 키: 웹 쪽이 팝업·전체 화면 창을 열 때마다 history에 한 칸씩 쌓아 두므로(index.html의 uiLayerOpened),
     * 웹뷰에 되돌아갈 기록이 있으면 한 칸 뒤로 가서 그 창을 닫고, 없으면(맨 화면) 기본 동작(앱 종료)으로 넘긴다.
     * Capacitor 코어는 이 처리를 App 플러그인에 맡기는데 이 앱에는 그 플러그인이 없어서, 지금까지는 팝업이 떠 있어도 뒤로가기가 앱을 꺼버렸다.
     */
    private AlertDialog exitDialog;

    private void setupBackButton() {
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                WebView webView = (getBridge() == null) ? null : getBridge().getWebView();
                if (webView != null && webView.canGoBack()) {
                    webView.goBack();
                    return;
                }
                // 더 돌아갈 화면이 없는 기본 화면: 바로 끄지 않고 한 번 물어본다
                if (exitDialog != null && exitDialog.isShowing()) return;
                exitDialog = new AlertDialog.Builder(MainActivity.this)
                    .setMessage("앱을 종료할까요?")
                    .setPositiveButton("종료", (d, w) -> finish())
                    .setNegativeButton("취소", null)
                    .create();
                exitDialog.show();
            }
        });
    }
    /**
     * 웹뷰의 "강제 다크모드(알고리즘 색 반전)"를 끈다.
     *
     * 이걸 켜두면 기기가 다크모드일 때 안드로이드가 페이지 색을 제멋대로 보정해서
     * 검정이 검정이 아니게 되거나 시간표 색상이 깨진다. 앱은 index.html에서
     * data-theme + color-scheme으로 라이트/다크를 직접 관리하므로,
     * OS가 개입하지 않고 웹 코드가 지정한 색을 그대로 그리게 만든다.
     */
    private void disableAlgorithmicDarkening() {
        if (getBridge() == null || getBridge().getWebView() == null) {
            return;
        }
        WebSettings settings = getBridge().getWebView().getSettings();
        if (WebViewFeature.isFeatureSupported(WebViewFeature.ALGORITHMIC_DARKENING)) {
            WebSettingsCompat.setAlgorithmicDarkeningAllowed(settings, false);
        }
    }

    /**
     * 상태표시줄(시계·배터리 영역) 아이콘을 항상 흰색으로 고정한다.
     *
     * targetSdk 35+에서는 edge-to-edge가 강제되어 상태표시줄 배경을 네이티브에서
     * 칠할 수 없다. 대신 웹 쪽 .statusbar-bg가 safe-area 높이만큼 크림슨으로 칠하므로,
     * 그 위에 얹히는 아이콘은 어두운 배경에 맞춰 밝은 색이어야 한다.
     * (setAppearanceLightStatusBars(false) = 밝은 아이콘)
     */
    private void setupStatusBar() {
        WindowInsetsControllerCompat controller =
            WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        if (controller != null) {
            controller.setAppearanceLightStatusBars(false);
        }
    }

    /**
     * 채팅·공지 알림이 진동만 울리고 화면 위로 안 떠서(헤드업 배너) 못 보고 지나친다는
     * 문제 때문에 추가. AndroidManifest.xml에 채널 id를 지정 안 해두면 FCM이 자기
     * 마음대로 "fcm_fallback_notification_channel"을 IMPORTANCE_DEFAULT로 만드는데,
     * 그 중요도로는 화면 위로 뜨지 않고 알림 목록에만 조용히 쌓인다.
     * IMPORTANCE_HIGH로 채널을 직접 만들어야 배너로 뜬다.
     *
     * 채널은 한 번 만들어지면 이후 앱 코드에서 중요도를 못 바꾼다(사용자가 시스템
     * 설정에서 직접 낮추는 건 가능) — 그래서 처음부터 HIGH로 만드는 게 중요하다.
     */
    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return; // 채널 개념 자체가 8.0부터
        NotificationChannel channel = new NotificationChannel(
            NOTIFICATION_CHANNEL_ID,
            "일반 알림",
            NotificationManager.IMPORTANCE_HIGH
        );
        channel.setDescription("공지·투표·채팅·일정 등 KU ISE의 모든 알림");
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) manager.createNotificationChannel(channel);
    }
}
