@echo off
title HAP signing - interactive hidden password (pwdInputMode=1)
cd /d D:\OpenHarmony\competition\northbound\signing
echo ============================================================
echo  Signing the rebuilt HAP (keep-screen-on build).
echo  The tool will ask for the key / keystore password.
echo  pwdInputMode=1: input is interactive and hidden,
echo  and never goes into argv, env, scripts or logs.
echo ============================================================
"D:\DevEcoStudio\DevEco Studio\jbr\bin\java.exe" -jar "D:\DevEcoStudio\DevEco Studio\sdk\default\openharmony\toolchains\lib\hap-sign-tool.jar" sign-app -keyAlias "openharmony application release" -signAlg "SHA256withECDSA" -mode "localSign" -appCertFile "D:\OpenHarmony\competition\northbound\signing\app-chain.pem" -profileFile "D:\OpenHarmony\competition\northbound\signing\final-profile.p7b" -inFile "D:\OpenHarmony\competition\northbound\entry\build\default\outputs\default\entry-default-unsigned.hap" -keystoreFile "D:\DevEcoStudio\DevEco Studio\sdk\default\openharmony\toolchains\lib\OpenHarmony.p12" -outFile "D:\OpenHarmony\competition\northbound\signing\eldercare-signed.hap" -pwdInputMode 1
echo.
echo [sign-app exited with code %ERRORLEVEL%]  press any key to close
pause >nul