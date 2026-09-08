@echo off
REM ============================================================
REM  Pomodoro APK build script
REM
REM  NOTE: this file must stay pure ASCII. cmd.exe reads .bat in the
REM  system ANSI codepage (GBK here), so UTF-8 Chinese text would be
REM  mis-decoded and break command parsing.
REM
REM  Toolchain lives entirely on D:. This script only sets variables
REM  inside its own process; it does not touch system env vars and
REM  redirects the Gradle cache away from C:\Users\<you>\.gradle.
REM
REM  Output: android\app\build\outputs\apk\debug\app-debug.apk
REM ============================================================

set "JAVA_HOME=D:\dev\jdk-21"
set "ANDROID_HOME=D:\dev\android-sdk"
set "ANDROID_SDK_ROOT=D:\dev\android-sdk"
set "GRADLE_USER_HOME=D:\dev\gradle-home"
set "ANDROID_USER_HOME=D:\dev\android-user-home"
set "PATH=%JAVA_HOME%\bin;%PATH%"

cd /d "%~dp0"

echo [1/2] Syncing web assets into the Android project...
call npx cap sync android
if errorlevel 1 goto failed

cd /d "%~dp0android"

echo [2/2] Building debug APK with Gradle...
call gradlew.bat assembleDebug --no-daemon %*
if errorlevel 1 goto failed

echo.
echo ============================================
echo  BUILD OK
echo  APK: %~dp0android\app\build\outputs\apk\debug\app-debug.apk
echo ============================================
exit /b 0

:failed
echo.
echo ============================================
echo  BUILD FAILED - see the error output above
echo ============================================
exit /b 1
