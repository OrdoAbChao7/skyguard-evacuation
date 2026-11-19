/**
 * 实时流测试夹具：生成一段真实视频，并通过本机 HTTP 服务暴露为网络流。
 *
 * 这不是 RTSP 摄像头，但走的是与实时流相同的 OpenCV/FFmpeg 网络解码路径；
 * 测试结论只能说明“网络流解码 + 推理链路可用”，不能说明真实 RTSP 摄像机已验证。
 */
import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const VIDEO_GENERATOR = `
import sys
import cv2
import numpy as np

out = sys.argv[1]
width, height, fps, frames = 320, 180, 25, 60
writer = cv2.VideoWriter(out, cv2.VideoWriter_fourcc(*'MJPG'), fps, (width, height))
if not writer.isOpened():
    print('writer_failed')
    sys.exit(3)
background = np.full((height, width, 3), 90, dtype=np.uint8)
for i in range(frames):
    frame = background.copy()
    for k, (x0, y0) in enumerate([(40, 40), (160, 80)]):
        x = x0 + int(30 * np.sin((i + k * 7) / 8.0))
        cv2.rectangle(frame, (x, y0), (x + 35, y0 + 80), (235, 235, 235), -1)
    writer.write(frame)
writer.release()
print('ok')
`;

export function makeTempStreamVideo(): { dir: string; videoPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skyguard-stream-'));
  const scriptPath = path.join(dir, 'generate.py');
  const videoPath = path.join(dir, 'crowd.avi');
  fs.writeFileSync(scriptPath, VIDEO_GENERATOR, 'utf8');
  execFileSync(process.env.SKYGUARD_PYTHON || 'python', ['-I', scriptPath, videoPath], { windowsHide: true });
  return { dir, videoPath };
}

export async function serveVideo(videoPath: string): Promise<{ url: string; close: () => Promise<void> }> {
  const stat = fs.statSync(videoPath);
  const server: Server = createServer((req, res) => {
    const range = req.headers.range;
    if (range) {
      const match = /bytes=(\d+)-(\d*)/.exec(range);
      const start = Number(match?.[1] ?? 0);
      const end = match?.[2] ? Number(match[2]) : stat.size - 1;
      if (!Number.isFinite(start) || start >= stat.size || end < start) {
        res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
        res.end();
        return;
      }
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
        'Content-Type': 'video/x-msvideo',
      });
      fs.createReadStream(videoPath, { start, end }).pipe(res);
      return;
    }
    res.writeHead(200, {
      'Content-Length': stat.size,
      'Content-Type': 'video/x-msvideo',
      'Accept-Ranges': 'bytes',
    });
    fs.createReadStream(videoPath).pipe(res);
  });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('video server did not expose a port');

  return {
    url: `http://127.0.0.1:${address.port}/crowd.avi`,
    close: async () => {
      server.closeAllConnections?.();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}
