package com.semicon.kuise;

import android.os.Bundle;
import android.webkit.WebSettings;

import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import androidx.webkit.WebSettingsCompat;
import androidx.webkit.WebViewFeature;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        disableAlgorithmicDarkening();
        setupStatusBar();
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
}
