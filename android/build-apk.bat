@echo off
rem Rebuild the S-remote Android app.
rem Toolchain lives in C:\Users\User\android-dev (portable JDK 17 + SDK + Gradle).
set JAVA_HOME=C:\Users\User\android-dev\tools\jdk-17.0.20.1+1
set ANDROID_HOME=C:\Users\User\android-dev\sdk
C:\Users\User\android-dev\tools\gradle-8.9\bin\gradle assembleRelease assembleDebug --no-daemon
echo.
echo release: app\build\outputs\apk\release\app-release.apk
echo debug:   app\build\outputs\apk\debug\app-debug.apk
