@echo off
setlocal
title DAYU preview rotation v2 signing - press key when ready
cd /d "D:\OpenHarmony\competition\evidence\2026-10-25-dayu-preview-rotation-candidate"
set JAVA="D:\DevEcoStudio\DevEco Studio\jbr\bin\java.exe"
set SIGNTOOL="D:\DevEcoStudio\DevEco Studio\sdk\default\openharmony\toolchains\lib\hap-sign-tool.jar"
set KEYSTORE="D:\DevEcoStudio\DevEco Studio\sdk\default\openharmony\toolchains\lib\OpenHarmony.p12"
set APPCHAIN="D:\OpenHarmony\competition\northbound\signing\app-chain.pem"
set PROFILE="D:\OpenHarmony\competition\northbound\signing\final-profile.p7b"
echo READY. Click this window, press any key to START, then type passwords.
pause >nul
%JAVA% -jar %SIGNTOOL% sign-app -keyAlias "openharmony application release" -signAlg "SHA256withECDSA" -mode "localSign" -appCertFile %APPCHAIN% -profileFile %PROFILE% -inFile "dayu-preview-rotation0-commentcorrected-2026-10-25-unsigned.hap" -keystoreFile %KEYSTORE% -outFile "dayu-preview-rotation0-commentcorrected-2026-10-25-signed.hap" -pwdInputMode 1
echo.
echo [sign-app exit code = %ERRORLEVEL%]
if exist "dayu-preview-rotation0-commentcorrected-2026-10-25-signed.hap" echo [signed HAP exists]
pause
