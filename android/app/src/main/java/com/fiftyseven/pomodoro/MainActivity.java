package com.fiftyseven.pomodoro;

import android.content.Intent;
import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // 必须在 super.onCreate 之前注册自定义插件
        registerPlugin(PomodoroFgsPlugin.class);
        super.onCreate(savedInstanceState);
        forwardContinue(getIntent());
    }

    @Override
    public void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        forwardContinue(intent);
        setIntent(intent);
    }

    /**
     * 通知按钮「开始下一阶段」带 continueNext 标记进来。
     * 转发成插件事件给 WebView 执行；冷启动时插件还没桥好，
     * 插件侧有 pending 缓冲兜底。
     */
    private void forwardContinue(Intent intent) {
        if (intent != null && intent.getBooleanExtra("continueNext", false)) {
            PomodoroFgsPlugin.emitAction("continueNext");
            intent.removeExtra("continueNext");   // 防止旋转/重建时重复触发
        }
    }
}
