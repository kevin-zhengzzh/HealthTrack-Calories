<#
.SYNOPSIS
  Simulates a camera + scale device: uploads a food photo and its weight to the
  Food Log, exactly as the Stack-chan firmware does.

.EXAMPLE
  ./send-meal.ps1 -Key hk_xxxxx -Image ./banana.jpg -Weight 120
  ./send-meal.ps1 -Key hk_xxxxx -Image ./rice.jpg -Weight 250 -Api https://my-backend.example.com
#>
param(
  [Parameter(Mandatory)] [string] $Key,      # from Food Log > Devices > Pair device
  [Parameter(Mandatory)] [string] $Image,    # JPEG/PNG/WebP, max 2MB
  [Parameter(Mandatory)] [double] $Weight,   # grams, food only (scale tared with the plate on it)
  [string] $Api = 'http://localhost:5000'
)

$ErrorActionPreference = 'Stop'
$type = switch ([IO.Path]::GetExtension($Image).ToLowerInvariant()) {
  '.png'  { 'image/png' }
  '.webp' { 'image/webp' }
  default { 'image/jpeg' }
}
$today = Get-Date -Format 'yyyy-MM-dd'

# curl.exe ships with Windows 10+; -F builds the same multipart body the firmware sends
curl.exe -sS -X POST "$Api/api/intake/device" `
  -H "X-Device-Key: $Key" `
  -F "image=@$Image;type=$type" `
  -F "weightGrams=$Weight" `
  -F "localDate=$today"
Write-Host ''
