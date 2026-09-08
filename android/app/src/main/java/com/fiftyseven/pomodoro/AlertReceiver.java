package com.fiftyseven.pomodoro;

import android.app.Notification;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

import androidx.core.app.NotificationCompat;

/**
 * 到点提醒的落地广播：由 AlarmManager 的精确闹钟触发。
 *
 * 通知带一个「开始下一阶段」按钮——点它等价于回到 app 点了开始，
 * 通过 MainActivity 转发 continueNext 动作给 WebView 执行。
 * 声音/震动走 alerts 渠道的 IMPORTANCE_HIGH 默认行为。
 */
public class AlertReceiver extends BroadcastReceiver {

    public static final String ACTION_ALERT = "com.fiftyseven.pomodoro.ALERT";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || !ACTION_ALERT.equals(intent.getAction())) return;

        int id = intent.getIntExtra("id", 0);
        String title = intent.getStringExtra("title");
        String body = intent.getStringExtra("body");
        if (title == null) title = "番茄钟";

        PomodoroFgsPlugin.createAlertChannel(context);

        // 内容点击：打开 app
        Intent open = new Intent(context, MainActivity.class)
                .setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pOpen = PendingIntent.getActivity(
                context, id, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        // 按钮：打开 app 并自动开始下一阶段
        Intent goNext = new Intent(context, MainActivity.class)
                .setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)
                .putExtra("continueNext", true);
        PendingIntent pNext = PendingIntent.getActivity(
                context, id + 1000, goNext,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        // 全屏意图：锁屏上直接全屏展示（闹钟类应用的官方推荐 UX）。
        // 需 USE_FULL_SCREEN_INTENT；未授权或屏幕解锁时自动降级为横幅通知，
        // 所以这里失败也不会丢提醒。
        PendingIntent pFull = PendingIntent.getActivity(
                context, id + 3000, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        Notification n = new NotificationCompat.Builder(context, PomodoroFgsPlugin.CHANNEL_ALERTS)
                .setSmallIcon(R.drawable.ic_stat_icon)
                .setContentTitle(title)
                .setContentText(body)
                .setAutoCancel(true)
                .setContentIntent(pOpen)
                .setFullScreenIntent(pFull, true)
                .addAction(new NotificationCompat.Action(0, "开始下一阶段", pNext))
                .setCategory(NotificationCompat.CATEGORY_ALARM)
                .build();

        NotificationManager nm =
                (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null) nm.notify(id, n);
    }
}
