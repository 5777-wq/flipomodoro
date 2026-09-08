package com.fiftyseven.pomodoro;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

/**
 * 常驻通知上「暂停/继续」「结束」按钮的落地广播。
 * 只做转发：收到后交给 PomodoroFgsPlugin 通知到 WebView，
 * 真正的暂停/结束逻辑仍在 timer.js 里执行，避免两套状态机。
 */
public class FgsActionReceiver extends BroadcastReceiver {

    public static final String ACTION_TOGGLE = "com.fiftyseven.pomodoro.FGS_TOGGLE";
    public static final String ACTION_STOP   = "com.fiftyseven.pomodoro.FGS_STOP";

    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent != null ? intent.getAction() : null;
        Log.i("PomodoroFgs", "receiver got: " + action);
        if (ACTION_TOGGLE.equals(action)) {
            PomodoroFgsPlugin.emitAction("toggle");
        } else if (ACTION_STOP.equals(action)) {
            PomodoroFgsPlugin.emitAction("stop");
        }
    }
}
