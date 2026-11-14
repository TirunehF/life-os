"""The HTTP front: a thin adapter from http.server to App.handle()."""
import signal
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from . import db
from .app import App, Request
from .config import HOST

BODYLESS = (204, 304)


class _TooLarge(Exception):
    pass


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "LifeOS"
    sys_version = ""
    # Idle keep-alive connections are dropped after this long. Longer than the
    # idle timeout of the proxy in front, so the proxy always closes first.
    timeout = 300

    def _read_body(self, limit):
        if "chunked" in self.headers.get("Transfer-Encoding", "").lower():
            chunks, total = [], 0
            while True:
                size = int(self.rfile.readline(64).split(b";")[0].strip() or b"0", 16)
                if size == 0:
                    while self.rfile.readline(8192).strip():
                        pass  # trailers
                    return b"".join(chunks)
                total += size
                if total > limit:
                    raise _TooLarge()
                chunks.append(self.rfile.read(size))
                self.rfile.readline(8)
        length = int(self.headers.get("Content-Length") or 0)
        if length < 0:
            raise ValueError("negative length")
        if length > limit:
            raise _TooLarge()
        return self.rfile.read(length) if length else b""

    def _serve(self):
        app = self.server.app
        try:
            body = self._read_body(app.max_body(self.command, self.path.split("?", 1)[0]))
        except _TooLarge:
            return self._plain(413, "Request body too large.\n")
        except ValueError:
            return self._plain(400, "Bad request.\n")
        resp = app.handle(Request(self.command, self.path, dict(self.headers.items()), body))
        self.send_response(resp.status)
        for name, value in resp.headers:
            self.send_header(name, value)
        if resp.status not in BODYLESS:
            self.send_header("Content-Length", str(len(resp.body)))
        self.end_headers()
        if self.command != "HEAD" and resp.status not in BODYLESS:
            self.wfile.write(resp.body)

    def _plain(self, status, text):
        self.close_connection = True   # the unread body makes the connection unusable
        payload = text.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(payload)

    do_GET = do_HEAD = do_POST = do_PUT = do_DELETE = _serve

    def log_message(self, fmt, *args):
        pass  # no access log: request paths contain dates and ids


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True
    request_queue_size = 64

    def handle_error(self, request, client_address):
        kind = sys.exc_info()[0]
        if kind and issubclass(kind, (ConnectionError, TimeoutError)):
            return  # a client that went away is not worth a stack trace
        super().handle_error(request, client_address)


def make_server(config, port=None):
    db.init(config.data_dir)
    server = Server((HOST, config.port if port is None else port), Handler)
    server.app = App(config)
    return server


def run(config):
    server = make_server(config)

    def stop(signum, frame):
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    print("Life OS listening on http://%s:%d (commit %s)" % (HOST, server.server_address[1], config.commit),
          flush=True)
    try:
        server.serve_forever()
    finally:
        server.server_close()
