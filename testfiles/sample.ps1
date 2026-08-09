# A PowerShell script.
<#
  Block comments here are <# … #>, which the lexer carries across lines.
#>
param(
  [string]$Root = ".",
  [switch]$Recurse
)

$ErrorActionPreference = "Stop"
$count = 0

function Get-Markdown {
  param([string]$Path)
  Get-ChildItem -Path $Path -Filter *.md -Recurse:$Recurse
}

foreach ($file in Get-Markdown -Path $Root) {
  Write-Host "found $($file.Name)"
  $count++
}

Write-Host "total: $count"
