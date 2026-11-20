#!/usr/bin/env python3
"""Local dev server for the Baby Names static site.

Serves this folder over HTTP so fetch('names.txt') works (it fails on file://).
Not used in production; GitHub Pages serves the files directly.

Usage:
    python3 serve.py            # http://localhost:8000
    python3 serve.py 9000       # custom port
    python3 serve.py --lan      # also reachable from phones on the same WiFi
"""

import argparse
import functools
import http.server
import os
import socket

ROOT = os.path.dirname(os.path.abspath(__file__))


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    """Static file handler that disables caching so edits show up on reload."""

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


def lan_ip():
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("10.255.255.255", 1))  # no packets sent; picks the outbound interface
            return s.getsockname()[0]
    except OSError:
        return None


def main():
    parser = argparse.ArgumentParser(description="Serve the Baby Names app locally.")
    parser.add_argument("port", nargs="?", type=int, default=8000)
    parser.add_argument("--lan", action="store_true",
                        help="listen on all interfaces so other devices can connect")
    args = parser.parse_args()

    host = "0.0.0.0" if args.lan else "127.0.0.1"
    handler = functools.partial(NoCacheHandler, directory=ROOT)
    server = http.server.ThreadingHTTPServer((host, args.port), handler)

    print(f"Serving {ROOT}")
    print(f"  Local:   http://localhost:{args.port}/")
    if args.lan:
        ip = lan_ip()
        if ip:
            print(f"  Network: http://{ip}:{args.port}/")
        print("  Note: plain HTTP on the LAN isn't a secure context, so the Copy button may not work there.")
    print("Press Ctrl+C to stop.")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
