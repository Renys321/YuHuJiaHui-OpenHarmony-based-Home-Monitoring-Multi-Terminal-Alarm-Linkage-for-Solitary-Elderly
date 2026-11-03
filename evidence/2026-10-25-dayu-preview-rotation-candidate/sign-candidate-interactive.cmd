@echo off
setlocal
title DAYU preview rotation candidate signing (hidden password)
cd /d "D:\OpenHarmony\competition\evidence\2026-10-25-dayu-preview-rotation-candidate"
set JAVA="D:\DevEcoStudio\DevEco Studio\jbr\bin\java.exe"
set SIGNTOOL="D:\DevEcoStudio\DevEco Studio\sdk\default\openharmony\toolchains\lib\hap-sign-tool.jar"
set KEYSTORE="D:\DevEcoStudio\DevEco Studio\sdk\default\openharmony\toolchains\lib\OpenHarmony.p12"
set APPCHAIN="D:\OpenHarmony\competition\northbound\signing\app-chain.pem"
set PROFILE="D:\OpenHarmony\competition\northbound\signing\final-profile.p7b"
echo ============================================================
echo  Signing DAYU preview rotation candidate.
echo  Type the SDK keystore/key password in this window when asked.
echo  Input is hidden; it is not written to argv/env/script/log.
echo ============================================================
%JAVA% -jar %SIGNTOOL% sign-app -keyAlias "openharmony application release" -signAlg "SHA256withECDSA" -mode "localSign" -appCertFile %APPCHAIN% -profileFile %PROFILE% -inFile "dayu-preview-rotation0-2026-10-25-unsigned.hap" -keystoreFile %KEYSTORE% -outFile "dayu-preview-rotation0-2026-10-25-signed.hap" -pwdInputMode 1
echo.
echo [sign-app exit code = %ERRORLEVEL%]
if exist "dayu-preview-rotation0-2026-10-25-signed.hap" echo [signed HAP exists]
pause
