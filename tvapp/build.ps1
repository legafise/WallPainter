# Builds WallPaint.apk without Gradle.
# Android SDK: $env:ANDROID_HOME (default D:\Android\sdk); JDK 17: $env:JAVA_HOME.
$ErrorActionPreference = 'Stop'
$sdk = if ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { 'D:\Android\sdk' }
$bt = "$sdk\build-tools\36.0.0"
$jar = "$sdk\platforms\android-36\android.jar"
$jdk = if ($env:JAVA_HOME) { "$env:JAVA_HOME\bin" } else { 'C:\Program Files\Java\jdk-17\bin' }
$here = $PSScriptRoot
$out = "$here\build"

Remove-Item -Recurse -Force $out -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force "$out\classes", "$out\dex", "$out\res" | Out-Null

& "$bt\aapt2.exe" compile --dir "$here\res" -o "$out\res\res.zip"; if ($LASTEXITCODE) { throw 'aapt2 compile failed' }
& "$bt\aapt2.exe" link -o "$out\unsigned.apk" -I $jar --manifest "$here\AndroidManifest.xml" -A "$here\assets" "$out\res\res.zip" --java "$out\gen" --min-sdk-version 21 --target-sdk-version 34
if ($LASTEXITCODE) { throw 'aapt2 link failed' }

$src = Get-ChildItem -Recurse "$here\src", "$out\gen" -Filter *.java | ForEach-Object FullName
& "$jdk\javac.exe" -encoding UTF-8 -source 8 -target 8 -bootclasspath $jar -nowarn -Xlint:-options -d "$out\classes" @src
if ($LASTEXITCODE) { throw 'javac failed' }

$classes = Get-ChildItem -Recurse "$out\classes" -Filter *.class | ForEach-Object FullName
& "$bt\d8.bat" --min-api 21 --lib $jar --output "$out\dex" @classes
if ($LASTEXITCODE) { throw 'd8 failed' }

Push-Location "$out\dex"; & "$jdk\jar.exe" uf "$out\unsigned.apk" classes.dex; Pop-Location
& "$bt\zipalign.exe" -f -p 4 "$out\unsigned.apk" "$out\aligned.apk"; if ($LASTEXITCODE) { throw 'zipalign failed' }

$ks = "$here\debug.keystore"
if (-not (Test-Path $ks)) {
  & "$jdk\keytool.exe" -genkeypair -keystore $ks -storepass android -keypass android -alias wallpaint `
    -keyalg RSA -keysize 2048 -validity 10000 -dname 'CN=WallPaint' | Out-Null
}
& "$bt\apksigner.bat" sign --ks $ks --ks-pass pass:android --key-pass pass:android --out "$here\WallPaint.apk" "$out\aligned.apk"
if ($LASTEXITCODE) { throw 'apksigner failed' }
Write-Host "OK: $here\WallPaint.apk"

