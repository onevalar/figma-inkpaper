// Test-only JPEG decoder using Python/Pillow (the plugin uses the browser's native decoder).
import { execFileSync } from 'child_process';
export async function decodeJpegNode(bytes) {
  const out = execFileSync('python3', ['-c', `
import sys, io
from PIL import Image
im = Image.open(io.BytesIO(sys.stdin.buffer.read()))
if im.mode not in ('L', 'RGB', 'CMYK'): im = im.convert('RGB')
sys.stdout.buffer.write(f"{im.width} {im.height} {len(im.getbands())}\\n".encode())
sys.stdout.buffer.write(im.tobytes())
`], { input: Buffer.from(bytes), maxBuffer: 1 << 30 });
  const nl = out.indexOf(10);
  const [w, h, comps] = out.subarray(0, nl).toString().split(' ').map(Number);
  return { w, h, comps, data: new Uint8Array(out.subarray(nl + 1)) };
}

// Test-only PNG decoder → RGBA.
export async function decodePngNode(bytes) {
  const out = execFileSync('python3', ['-c', `
import sys, io
from PIL import Image
im = Image.open(io.BytesIO(sys.stdin.buffer.read())).convert('RGBA')
sys.stdout.buffer.write(f"{im.width} {im.height}\\n".encode())
sys.stdout.buffer.write(im.tobytes())
`], { input: Buffer.from(bytes), maxBuffer: 1 << 30 });
  const nl = out.indexOf(10);
  const [w, h] = out.subarray(0, nl).toString().split(' ').map(Number);
  return { w, h, comps: 4, data: new Uint8Array(out.subarray(nl + 1)) };
}
