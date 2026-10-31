/**
 * Build an .icns bundle from a source PNG.
 *
 * Scaling is done by GDI+ (System.Drawing, always available on Windows);
 * the .icns container is packed here. Sizes: 16, 32, 128, 256, 512 (+1024
 * only if the source is large enough). PNG payloads are accepted by macOS
 * for these type codes:
 *   icp4 = 16, icp5 = 32, ic07 = 128, ic08 = 256, ic09 = 512, ic10 = 1024
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';

function scaleWithGdi(srcPng, outDir, sizes) {
    const script = `
Add-Type -AssemblyName System.Drawing
$src = [System.Drawing.Image]::FromFile('${srcPng.replace(/\\/g, '\\\\')}')
try {
  foreach ($s in @(16, 32, 128, 256, 512, 1024)) {
    if ($src.Width -lt $s) { continue }
    $bmp = New-Object System.Drawing.Bitmap $s, $s
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.Clear([System.Drawing.Color]::Transparent)
    $g.DrawImage($src, 0, 0, $s, $s)
    $bmp.Save((Join-Path '${outDir.replace(/\\/g, '\\\\')}' ("icon_$s.png")), [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose()
  }
} finally { $src.Dispose() }
`;
    execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: 'pipe' });
}

export function buildIcns(srcPng, outIcns) {
    const workDir = join(dirname(outIcns), '.icns-work');
    mkdirSync(workDir, { recursive: true });
    try {
        scaleWithGdi(srcPng, workDir);
        const TYPES = [
            ['icp4', 16],
            ['icp5', 32],
            ['ic07', 128],
            ['ic08', 256],
            ['ic09', 512],
            ['ic10', 1024],
        ];
        const chunks = [Buffer.from('icns', 'ascii')];
        let bodyLength = 8;
        for (const [type, size] of TYPES) {
            const file = join(workDir, `icon_${size}.png`);
            if (!existsSync(file)) continue;
            const png = readFileSync(file);
            const head = Buffer.alloc(8);
            head.write(type, 0, 'ascii');
            head.writeUInt32BE(png.length + 8, 4);
            chunks.push(head, png);
            bodyLength += png.length + 8;
        }
        const container = Buffer.alloc(8);
        container.writeUInt32BE(bodyLength, 4);
        chunks.splice(0, 1, container); // total length in first 8 bytes
        mkdirSync(dirname(outIcns), { recursive: true });
        writeFileSync(outIcns, Buffer.concat(chunks));
        return outIcns;
    } finally {
        rmSync(workDir, { recursive: true, force: true });
    }
}

export default buildIcns;
