param(
  [Parameter(Mandatory=$true)][string]$OutputDirectory,
  [string]$JavaDirectory = 'C:\Program Files\Android\Android Studio\jbr\bin',
  [string]$GradleCache = "$env:USERPROFILE\.gradle\caches\modules-2\files-2.1"
)
$ErrorActionPreference = 'Stop'
function Jar([string]$relative) {
  $result = Get-ChildItem -LiteralPath (Join-Path $GradleCache $relative) -Recurse -Filter '*.jar' | Select-Object -First 1 -ExpandProperty FullName
  if (!$result) { throw "Missing cached dependency: $relative" }
  return $result
}
$compiler = Jar 'org.jetbrains.kotlin\kotlin-compiler-embeddable\2.1.20'
$stdlib = Jar 'org.jetbrains.kotlin\kotlin-stdlib\2.1.20'
$reflect = Jar 'org.jetbrains.kotlin\kotlin-reflect\2.1.20'
$coroutines = Jar 'org.jetbrains.kotlinx\kotlinx-coroutines-core-jvm\1.8.0'
$trove = Jar 'org.jetbrains.intellij.deps\trove4j\1.0.20200330'
$annotations = Jar 'org.jetbrains\annotations\13.0'
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$source = Join-Path $PSScriptRoot '..\modules\salcara-notify\android\kotlin\SalcaraNotificationPolicy.kt'
$fixture = Join-Path $PSScriptRoot 'native-notification-policy-tests\Contract.kt'
& (Join-Path $JavaDirectory 'java.exe') '-Xmx512m' '-cp' "$compiler;$stdlib;$reflect;$trove;$annotations;$coroutines" org.jetbrains.kotlin.cli.jvm.K2JVMCompiler -no-stdlib -no-reflect -classpath "$stdlib;$annotations" -d $OutputDirectory $source $fixture
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& (Join-Path $JavaDirectory 'java.exe') '-cp' "$OutputDirectory;$stdlib" expo.modules.salcaranotify.ContractKt
exit $LASTEXITCODE
