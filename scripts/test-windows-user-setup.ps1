param(
  [switch]$AsTestUser,
  [string]$NodeExecutable,
  [string]$ArtifactRoot
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path $PSScriptRoot -Parent
Set-Location $repoRoot
if (!$ArtifactRoot) { $ArtifactRoot = Join-Path $repoRoot 'artifacts/windows-user-setup' }
New-Item -ItemType Directory -Force $ArtifactRoot | Out-Null

if ($AsTestUser) {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  $isAdministrator = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  if ($isAdministrator) { throw 'UserSetup acceptance must run under a standard, non-administrator account.' }
  $osInfo = Get-CimInstance Win32_OperatingSystem
  if ($osInfo.Caption -notmatch 'Windows 11') { throw "Expected Windows 11, got $($osInfo.Caption)" }
  $hostArchitecture = $env:PROCESSOR_ARCHITECTURE
  if ($env:PROCESSOR_ARCHITEW6432) { $hostArchitecture = $env:PROCESSOR_ARCHITEW6432 }
  $localAppData = [Environment]::GetFolderPath('LocalApplicationData')
  $env:USERPROFILE = [Environment]::GetFolderPath('UserProfile')
  $env:LOCALAPPDATA = $localAppData
  $env:APPDATA = [Environment]::GetFolderPath('ApplicationData')
  $env:TEMP = Join-Path $localAppData 'Temp'
  $env:TMP = $env:TEMP
  New-Item -ItemType Directory -Force $env:TEMP | Out-Null
  $env:IJSS_E2E_REQUIRE_CDP = '1'
  $env:IJSS_E2E_INSPECTOR_ON_DEMAND = '1'
  $env:IJSS_E2E_EXPECT_USER_SETUP = '1'
  $env:IJSS_E2E_WINDOWS_USER_SETUP_ARTIFACTS = $ArtifactRoot
  $codeExecutable = Join-Path $localAppData 'Programs/Microsoft VS Code/Code.exe'
  $exitCode = 0
  try {
    foreach ($version in @('1.114.0', 'stable')) {
      $installer = Join-Path $ArtifactRoot "VSCodeUserSetup-x64-$version.exe"
      $installLog = Join-Path $ArtifactRoot "installer-$version.log"
      $installation = Start-Process -FilePath $installer -ArgumentList @(
        '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/SP-',
        '/MERGETASKS=!runcode,!desktopicon,!quicklaunchicon', "/LOG=`"$installLog`""
      ) -PassThru -Wait
      if ($installation.ExitCode -ne 0) { throw "UserSetup $version exited $($installation.ExitCode)" }
      if (!(Test-Path $codeExecutable)) { throw "UserSetup did not install Code.exe at $codeExecutable" }
      $env:IJSS_E2E_VSCODE_EXECUTABLE = $codeExecutable
      $env:IJSS_E2E_VSCODE_VERSION = $version
      $env:IJSS_E2E_FILES = 'out/test/suite/desktopCompatibility.test.js'
      $env:IJSS_E2E_GREP = ''
      & $NodeExecutable (Join-Path $repoRoot 'node_modules/@vscode/test-cli/out/bin.mjs')
      if ($LASTEXITCODE -ne 0) { throw "UserSetup $version desktop acceptance failed: $LASTEXITCODE" }
    }
  } catch {
    $exitCode = 1
    Write-Error $_ -ErrorAction Continue
  } finally {
    @{ exitCode = $exitCode; user = $identity.Name; administrator = $isAdministrator;
       os = $osInfo.Caption; osBuild = $osInfo.BuildNumber; executable = $codeExecutable;
       hostArchitecture = $hostArchitecture } |
      ConvertTo-Json | Set-Content (Join-Path $ArtifactRoot 'standard-user-result.json') -Encoding UTF8
  }
  exit $exitCode
}

if (!$env:GITHUB_ACTIONS) { throw 'This script creates an ephemeral account and is intended for GitHub-hosted CI only.' }
if (!$NodeExecutable) { $NodeExecutable = (Get-Command node).Source }
$downloads = @()
foreach ($version in @('1.114.0', 'stable')) {
  $installer = Join-Path $ArtifactRoot "VSCodeUserSetup-x64-$version.exe"
  $updateVersion = $version
  if ($version -eq 'stable') { $updateVersion = 'latest' }
  $url = "https://update.code.visualstudio.com/$updateVersion/win32-x64-user/stable"
  Invoke-WebRequest -Uri $url -OutFile $installer
  $signature = Get-AuthenticodeSignature $installer
  if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'Microsoft Corporation') {
    throw "The downloaded UserSetup $version does not have a valid Microsoft signature."
  }
  $downloads += @{ version = $version; url = $url; sha256 = (Get-FileHash $installer -Algorithm SHA256).Hash;
    signature = $signature.Status.ToString() }
  ConvertTo-Json -InputObject $downloads | Set-Content (Join-Path $ArtifactRoot 'installer-downloads.json') -Encoding UTF8
}
$accountName = 'ijss-user-setup'
$passwordText = 'Ijss!' + [Guid]::NewGuid().ToString('N') + '9'
$password = ConvertTo-SecureString $passwordText -AsPlainText -Force
$credential = [PSCredential]::new("$env:COMPUTERNAME\$accountName", $password)
$account = New-LocalUser -Name $accountName -Password $password -AccountNeverExpires -PasswordNeverExpires
try {
  Add-LocalGroupMember -SID 'S-1-5-32-545' -Member $account
  $acl = Get-Acl $repoRoot
  $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
    $account.SID, 'Modify', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
  Set-Acl $repoRoot $acl
  Start-Service seclogon
  $child = Start-Process -FilePath "$env:SystemRoot/System32/WindowsPowerShell/v1.0/powershell.exe" -Credential $credential `
    -LoadUserProfile -WorkingDirectory $repoRoot -ArgumentList @(
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"", '-AsTestUser',
      '-NodeExecutable', "`"$NodeExecutable`"", '-ArtifactRoot', "`"$ArtifactRoot`""
    ) -RedirectStandardOutput (Join-Path $ArtifactRoot 'acceptance.stdout.log') `
      -RedirectStandardError (Join-Path $ArtifactRoot 'acceptance.stderr.log') -PassThru -Wait
  $resultPath = Join-Path $ArtifactRoot 'standard-user-result.json'
  if (!(Test-Path $resultPath)) { throw "The standard-user test did not write its result (process exit $($child.ExitCode))." }
  $result = Get-Content $resultPath -Raw | ConvertFrom-Json
  $result | ConvertTo-Json | Write-Output
  if ($result.exitCode -ne 0 -or $child.ExitCode -ne 0) { throw 'Windows 11 standard-user UserSetup acceptance failed.' }
} finally {
  Remove-LocalUser -Name $accountName
}
