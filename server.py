#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
NCP-QwenImage 生成器 · 本地网关
================================
- 静态文件服务: ./public (工作台前端)
- API 反向代理: /p?url=<绝对URL>  —— 浏览器同源调用,规避 CORS,透传 Authorization / Content-Type
- Mock 演示模式: WB_MOCK=1 时无需 GPU 服务器即可完整体验界面与流程

用法:
    python3 server.py              # 端口 8300(被占用时自动顺延到 8319)
    WB_MOCK=1 python3 server.py    # Mock 演示模式
    python3 server.py 8400         # 指定端口

仅依赖 Python 3 标准库。
"""
import json
import mimetypes
import os
import random
import struct
import sys
import time
import zlib
import socket
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs, unquote, quote

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PUBLIC_DIR = os.path.join(BASE_DIR, 'public')
MOCK = os.environ.get('WB_MOCK') == '1'
UPSTREAM_TIMEOUT = 1500  # 秒:2048 档编辑最长约 12 分钟

# ---------------------------------------------------------------- Mock:纯标准库画 PNG
_PNG_CACHE = {}


def _png_chunk(tag, data):
    return (struct.pack('>I', len(data)) + tag + data
            + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff))


def make_png(w, h, seed):
    """生成一张确定性的渐变+色块图,仅 Mock 演示用(渲染尺寸限制在 512 以内保证速度)。"""
    w = max(64, min(int(w), 1024))
    h = max(64, min(int(h), 1024))
    scale = min(1.0, 512 / max(w, h))
    w = max(64, int(w * scale))
    h = max(64, int(h * scale))
    key = (w, h, seed)
    if key in _PNG_CACHE:
        return _PNG_CACHE[key]
    rnd = random.Random(seed)
    stops = [(rnd.randrange(40, 255), rnd.randrange(40, 255), rnd.randrange(40, 255))
             for _ in range(4)]
    blobs = []
    for i in range(3):
        brnd = random.Random(seed + i + 1)
        blobs.append((rnd.randrange(w), rnd.randrange(h), rnd.randrange(40, w // 3),
                      (brnd.randrange(120, 255), brnd.randrange(120, 255), brnd.randrange(120, 255))))
    raw = bytearray()
    for y in range(h):
        raw.append(0)  # PNG 行滤波器: None
        ty = y / max(1, h - 1)
        for x in range(w):
            t = (x / max(1, w - 1) * 0.6 + ty * 0.4) * (len(stops) - 1)
            i0 = int(t)
            f = t - i0
            a = stops[i0]
            b = stops[min(i0 + 1, len(stops) - 1)]
            r, g, bl = (int(a[k] * (1 - f) + b[k] * f) for k in range(3))
            # 叠加几个半透明色块,看起来像"生成结果"
            for bx, by, br, bc in blobs:
                d = ((x - bx) ** 2 + (y - by) ** 2) ** 0.5
                if d < br:
                    mix = (1 - d / br) * 0.45
                    r = int(r * (1 - mix) + bc[0] * mix)
                    g = int(g * (1 - mix) + bc[1] * mix)
                    bl = int(bl * (1 - mix) + bc[2] * mix)
            raw += bytes((min(255, r), min(255, g), min(255, bl)))
    png = (b'\x89PNG\r\n\x1a\n'
           + _png_chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0))
           + _png_chunk(b'IDAT', zlib.compress(bytes(raw), 6))
           + _png_chunk(b'IEND', b''))
    _PNG_CACHE[key] = png
    return png


def parse_multipart(body, content_type):
    """极简 multipart 解析(仅 Mock 用),返回 {字段名: [bytes, ...]}。"""
    try:
        boundary = content_type.split('boundary=')[1].split(';')[0].strip().encode()
    except IndexError:
        return {}
    out = {}
    for part in body.split(b'--' + boundary):
        part = part.lstrip(b'\r\n')
        if not part or part.startswith(b'--'):
            continue
        head, sep, data = part.partition(b'\r\n\r\n')
        if not sep:
            continue
        if data.endswith(b'\r\n'):
            data = data[:-2]
        name = None
        for line in head.split(b'\r\n'):
            if b'name="' in line:
                name = line.split(b'name="')[1].split(b'"')[0].decode('utf-8', 'replace')
                break
        if name:
            out.setdefault(name, []).append(data)
    return out


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    server_version = 'NCP-QwenImage-Gateway/1.0'

    def log_message(self, fmt, *args):  # 安静模式;调试时可改为 print
        pass

    # ------------------------------------------------------------ 基础收发
    def _send(self, status, ctype, body):
        self.send_response(status)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(body)

    def do_OPTIONS(self):
        self._send(204, 'text/plain', b'')

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == '/p':
            return self._proxy('GET')
        return self._static(parsed.path)

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path == '/p':
            return self._proxy('POST')
        self._send(404, 'application/json', b'{"error":"not found"}')

    # ------------------------------------------------------------ 静态文件
    def _static(self, path):
        if path == '/':
            path = '/index.html'
        rel = os.path.normpath(unquote(path).lstrip('/'))
        fp = os.path.join(PUBLIC_DIR, rel)
        if not os.path.normpath(fp).startswith(PUBLIC_DIR) or not os.path.isfile(fp):
            return self._send(404, 'text/plain; charset=utf-8', '404 Not Found'.encode())
        ctype = mimetypes.guess_type(fp)[0] or 'application/octet-stream'
        if ctype.startswith('text/') or ctype in ('application/javascript', 'application/json'):
            ctype += '; charset=utf-8'
        with open(fp, 'rb') as f:
            self._send(200, ctype, f.read())

    # ------------------------------------------------------------ API 代理
    def _proxy(self, method):
        qs = parse_qs(urlparse(self.path).query)
        target = (qs.get('url') or [''])[0]
        pu = urlparse(target)
        if pu.scheme not in ('http', 'https') or not pu.netloc:
            return self._send(400, 'application/json',
                              json.dumps({'error': '无效的 url 参数'}).encode())
        length = int(self.headers.get('Content-Length') or 0)
        body = self.rfile.read(length) if length else None

        if MOCK:
            mocked = self._mock(target, method, body or b'')
            if mocked:
                return self._send(*mocked)

        req = urllib.request.Request(target, data=body, method=method)
        for h in ('Authorization', 'Content-Type', 'Accept'):
            v = self.headers.get(h)
            if v:
                req.add_header(h, v)
        try:
            with urllib.request.urlopen(req, timeout=UPSTREAM_TIMEOUT) as resp:
                data = resp.read()
                status = resp.status
                ctype = resp.headers.get('Content-Type', 'application/octet-stream')
        except urllib.error.HTTPError as e:
            data = e.read()
            status = e.code
            ctype = e.headers.get('Content-Type', 'text/plain; charset=utf-8')
        except Exception as e:
            return self._send(502, 'application/json',
                              json.dumps({'error': '无法连接上游 API 服务器: %s' % e}).encode())
        self._send(status, ctype, data)

    # ------------------------------------------------------------ Mock 实现
    def _mock(self, target, method, body):
        """命中 Mock 路由时返回 (status, ctype, body),否则 None 走真实代理。"""
        u = urlparse(target)
        path = u.path
        origin = 'http://127.0.0.1:%d' % self.server.server_port

        def mk_url(seed, w, h):
            return '/p?url=' + quote('%s/__mock/file/%d-%d-%d.png' % (origin, seed, w, h))

        if path == '/health':
            payload = {"status": "ready", "vram": {"used_gb": 9.4, "total_gb": 15.92},
                       "blockswap": None, "attention": "sage", "queue_waiting": 0,
                       "generated_total": len(_PNG_CACHE)}
            return 200, 'application/json', json.dumps(payload).encode()

        if path.endswith('/v1/images/generations') and method == 'POST':
            try:
                p = json.loads(body or b'{}')
            except ValueError:
                p = {}
            w = int(p.get('width') or 1024)
            h = int(p.get('height') or 1024)
            steps = int(p.get('steps') or 20)
            n = max(1, min(4, int(p.get('n') or 1)))
            base_seed = p.get('seed') if isinstance(p.get('seed'), int) else random.randrange(2 ** 31)
            time.sleep(1.6)
            data = [{"file": "mock-%dx%d-s%d-seed%d.png" % (w, h, steps, base_seed + i),
                     "seed": base_seed + i,
                     "url": mk_url(base_seed + i, w, h)} for i in range(n)]
            return 200, 'application/json', json.dumps(
                {"created": int(time.time()), "data": data}).encode()

        if path.endswith('/v1/images/edits') and method == 'POST':
            fields = parse_multipart(body, self.headers.get('Content-Type', ''))
            n_img = max(1, len(fields.get('image', [])))
            try:
                steps = int((fields.get('steps') or [b'15'])[0])
            except ValueError:
                steps = 15
            seed = random.randrange(2 ** 31)
            time.sleep(1.6)
            return 200, 'application/json', json.dumps({"created": int(time.time()), "data": [{
                "file": "mock-edit-%dimg-s%d-seed%d.png" % (n_img, steps, seed),
                "seed": seed,
                "url": mk_url(seed, 1024, 1024)}]}).encode()

        if path.startswith('/__mock/file/'):
            name = path.rsplit('/', 1)[-1]
            try:
                seed, w, h = [int(v) for v in name[:-4].split('-')]
            except ValueError:
                seed, w, h = 7, 800, 800
            return 200, 'image/png', make_png(w, h, seed)

        return None


def _lan_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(('10.255.255.255', 1))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except OSError:
        return '127.0.0.1'


def main():
    port = 8300
    if len(sys.argv) > 1 and sys.argv[1].isdigit():
        port = int(sys.argv[1])
    srv = None
    for cand in range(port, port + 20):
        try:
            srv = ThreadingHTTPServer(('0.0.0.0', cand), Handler)
            port = cand
            break
        except OSError:
            continue
    if srv is None:
        print('[错误] %d-%d 端口均被占用' % (port, port + 19))
        sys.exit(1)

    print('──────────────────────────────────────────────')
    print('  NCP-QwenImage 生成器 · 本地网关已启动')
    print('──────────────────────────────────────────────')
    print('  本机访问   http://127.0.0.1:%d' % port)
    print('  局域网访问 http://%s:%d' % (_lan_ip(), port))
    print('  运行模式   %s' % ('Mock 演示(不连接 GPU 服务器)' if MOCK else '正式(连接 API 服务器)'))
    print('  API 地址与密钥在工作台左下角服务卡片中配置')
    print('  按 Ctrl+C 停止')
    print('──────────────────────────────────────────────')
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print('\n已停止')


if __name__ == '__main__':
    main()
