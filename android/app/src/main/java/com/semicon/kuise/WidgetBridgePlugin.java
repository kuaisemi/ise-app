package com.semicon.kuise;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * 웹(index.html) → 네이티브 위젯으로 데이터를 넘겨주는 다리.
 *
 * 이 앱은 번들러를 쓰지 않아서 npm 플러그인을 추가하기 번거로운데, Capacitor는 네이티브에
 * 등록된 플러그인을 자동으로 Capacitor.Plugins.<name> 으로 노출해준다. 그래서 JS 쪽에서
 * 추가 설치 없이 바로 Capacitor.Plugins.WidgetBridge.update({ payload }) 로 호출할 수 있다.
 */
@CapacitorPlugin(name = "WidgetBridge")
public class WidgetBridgePlugin extends Plugin {

    /**
     * payload(JSON 문자열)를 저장하고 홈 화면 위젯을 즉시 다시 그린다.
     * 위젯은 30분마다 스스로도 갱신하지만, 앱에서 시간표를 고친 직후처럼
     * 바로 반영되어야 할 때를 위해 앱이 직접 호출한다.
     */
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
}
