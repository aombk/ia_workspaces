# Builds the Inno Setup wizard images from the README screenshots.
#
#   installer/assets/wizard-welcome.bmp   first page
#   installer/assets/wizard-finish.bmp    last page
#
# Both are committed, the way the icons are: the installer must build on a
# machine that has Inno Setup and nothing else, and this script is Windows-only
# because it decodes PNG through System.Drawing. Re-run it when the screenshots
# it reads are re-taken.
#
#   powershell -ExecutionPolicy Bypass -File tools\make-installer-images.ps1
#
# BMP because that is what Inno's wizard takes - `TBitmap.LoadFromFile` does not
# read PNG, and the [Code] section loads these at runtime to put the same image
# on the finish page as on the welcome one.
#
# The slot is tall and narrow (164x314 at 100% scaling), so a whole window shot
# scaled into it would be a smear. Each source is *cropped* to the slot's aspect
# first, and the crop is chosen per image below rather than centred blindly.

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$shots = Join-Path $root 'docs\screenshots'
$out = Join-Path $root 'installer\assets'
New-Item -ItemType Directory -Force -Path $out | Out-Null

# 2x the wizard's 164x314, so it stays sharp on a high-DPI display. Inno scales
# it down from here; going further costs a megabyte per image for pixels the
# slot never shows.
$targetW = 328
$targetH = 628
$aspect = $targetW / $targetH

# Both pages come from the same shot of the whole window, cropped differently:
# the left edge is the workspace rail and the file tree, the middle is the file
# open in the editor. One picture, two halves of what the app is - and not the
# same image twice, which is what using one crop on both pages would look like.
#
# Not the right edge, which was tried: that side of the window is the editor's
# blank margin, and a wizard page carrying 800x1500 pixels of empty background
# looks like an image that failed to load.
$jobs = @(
    @{ src = 'main.png'; out = 'wizard-welcome.bmp'; align = 'left' }
    @{ src = 'main.png'; out = 'wizard-finish.bmp';  align = 'center' }
)

foreach ($job in $jobs) {
    $srcPath = Join-Path $shots $job.src
    if (-not (Test-Path $srcPath)) {
        Write-Warning "missing $($job.src) - skipped"
        continue
    }

    $img = [System.Drawing.Image]::FromFile($srcPath)
    try {
        # The tallest crop of the right shape that the source can give.
        $cropH = $img.Height
        $cropW = [int][Math]::Round($cropH * $aspect)
        if ($cropW -gt $img.Width) {
            $cropW = $img.Width
            $cropH = [int][Math]::Round($cropW / $aspect)
        }

        $x = switch ($job.align) {
            'left'  { 0 }
            'right' { $img.Width - $cropW }
            default { [int](($img.Width - $cropW) / 2) }
        }
        $y = [int](($img.Height - $cropH) / 2)

        $bmp = New-Object System.Drawing.Bitmap($targetW, $targetH)
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        try {
            $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
            $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
            $g.DrawImage($img,
                (New-Object System.Drawing.Rectangle(0, 0, $targetW, $targetH)),
                (New-Object System.Drawing.Rectangle($x, $y, $cropW, $cropH)),
                [System.Drawing.GraphicsUnit]::Pixel)
        } finally {
            $g.Dispose()
        }

        $dest = Join-Path $out $job.out
        # 24-bit, uncompressed: Inno reads a plain BMP and nothing cleverer.
        $bmp.Save($dest, [System.Drawing.Imaging.ImageFormat]::Bmp)
        $bmp.Dispose()

        $kb = [int]((Get-Item $dest).Length / 1KB)
        Write-Host ("  {0,-22} from {1}  crop {2}x{3} at {4},{5}  {6} KB" -f `
            $job.out, $job.src, $cropW, $cropH, $x, $y, $kb)
    } finally {
        $img.Dispose()
    }
}

Write-Host ''
Write-Host 'Wizard images written to installer\assets\'
