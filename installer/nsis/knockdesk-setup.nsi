; KnockDesk offline installer (NSIS 3, per-user, no admin required).
; Built by scripts/build-nsis-installer.ps1 which stages files and calls makensis.
; Unsigned builds install with a Windows SmartScreen warning until a production
; certificate is configured (see sign-release.ps1 and docs/STORE_SUBMISSION.md).

!define APP_NAME "KnockDesk"
!define APP_PUBLISHER "OpKnock"
!define APP_VERSION "3.1.12"
!define APP_VERSION_DISPLAY "3.1.12-local"
!define APP_EXE "KnockDesk.exe"
!define APP_ICON_FILE "KnockDesk.ico"
!define INSTALLER_OUT "..\..\dist\KnockDesk-Setup-3.1.12-x64.exe"
; Staging path is passed via /D from build-nsis-installer.ps1 (short TEMP path
; to avoid Windows MAX_PATH on deeply nested Python venv files).
!ifndef STAGE_DIR
  !define STAGE_DIR "..\..\staging\nsis-stage"
!endif
!define LICENSE_FILE "..\..\LICENSE"
!define APP_ICON "..\..\staging\nsis-assets\install.ico"

Name "${APP_NAME} ${APP_VERSION_DISPLAY}"
OutFile "${INSTALLER_OUT}"
InstallDir "$LOCALAPPDATA\KnockDesk"
InstallDirRegKey HKCU "Software\OpKnock\KnockDesk" "InstallDir"
RequestExecutionLevel user
; Non-solid: NSIS has a ~2GB datablock limit; 2.6GB payload requires
; per-file compression (slightly larger output, but fits).
SetCompressor lzma
XPStyle on
Icon "${APP_ICON}"
UninstallIcon "${APP_ICON}"
VIProductVersion "${APP_VERSION}.0"
VIAddVersionKey "ProductName" "${APP_NAME}"
VIAddVersionKey "CompanyName" "${APP_PUBLISHER}"
VIAddVersionKey "LegalCopyright" "Copyright (c) 2026 OpKnock"
VIAddVersionKey "FileDescription" "${APP_NAME} Setup"
VIAddVersionKey "FileVersion" "${APP_VERSION}.0"
VIAddVersionKey "ProductVersion" "${APP_VERSION}.0"

!include "MUI2.nsh"
!insertmacro MUI_PAGE_LICENSE "${LICENSE_FILE}"
!insertmacro MUI_PAGE_COMPONENTS
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Section "!${APP_NAME} application (required)" SEC_APP
  SectionIn RO
  SetOutPath "$INSTDIR"
  ; Stop a running instance so files can be replaced (upgrade path).
  nsExec::ExecToStack 'taskkill /F /IM ${APP_EXE}'
  Pop $0
  Pop $1
  File /r "${STAGE_DIR}\*.*"
  WriteRegStr HKCU "Software\OpKnock\KnockDesk" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "Software\OpKnock\KnockDesk" "Version" "${APP_VERSION_DISPLAY}"
  WriteUninstaller "$INSTDIR\Uninstall KnockDesk.exe"
  ; App Paths: Win+R + Settings integration without admin.
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\App Paths\${APP_EXE}" "" "$INSTDIR\${APP_EXE}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\App Paths\${APP_EXE}" "Path" "$INSTDIR"
  ; Installed-apps (Add/Remove Programs) registration, per-user.
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\KnockDesk" "DisplayName" "${APP_NAME} ${APP_VERSION_DISPLAY}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\KnockDesk" "DisplayVersion" "${APP_VERSION_DISPLAY}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\KnockDesk" "Publisher" "${APP_PUBLISHER}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\KnockDesk" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\KnockDesk" "UninstallString" "$INSTDIR\Uninstall KnockDesk.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\KnockDesk" "QuietUninstallString" "$INSTDIR\Uninstall KnockDesk.exe /S"
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\KnockDesk" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\KnockDesk" "NoRepair" 1
SectionEnd

Section "Desktop shortcut" SEC_DESKTOP
  ; Icon from the shipped .ico, not the exe: KnockDesk.exe is ~190 MB and the
  ; shell's icon extraction times out on it, leaving a blank shortcut icon.
  CreateShortcut "$DESKTOP\${APP_NAME}.lnk" "$INSTDIR\${APP_EXE}" "" "$INSTDIR\${APP_ICON_FILE}" 0
SectionEnd

Section "-Start Menu shortcuts"
  ; A previous developer install left a shortcut directly in the group (not
  ; inside an app folder) pointing at the repo checkout. Windows sorts it
  ; above the folder entry, so launching "KnockDesk" from Search hit the dev
  ; build and got its idle-burn behaviour. Remove the stale root-level
  ; shortcut so there is exactly one, unambiguous entry for the app.
  Delete "$SMPROGRAMS\${APP_NAME}.lnk"
  CreateDirectory "$SMPROGRAMS\${APP_NAME}"
  CreateShortcut "$SMPROGRAMS\${APP_NAME}\${APP_NAME}.lnk" "$INSTDIR\${APP_EXE}" "" "$INSTDIR\${APP_ICON_FILE}" 0
  CreateShortcut "$SMPROGRAMS\${APP_NAME}\Uninstall ${APP_NAME}.lnk" "$INSTDIR\Uninstall KnockDesk.exe" "" "$INSTDIR\${APP_ICON_FILE}" 0
SectionEnd

Section "Uninstall"
  nsExec::ExecToStack 'taskkill /F /IM ${APP_EXE}'
  Pop $0
  Pop $1
  RMDir /r "$INSTDIR"
  RMDir /r "$SMPROGRAMS\${APP_NAME}"
  ; The stale root-level shortcut from the old dev install lives here too.
  Delete "$SMPROGRAMS\${APP_NAME}.lnk"
  Delete "$DESKTOP\${APP_NAME}.lnk"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\KnockDesk"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\App Paths\${APP_EXE}"
  DeleteRegKey HKCU "Software\OpKnock\KnockDesk"
  ; User data (%APPDATA%\knockdesk) is deliberately preserved.
SectionEnd
