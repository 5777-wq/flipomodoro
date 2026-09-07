package com.fiftyseven.pomodoro;

import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.util.Log;

import androidx.core.app.NotificationCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * 自研原生插件：前台常驻服务 + 带按钮的到点提醒通知
 *
 * 为什么不直接用官方 LocalNotifications：
 *   1. 它不支持通知上的操作按钮，"到点后一键开始休息"做不了
 *   2. 番茄钟需要前台服务防杀后台，官方没有对应能力
 *
 * 分工：
 *   start/update/stop —— 前台常驻倒计时（见 ForegroundTimerService）
 *   scheduleAlert     —— 到点提醒，同一套精确闹钟机制（RTC_WAKEUP +
 *                        setExactAndAllowWhileIdle），但通知带操作按钮，
 *                        点击"开始下一阶段"直接回到 app 并自动续跑
 *
 * 注意保留 USE_EXACT_ALARM 权限（manifest 里已有），否则 Android 14 上
 * setExactAndAllowWhileIdle 会退化为非精确闹钟。
 */
@CapacitorPlugin(name = "PomodoroFgs")
public class PomodoroFgsPlugin extends Plugin {

    public static final String CHANNEL_ALERTS = "alerts";
    private static volatile String sPendingAction = null;
    private static volatile PomodoroFgsPlugin sInstance = null;

    @Override
    public void load() {
        sInstance = this;
        getBridge().getWebView().post(() -> {
            String pending = sPendingAction;
            if (pending != null && sInstance != null) {
                sPendingAction = null;
                JSObject data = new JSObject();
                data.put("action", pending);
                notifyListeners("fgsAction", data);
            }
        });
    }

    @Override
    protected void handleOnDestroy() {
        sInstance = null;
        super.handleOnDestroy();
    }

    // ============================================
    // 前台常驻服务
    // ============================================
    @PluginMethod
    public void start(PluginCall call) {
        int remainSec = call.getInt("remainSec", 0);
        boolean isFocus = call.getBoolean("isFocus", true);

        Intent i = new Intent(getContext(), ForegroundTimerService.class);
        i.putExtra("remainSec", remainSec);
        i.putExtra("isFocus", isFocus);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            getContext().startForegroundService(i);
        } else {
            getContext().startService(i);
        }
        call.resolve();
    }

    @PluginMethod
    public void update(PluginCall call) {
        Integer remain = call.getInt("remainSec");
        Boolean paused = call.getBoolean("paused");
        Boolean isFocus = call.getBoolean("isFocus");
        ForegroundTimerService.push(
                remain != null ? remain : 0,
                paused != null && paused,
                isFocus == null || isFocus);
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        getContext().stopService(new Intent(getContext(), ForegroundTimerService.class));
        call.resolve();
    }

    /** 阶段结束时的即时通知（JS 在后台被节流时补发用） */
    @PluginMethod
    public void postNow(PluginCall call) {
        Integer id = call.getInt("id");
        String title = call.getString("title", "番茄钟");
        String body = call.getString("body", "");
        if (id == null) { call.resolve(); return; }

        Context ctx = getContext();
        createAlertChannel(ctx);

        Intent open = new Intent(ctx, MainActivity.class)
                .setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pOpen = PendingIntent.getActivity(
                ctx, id, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        Notification n = new NotificationCompat.Builder(ctx, CHANNEL_ALERTS)
                .setSmallIcon(R.drawable.ic_stat_icon)
                .setContentTitle(title)
                .setContentText(body)
                .setAutoCancel(true)
                .setContentIntent(pOpen)
                .setCategory(NotificationCompat.CATEGORY_ALARM)
                .build();

        NotificationManager nm =
                (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null) nm.notify(id, n);
        call.resolve();
    }

    // ============================================
    // 带按钮的到点提醒
    // ============================================
    @PluginMethod
    public void scheduleAlert(PluginCall call) {
        Integer id = call.getInt("id");
        // 注意：getDouble 对超过 int 范围的整型返回 null（实测），
        // 毫秒时间戳必须从原始数据里按 Number 取
        Double atMs = null;
        Object rawAt = call.getData() != null ? call.getData().opt("atMs") : null;
        if (rawAt instanceof Number) {
            atMs = ((Number) rawAt).doubleValue();
        } else if (rawAt != null) {
            try { atMs = Double.parseDouble(String.valueOf(rawAt)); } catch (Exception ignored) {}
        }
        String title = call.getString("title", "番茄钟");
        String body = call.getString("body", "");
        Log.d("PomoFgs", "scheduleAlert id=" + id + " atMs=" + atMs
                + " now=" + System.currentTimeMillis());
        if (id == null || atMs == null || atMs <= System.currentTimeMillis()) {
            Log.w("PomoFgs", "scheduleAlert 早退（id/atMs 无效或时间已过）");
            call.resolve(); return;
        }

        Context ctx = getContext();
        createAlertChannel(ctx);

        long triggerAt = atMs.longValue();
        Intent alarm = new Intent(ctx, AlertReceiver.class)
                .setAction(AlertReceiver.ACTION_ALERT)
                .putExtra("id", id)
                .putExtra("title", title)
                .putExtra("body", body);
        PendingIntent pi = PendingIntent.getBroadcast(
                ctx, id, alarm,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
        try {
            if (am == null) {
                Log.w("PomoFgs", "AlarmManager 为 null");
                call.resolve(); return;
            }
            // 官方对"闹钟类应用"的推荐 API：setAlarmClock。
            // 相比 setExactAndAllowWhileIdle：
            //   1. Doze / 省电模式下保证精确触发（无 9 分钟节流限制）
            //   2. 触发前状态栏显示闹钟图标，用户可感知
            //   3. 语义上就是给用户可见的闹钟用的，Play 审核友好
            Intent show = new Intent(ctx, MainActivity.class)
                    .setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
            PendingIntent pShow = PendingIntent.getActivity(
                    ctx, id + 2000, show,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            am.setAlarmClock(new AlarmManager.AlarmClockInfo(triggerAt, pShow), pi);
            Log.d("PomoFgs", "setAlarmClock OK triggerAt=" + triggerAt);
        } catch (Exception e) {
            // setAlarmClock 理论上不可用就退回精确闹钟（保证功能不劣化）
            try {
                am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAt, pi);
                Log.d("PomoFgs", "回退 setExactAndAllowWhileIdle triggerAt=" + triggerAt);
            } catch (Exception e2) {
                Log.e("PomoFgs", "两种精确闹钟都失败", e2);
            }
        }
        call.resolve();
    }

    @PluginMethod
    public void cancelAlert(PluginCall call) {
        Integer id = call.getInt("id");
        if (id == null) { call.resolve(); return; }
        Context ctx = getContext();
        AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
        if (am != null) {
            Intent alarm = new Intent(ctx, AlertReceiver.class).setAction(AlertReceiver.ACTION_ALERT);
            PendingIntent pi = PendingIntent.getBroadcast(
                    ctx, id, alarm,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            am.cancel(pi);
        }
        NotificationManager nm =
                (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null) nm.cancel(id);
        call.resolve();
    }

    static void createAlertChannel(Context ctx) {
        NotificationManager nm =
                (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null || Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        if (nm.getNotificationChannel(CHANNEL_ALERTS) != null) return;
        NotificationChannel ch = new NotificationChannel(
                CHANNEL_ALERTS, "阶段提醒",
                NotificationManager.IMPORTANCE_HIGH);   // 允许横幅 + 声音 + 震动
        ch.setDescription("专注/休息结束时的提醒");
        nm.createNotificationChannel(ch);
    }

    // ============================================
    // JS 桥接
    // ============================================
    /** 接收器/Activity 转发用户动作给 WebView */
    public static void emitAction(String action) {
        Log.i("PomodoroFgs", "emitAction " + action + " instance=" + (sInstance != null));
        sPendingAction = action;
        PomodoroFgsPlugin inst = sInstance;
        if (inst != null && inst.getBridge() != null) {
            JSObject data = new JSObject();
            data.put("action", action);
            inst.notifyListeners("fgsAction", data);
            sPendingAction = null;
        }
    }
}
