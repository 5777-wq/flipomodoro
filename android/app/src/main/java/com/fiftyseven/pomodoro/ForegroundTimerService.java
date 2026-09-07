package com.fiftyseven.pomodoro;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;

import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;

/**
 * 前台常驻服务：专注进行时挂一条低优先级常驻通知。
 *
 * 解决的问题：WebView 进程在国产 ROM 上随时可能被"省电"杀掉。
 * 挂了前台服务后进程优先级提升到前台档，系统不再把它当缓存进程回收；
 * 附带收益是通知栏能直接看到倒计时，还带「暂停/继续」「结束」按钮，
 * 不用解锁进 app 就能操作。
 *
 * 计时权威仍在 WebView（timer.js）：它每秒把真实剩余时间推过来；
 * 本地的每秒自减只是两次推送之间的显示兜底，收到推送立即覆盖。
 */
public class ForegroundTimerService extends Service {

    public static final String CHANNEL_FGS = "fgs";
    private static final int NOTIF_ID = 8901;

    private static volatile boolean sRunning = false;
    private static volatile int sRemainSec = 0;
    private static volatile boolean sPaused = false;
    private static volatile boolean sIsFocus = true;
    private static ForegroundTimerService sInstance = null;

    private final Handler mHandler = new Handler(Looper.getMainLooper());
    private final Runnable mTick = new Runnable() {
        @Override public void run() {
            if (!sPaused && sRemainSec > 0) sRemainSec--;
            updateNotification();
            mHandler.postDelayed(this, 1000);
        }
    };

    public static boolean isRunning() { return sRunning; }

    /** 供插件调用：推送最新状态并立刻刷新通知 */
    public static void push(int remainSec, boolean paused, boolean isFocus) {
        sRemainSec = remainSec;
        sPaused = paused;
        sIsFocus = isFocus;
        ForegroundTimerService svc = sInstance;
        if (svc != null) svc.updateNotification();
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }

    @Override
    public void onCreate() {
        super.onCreate();
        sInstance = this;
        createChannel(this);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null) {
            sRemainSec = intent.getIntExtra("remainSec", 0);
            sIsFocus = intent.getBooleanExtra("isFocus", true);
            sPaused = false;
        }
        sRunning = true;

        Notification n = buildNotification();
        // Android 14+ 必须带类型启动前台服务
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            ServiceCompat.startForeground(this, NOTIF_ID, n,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        } else {
            startForeground(NOTIF_ID, n);
        }

        mHandler.removeCallbacks(mTick);
        mHandler.postDelayed(mTick, 1000);
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        mHandler.removeCallbacks(mTick);
        sRunning = false;
        sInstance = null;
        super.onDestroy();
    }

    private void updateNotification() {
        NotificationManager nm =
                (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        nm.notify(NOTIF_ID, buildNotification());
    }

    private Notification buildNotification() {
        String phase = sIsFocus ? "专注中" : "休息中";
        String when = sPaused ? "已暂停 · " : "";
        int sec = Math.max(0, sRemainSec);
        String time = String.format("%02d:%02d", sec / 60, sec % 60);

        Intent openApp = new Intent(this, MainActivity.class)
                .setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pOpen = PendingIntent.getActivity(
                this, 1, openApp,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        Intent iToggle = new Intent(this, FgsActionReceiver.class)
                .setAction(FgsActionReceiver.ACTION_TOGGLE);
        PendingIntent pToggle = PendingIntent.getBroadcast(
                this, 2, iToggle,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        Intent iStop = new Intent(this, FgsActionReceiver.class)
                .setAction(FgsActionReceiver.ACTION_STOP);
        PendingIntent pStop = PendingIntent.getBroadcast(
                this, 3, iStop,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        return new NotificationCompat.Builder(this, CHANNEL_FGS)
                .setSmallIcon(R.drawable.ic_stat_icon)
                .setContentTitle(phase + " " + time)
                .setContentText(sPaused ? "已暂停，点继续接着专注" : "保持专注，点开可查看详情")
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setContentIntent(pOpen)
                .addAction(new NotificationCompat.Action(
                        0, sPaused ? "继续" : "暂停", pToggle))
                .addAction(new NotificationCompat.Action(0, "结束", pStop))
                .build();
    }

    static void createChannel(Context ctx) {
        NotificationManager nm =
                (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null || Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationChannel ch = new NotificationChannel(
                CHANNEL_FGS, "专注倒计时",
                NotificationManager.IMPORTANCE_LOW);   // 低优先级不响不震不打扰
        ch.setDescription("专注进行时的常驻倒计时");
        ch.setShowBadge(false);
        nm.createNotificationChannel(ch);
    }
}
