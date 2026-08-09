; ia_workspaces — Windows Installer (Inno Setup 6.6+ / 7)
; by iraisynn attinom — https://iraisynn.attinom.net/
;
; Invoked by build_windows.bat via ISCC.exe. Version is passed on the command
; line (/DMyAppVersion=x.y.z). Expects electron-builder's unpacked tree at:
;   out\electron-pack\win-unpacked\
; which is what the `dir` target produces alongside the portable exe.
;
; The portable build is still the headline artifact: one file, no install, runs
; from a stick. This is the other half of that trade — a stable path, a Start
; Menu entry that survives, an uninstaller, and a place Windows can find the app
; to launch it. Neither replaces the other.

#ifndef MyAppVersion
  #define MyAppVersion "0.0.0"
#endif

#define MyAppName        "ia_workspaces"
#define MyAppPublisher   "iraisynn attinom"
#define MyAppURL         "https://iraisynn.attinom.net"
#define MyAppExeName     "ia_workspaces.exe"
; Unique to ia_workspaces — must NOT match any other product's installer GUID,
; or Inno would reuse that product's stored install directory.
#define MyAppId          "{{6F2A9C41-58D7-4E3B-A1C8-2D9B7E4F0A63}"
#define MySourceDir      "..\out\electron-pack\win-unpacked"

[Setup]
AppId={#MyAppId}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppVerName={#MyAppName} {#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}
AppUpdatesURL={#MyAppURL}

; Where it lands. `{autopf}` resolves to Program Files for an all-users install
; and to %LOCALAPPDATA%\Programs for a per-user one, so one line covers both and
; the publisher folder groups this with the rest of the range either way.
DefaultDirName={autopf}\iraisynn_attinom\{#MyAppName}
DefaultGroupName=iraisynn attinom

; The directory page stays: this is an app, not a plug-in that has to live at a
; path the host dictates, so where it goes is the user's business. A previous
; install's directory is reused, which is what makes an upgrade land on top of
; itself instead of beside it.
DisableDirPage=no
DisableProgramGroupPage=yes
DisableWelcomePage=no

; An upgrade defaults to the mode the previous install used, so someone who
; installed for themselves is not quietly offered an all-users install that
; would land a second copy beside the first under a different root.
UsePreviousPrivileges=yes
UsePreviousAppDir=yes

; Per-user by default — no admin prompt, and an app that writes its own Start
; Menu shortcut and CLI shim on launch has no need of Program Files. Choosing
; all-users is one radio button away on the first page, and that is the whole
; reason for `dialog` rather than a fixed value.
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog

OutputDir=..\out\installer
OutputBaseFilename=ia_workspaces-setup
Compression=lzma2/max
SolidCompression=yes
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
; Electron 43 requires Windows 10 or later. Without this, setup completes on an
; older Windows and the app fails to start with nothing to explain why.
MinVersion=10.0

; Offer to close a running copy rather than failing on a locked exe, and to
; restart it afterwards. Detected from the files themselves rather than from a
; named mutex: Electron's single-instance lock is a socket, not something
; `AppMutex` could watch for.
CloseApplications=yes
RestartApplications=yes

; "dynamic" makes the wizard follow the machine's light/dark setting; "modern"
; stays the base style. The system setting is read once at startup, so toggling
; Windows themes mid-install does not restyle a running wizard.
;
; Only the chrome follows the theme — the two images below are the app's own
; dark window and are pinned in [Code], identical in both modes.
WizardStyle=modern dynamic
; The welcome page image. [Code] loads it again at runtime so the finish page
; can be given a different one, and forces Stretch so a tall shot scales into
; the slot whatever the DPI.
WizardImageFile=assets\wizard-welcome.bmp
WizardImageStretch=yes
SetupIconFile=..\packaging\icons\icon.ico
UninstallDisplayName={#MyAppName}
UninstallDisplayIcon={app}\{#MyAppExeName}
LicenseFile=..\LICENSE

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[InstallDelete]
; Cleared before the new version is written, because Inno overwrites what it is
; given and removes nothing else — so a file that existed in the old build and
; not in the new one would survive an upgrade forever. Both of these are ours
; entirely and are rewritten in full, which is what makes deleting them safe:
; `resources` holds the asar, `locales` an Electron .pak per language, and a
; leftover from an older Electron is at best dead weight and at worst loaded.
Type: filesandordirs; Name: "{app}\resources"
Type: filesandordirs; Name: "{app}\locales"

[Files]
; The whole unpacked tree. `recursesubdirs createallsubdirs` is what carries
; locales\, resources\ and the unpacked node-pty binary — the app is not one
; file, and a partial copy of it starts and then fails at the first shell.
Source: "{#MySourceDir}\*"; DestDir: "{app}"; \
    Flags: ignoreversion recursesubdirs createallsubdirs
; Wizard images, extracted to {tmp} and loaded at runtime in [Code] rather than
; installed. Must be BMP: `TBitmap.LoadFromFile` does not read PNG, which is why
; tools\make-installer-images.ps1 exists — the sources are the README's own
; screenshots, cropped to the slot's shape.
Source: "assets\wizard-welcome.bmp"; Flags: dontcopy
Source: "assets\wizard-finish.bmp"; Flags: dontcopy

[Icons]
; `AppUserModelID` is what makes clicking a notification land on the pane that
; raised it. Windows attributes a toast to an *identity*, and only recognises
; one that a Start Menu shortcut carries — so the shortcut has to declare it, or
; the toast appears and the click goes nowhere. The app writes its own shortcut
; when it cannot find one carrying this id, which is how the portable build
; manages the same trick; with this here, an installed build finds it and leaves
; the Start Menu alone rather than adding a second entry beside this one.
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; \
    AppUserModelID: "dev.iaworkspaces.terminal"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; \
    AppUserModelID: "dev.iaworkspaces.terminal"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "{cm:LaunchProgram,{#MyAppName}}"; \
    Flags: nowait postinstall skipifsilent

[UninstallDelete]
; Electron writes these next to the app on first run. Left behind, they make an
; "uninstalled" folder that is not empty, which reads as a failed uninstall.
Type: filesandordirs; Name: "{app}\locales"
Type: filesandordirs; Name: "{app}\resources"
Type: dirifempty; Name: "{app}"
Type: dirifempty; Name: "{autopf}\iraisynn_attinom"

[Messages]
WelcomeLabel2=This will install [name/ver] on your computer.%n%nWorkspaces, settings and themes are kept in your user profile, not here — uninstalling later leaves them alone, and installing over an existing copy keeps them.

FinishedHeadingLabel=ia_workspaces is installed
FinishedLabel=Your workspaces, tabs and panes come back the way you left them.
FinishedLabelNoIcons=Your workspaces, tabs and panes come back the way you left them.

[Code]
// Both wizard images are loaded from {tmp} at runtime.
// WizardBitmapImage is the welcome page, WizardBitmapImage2 the finish page —
// two crops of the same screenshot of the app: the workspace rail and file tree
// to open with, the editor to close on.
procedure InitializeWizard();
begin
  ExtractTemporaryFile('wizard-welcome.bmp');
  ExtractTemporaryFile('wizard-finish.bmp');
  WizardForm.WizardBitmapImage.Stretch := True;
  WizardForm.WizardBitmapImage.Bitmap.LoadFromFile(
    ExpandConstant('{tmp}\wizard-welcome.bmp'));
  WizardForm.WizardBitmapImage2.Stretch := True;
  WizardForm.WizardBitmapImage2.Bitmap.LoadFromFile(
    ExpandConstant('{tmp}\wizard-finish.bmp'));
end;

// The app keeps everything it remembers — workspaces, settings, themes,
// scrollback — in %APPDATA%\ia_workspaces, deliberately outside the program
// directory so that reinstalling, moving or deleting it cannot cost you a
// layout. The uninstaller therefore offers to remove that data rather than
// doing so quietly: someone uninstalling to reinstall elsewhere wants it kept,
// someone finished with the app wants it gone, and only they know which.
//
// Line comments, not brace comments: in a .iss file a `}` inside `{ ... }`
// closes the comment, and every Inno constant is written `{app}`.
function InitializeUninstall(): Boolean;
var
  DataDir: String;
begin
  Result := True;
  DataDir := ExpandConstant('{userappdata}\ia_workspaces');
  if DirExists(DataDir) then
  begin
    if MsgBox('Also delete your workspaces, settings and themes?' + #13#10 + #13#10 +
              DataDir + #13#10 + #13#10 +
              'Choose No to keep them for a future install.',
              mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = IDYES then
      DelTree(DataDir, True, True, True);
  end;
end;
