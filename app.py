import random
import os
from http.server import HTTPServer, SimpleHTTPRequestHandler
import json
import urllib.parse

PORT = 5000
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
DEFAULT_NAMES_FILE = os.path.join(SCRIPT_DIR, 'names.txt')

current_names = {}

def get_user_files(username):
    safe_name = "".join(c for c in username if c.isalnum())
    liked_file = os.path.join(SCRIPT_DIR, f'liked_names_{safe_name}.txt')
    remaining_file = os.path.join(SCRIPT_DIR, f'remaining_names_{safe_name}.txt')
    return liked_file, remaining_file

def load_pending_names(username):
    liked_file, remaining_file = get_user_files(username)
    
    if os.path.exists(remaining_file):
        with open(remaining_file, 'r') as f:
            names = [line.strip() for line in f if line.strip()]
    else:
        with open(DEFAULT_NAMES_FILE, 'r') as f:
            names = [line.strip() for line in f if line.strip()]
        with open(remaining_file, 'w') as f:
            for name in names:
                f.write(name + '\n')
    
    return names

def save_remaining_names(username, names):
    _, remaining_file = get_user_files(username)
    with open(remaining_file, 'w') as f:
        for name in names:
            f.write(name + '\n')

def get_random_name(username):
    names = load_pending_names(username)
    if names:
        return random.choice(names), len(names)
    return None, 0

def check_for_match(name, current_username):
    safe_current = "".join(c for c in current_username if c.isalnum())
    for f in os.listdir(SCRIPT_DIR):
        if f.startswith('liked_names_') and f != f'liked_names_{safe_current}.txt':
            file_path = os.path.join(SCRIPT_DIR, f)
            with open(file_path, 'r') as file:
                if name in [line.strip() for line in file if line.strip()]:
                    other_user = f.replace('liked_names_', '').replace('.txt', '')
                    return other_user
    return None

class CustomHandler(SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path == '/':
            self.path = '/index.html'
        elif self.path == '/admin':
            self.send_response(200)
            self.send_header('Content-Type', 'text/html')
            self.end_headers()
            self.wfile.write(b'''<!DOCTYPE html>
<html>
<head>
    <title>Admin</title>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
        body { font-family: Arial; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
        button { font-size: 24px; padding: 20px 40px; background-color: #e74c3c; color: white; border: none; border-radius: 10px; cursor: pointer; }
    </style>
</head>
<body>
    <button onclick="clearLiked()">Clear All Users</button>
    <script>
        async function clearLiked() {
            await fetch('/admin/clear', { method: 'POST' });
            alert('All user files cleared!');
        }
    </script>
</body>
</html>''')
            return
        elif self.path.startswith('/api/'):
            if self.path.startswith('/api/login/'):
                username = self.path.split('/api/login/')[1]
                username = urllib.parse.unquote(username)
                names = load_pending_names(username)
                if names:
                    current_names[username] = random.choice(names)
                    remaining = len(names)
                else:
                    current_names[username] = None
                    remaining = 0
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({'name': current_names[username], 'remaining': remaining}).encode())
                return
            self.send_error(404)
            return
        
        return super().do_GET()

    def do_POST(self):
        if self.path == '/admin/clear':
            for f in os.listdir(SCRIPT_DIR):
                if f.startswith('liked_names_') or f.startswith('remaining_names_'):
                    os.remove(os.path.join(SCRIPT_DIR, f))
            self.send_response(200)
            self.end_headers()
            return
        
        elif self.path.startswith('/api/login/'):
            username = self.path.split('/api/login/')[1]
            username = urllib.parse.unquote(username)
            names = load_pending_names(username)
            if names:
                current_names[username] = random.choice(names)
                remaining = len(names)
            else:
                current_names[username] = None
                remaining = 0
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({'name': current_names[username], 'remaining': remaining}).encode())
            return
        
        elif self.path in ['/api/like', '/api/dislike']:
            username = self.headers.get('X-Username', '')
            if not username:
                self.send_error(400)
                return
            
            liked_file, remaining_file = get_user_files(username)
            names = load_pending_names(username)
            current_name = current_names.get(username)
            match = None
            
            if self.path == '/api/like' and current_name:
                with open(liked_file, 'a') as f:
                    f.write(current_name + '\n')
                match = check_for_match(current_name, username)
            
            if current_name and current_name in names:
                names.remove(current_name)
            
            save_remaining_names(username, names)
            
            current_names[username] = random.choice(names) if names else None
            
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({'name': current_names[username], 'remaining': len(names), 'match': match}).encode())
            return
        
        self.send_error(404)

server_address = ("0.0.0.0", PORT)
os.chdir(SCRIPT_DIR)
httpd = HTTPServer(server_address, CustomHandler)

print(f"Serving HTTP on port {PORT} (http://localhost:{PORT}/) ...")
try:
    httpd.serve_forever()
except KeyboardInterrupt:
    print("\nShutting down server.")
    httpd.server_close()