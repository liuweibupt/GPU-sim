#!/usr/bin/env python3
"""Serve only the study HTML on loopback. No answers, fixes, uploads, or access log."""
import argparse
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

ROOT=Path(__file__).resolve().parents[3]

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--html',type=Path,default=ROOT/'web/research/human-study/index.html')
    parser.add_argument('--port',type=int,default=4184)
    args=parser.parse_args();page=args.html.read_bytes()
    class Handler(BaseHTTPRequestHandler):
        def log_message(self,*args):pass
        def do_GET(self):
            if self.path.split('?')[0] not in ['/', '/index.html']:
                self.send_error(404);return
            self.send_response(200);self.send_header('Content-Type','text/html; charset=utf-8');self.send_header('Content-Length',str(len(page)));self.send_header('Cache-Control','no-store');self.send_header('X-Content-Type-Options','nosniff');self.end_headers();self.wfile.write(page)
    server=HTTPServer(('127.0.0.1',args.port),Handler)
    print(f'Study rehearsal: http://127.0.0.1:{server.server_address[1]}/ (loopback only; no upload endpoint)',flush=True)
    try:server.serve_forever()
    except KeyboardInterrupt:pass
    finally:server.server_close()

if __name__=='__main__':main()
