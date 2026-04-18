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

def get_prioritized_name(username):
    safe_current = "".join(c for c in username if c.isalnum())
    remaining_names = load_pending_names(username)
    
    if not remaining_names:
        return None, 0
    
    other_liked = set()
    for f in os.listdir(SCRIPT_DIR):
        if f.startswith('liked_names_') and f != f'liked_names_{safe_current}.txt':
            file_path = os.path.join(SCRIPT_DIR, f)
            with open(file_path, 'r') as file:
                for line in file:
                    name = line.strip()
                    if name:
                        other_liked.add(name)
    
    prioritized = [n for n in remaining_names if n in other_liked]
    
    if prioritized:
        picked = random.choice(prioritized)
    else:
        picked = random.choice(remaining_names)
    
    if picked in remaining_names:
        remaining_names.remove(picked)
    save_remaining_names(username, remaining_names)
    
    return picked, len(remaining_names)

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
                liked = [line.strip() for line in file if line.strip()]
                if name in liked:
                    other_user = f.replace('liked_names_', '').replace('.txt', '')
                    return other_user, name
    return None, None

class CustomHandler(SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path == '/':
            self.path = '/index.html'
        elif self.path == '/admin':
            self.send_response(200)
            self.send_header('Content-Type', 'text/html')
            self.end_headers()
            html = '''<!DOCTYPE html>
<html>
<head>
    <title>Admin</title>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
        body { font-family: Arial; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #f5f5f5; }
        .btn { font-size: 24px; padding: 20px 40px; margin: 10px; background-color: #e74c3c; color: white; border: none; border-radius: 10px; cursor: pointer; }
        .btn:hover { background-color: #c0392b; }
        .btn-secondary { background-color: #3498db; }
        .btn-secondary:hover { background-color: #2980b9; }
        .btn-green { background-color: #27ae60; }
        .btn-green:hover { background-color: #219a52; }
        .input-area { margin: 20px 0; text-align: center; }
        textarea { font-size: 16px; padding: 10px; width: 300px; height: 100px; border-radius: 8px; border: 1px solid #ccc; }
    </style>
</head>
<body>
    <button class="btn" onclick="clearAll()">Clear All Users</button>
    <button class="btn btn-secondary" onclick="findMatches()">Find Matches</button>
    <div class="input-area">
        <textarea id="newNames" placeholder="Enter names (one per line)"></textarea>
        <br>
        <button class="btn btn-green" onclick="addNames()">Add New Names</button>
    </div>
    <script>
        async function clearAll() {
            await fetch('/admin/clear', { method: 'POST' });
            alert('All user files cleared!');
        }
        async function findMatches() {
            var response = await fetch('/admin/find-matches');
            var data = await response.json();
            if (data.length === 0) { alert('No matches found!'); return; }
            var html = '';
            for (var i = 0; i < data.length; i++) {
                html += '<div>' + data[i].name + ' match for ' + data[i].users.join(' and ') + '</div>';
            }
            var win = window.open('', '_blank', 'width=500,height=600');
            win.document.write('<html><head><title>Matches</title></head><body style="font-family:Arial;padding:20px;"><h2>All Matches</h2>' + html + '<br><button onclick="window.close()">Close</button></body></html>');
            win.document.close();
        }
        async function addNames() {
            var input = document.getElementById('newNames').value;
            if (!input.trim()) { alert('Please enter some names'); return; }
            var response = await fetch('/admin/add-names', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({names: input})
            });
            var data = await response.json();
            alert('Added ' + data.added + ' new names! Skipped ' + data.skipped + ' duplicates.');
            document.getElementById('newNames').value = '';
        }
    </script>
</body>
</html>'''
            self.wfile.write(html.encode())
            return
        elif self.path == '/admin/find-matches':
            name_to_users = {}
            for f in os.listdir(SCRIPT_DIR):
                if f.startswith('liked_names_'):
                    user = f.replace('liked_names_', '').replace('.txt', '')
                    file_path = os.path.join(SCRIPT_DIR, f)
                    with open(file_path, 'r') as file:
                        for line in file:
                            name = line.strip()
                            if name:
                                if name not in name_to_users:
                                    name_to_users[name] = set()
                                name_to_users[name].add(user)
            
            matches = [{'name': name, 'users': list(users)} for name, users in name_to_users.items() if len(users) >= 2]
            
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps(matches).encode())
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
        
        if self.path == '/admin/add-names':
            content_length = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(content_length).decode('utf-8')
            data = json.loads(body)
            new_names_input = data.get('names', '')
            
            new_names = [n.strip() for n in new_names_input.replace(',', '\n').split('\n') if n.strip()]
            
            with open(DEFAULT_NAMES_FILE, 'r') as f:
                existing_names = set(line.strip() for line in f if line.strip())
            
            to_add = [n for n in new_names if n not in existing_names]
            
            if to_add:
                with open(DEFAULT_NAMES_FILE, 'a') as f:
                    for name in to_add:
                        f.write('\n' + name)
                
                for f in os.listdir(SCRIPT_DIR):
                    if f.startswith('remaining_names_'):
                        file_path = os.path.join(SCRIPT_DIR, f)
                        with open(file_path, 'a') as file:
                            for name in to_add:
                                file.write('\n' + name)
            
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({'added': len(to_add), 'skipped': len(new_names) - len(to_add)}).encode())
            return
        
        if self.path.startswith('/api/login/'):
            username = self.path.split('/api/login/')[1]
            username = urllib.parse.unquote(username)
            name, remaining = get_prioritized_name(username)
            current_names[username] = name
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({'name': current_names[username], 'remaining': remaining}).encode())
            return
        
        if self.path in ['/api/like', '/api/dislike']:
            username = self.headers.get('X-Username', '')
            if not username:
                self.send_error(400)
                return
            
            liked_file, remaining_file = get_user_files(username)
            current_name = current_names.get(username)
            match = None
            liked_name = None
            
            if self.path == '/api/like' and current_name:
                with open(liked_file, 'a') as f:
                    f.write(current_name + '\n')
                match, liked_name = check_for_match(current_name, username)
            
            name, remaining = get_prioritized_name(username)
            current_names[username] = name
            
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({'name': current_names[username], 'remaining': remaining, 'match': match, 'likedName': liked_name}).encode())
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