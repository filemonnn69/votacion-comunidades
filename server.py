import http.server
import json
import os
import sys
import threading
import time
import queue

PORT = int(os.environ.get("PORT", 3000))

# Cerraduras para hilos (Locks)
data_lock = threading.Lock()
timer_lock = threading.Lock()
clients_lock = threading.Lock()

# Estado de la Votación
# votes[communityId][candidate] = count
votes = {}
# registered_voters[communityId] = set(voterNames)
registered_voters = {}
config_data = {}

# Estado del Temporizador
timer_state = {
    "running": False,
    "remaining": 180,
    "duration": 180
}

# Clientes SSE (List de queue.Queue)
sse_clients = []

def load_config():
    global config_data, votes, registered_voters
    config_path = os.path.join(os.path.dirname(__file__), 'config.json')
    try:
        if os.path.exists(config_path):
            with open(config_path, 'r', encoding='utf-8') as f:
                config_data = json.load(f)
        else:
            # Fallback en caso de que no exista
            config_data = {"comunidades": []}
    except Exception as e:
        print(f"Error cargando config.json: {e}", file=sys.stderr)
        config_data = {"comunidades": []}
    
    # Inicializar estructuras de votos
    with data_lock:
        votes = {}
        registered_voters = {}
        for comm in config_data.get("comunidades", []):
            comm_id = comm["id"]
            votes[comm_id] = {}
            # Precargar miembros conocidos con 0 votos
            for miembro in comm.get("miembros", []):
                votes[comm_id][miembro] = 0
            registered_voters[comm_id] = set()

def get_current_state():
    with data_lock:
        # Convertimos los conjuntos de votantes a listas para serializar a JSON
        voters_serializable = {comm: list(names) for comm, names in registered_voters.items()}
        return {
            "votes": votes,
            "voters": voters_serializable,
            "timer": timer_state
        }

def broadcast(event_type, data):
    payload = f"event: {event_type}\ndata: {json.dumps(data)}\n\n"
    with clients_lock:
        # Hacemos una copia para evitar problemas de concurrencia al iterar y remover
        active_clients = list(sse_clients)
    for q in active_clients:
        try:
            q.put_nowait(payload)
        except queue.Full:
            pass

def timer_worker():
    global timer_state
    while True:
        time.sleep(1)
        tick_needed = False
        with timer_lock:
            if timer_state["running"]:
                timer_state["remaining"] -= 1
                tick_needed = True
                if timer_state["remaining"] <= 0:
                    timer_state["remaining"] = 0
                    timer_state["running"] = False
        
        if tick_needed:
            broadcast("timer", timer_state)
            # Si el temporizador acaba de terminar, mandar alerta de finalización
            if not timer_state["running"] and timer_state["remaining"] == 0:
                broadcast("timer_end", {"msg": "¡Tiempo de votación finalizado!"})

# Iniciar hilo de temporizador
t = threading.Thread(target=timer_worker, daemon=True)
t.start()

class ThreadingHTTPServer(http.server.ThreadingHTTPServer):
    pass

class VotingHandler(http.server.BaseHTTPRequestHandler):
    
    def log_message(self, format, *args):
        # Desactivamos el registro masivo en consola para evitar spam de pings SSE
        if "ping" not in format:
            super().log_message(format, *args)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

    def do_GET(self):
        clean_path = self.path.split('?')[0]
        
        # 1. API: Configuración de comunidades
        if clean_path == '/api/config':
            self.send_json(config_data)
            return

        # 2. API: Estado actual de votos y temporizador
        elif clean_path == '/api/state':
            self.send_json(get_current_state())
            return
            
        # 3. API: Conexión en Tiempo Real (SSE)
        elif clean_path == '/api/stream':
            self.handle_sse()
            return
            
        # 4. Servir archivos estáticos del frontend
        else:
            if clean_path == '/':
                clean_path = '/index.html'
                
            public_dir = os.path.join(os.path.dirname(__file__), 'public')
            filepath = os.path.abspath(os.path.join(public_dir, clean_path.lstrip('/')))
            
            # Seguridad: evitar path traversal fuera del directorio público
            if not filepath.startswith(public_dir):
                self.send_error(403, "Access denied")
                return
                
            if os.path.exists(filepath) and os.path.isfile(filepath):
                self.send_response(200)
                # Content type mappings
                mime = 'application/octet-stream'
                if filepath.endswith('.html'): mime = 'text/html; charset=utf-8'
                elif filepath.endswith('.css'): mime = 'text/css; charset=utf-8'
                elif filepath.endswith('.js'): mime = 'application/javascript; charset=utf-8'
                elif filepath.endswith('.json'): mime = 'application/json; charset=utf-8'
                elif filepath.endswith('.png'): mime = 'image/png'
                elif filepath.endswith('.jpg') or filepath.endswith('.jpeg'): mime = 'image/jpeg'
                elif filepath.endswith('.svg'): mime = 'image/svg+xml'
                elif filepath.endswith('.ico'): mime = 'image/x-icon'
                
                self.send_header('Content-Type', mime)
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                
                try:
                    with open(filepath, 'rb') as f:
                        self.wfile.write(f.read())
                except Exception as e:
                    print(f"Error escribiendo archivo: {e}", file=sys.stderr)
            else:
                self.send_error(404, "File not found")

    def do_POST(self):
        clean_path = self.path.split('?')[0]
        
        # Obtener cuerpo de la petición
        content_length = int(self.headers.get('Content-Length', 0))
        post_data = self.rfile.read(content_length)
        
        try:
            body = json.loads(post_data.decode('utf-8')) if post_data else {}
        except Exception:
            self.send_error(400, "Invalid JSON body")
            return

        # 1. API: Registrar Voto
        if clean_path == '/api/vote':
            self.handle_vote_post(body)
            
        # 2. API: Control de Temporizador (Dashboard)
        elif clean_path == '/api/timer':
            self.handle_timer_post(body)

        # 3. API: Resetear Votación
        elif clean_path == '/api/reset':
            load_config() # Recargar config limpia
            with timer_lock:
                timer_state["running"] = False
                timer_state["remaining"] = timer_state["duration"]
            
            state = get_current_state()
            broadcast("reset", state)
            self.send_json({"status": "success", "message": "Votación reseteada", "state": state})
            
        else:
            self.send_error(404, "Endpoint not found")

    def handle_sse(self):
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.send_header('Cache-Control', 'no-cache')
        self.send_header('Connection', 'keep-alive')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        
        # Enviar mensaje de bienvenida inicial
        self.wfile.write(b"event: open\ndata: {}\n\n")
        self.wfile.flush()
        
        # Enviar estado actual de inmediato para sincronizar
        current_state = get_current_state()
        self.wfile.write(f"event: state\ndata: {json.dumps(current_state)}\n\n".encode('utf-8'))
        self.wfile.flush()
        
        # Cola para este hilo cliente
        q = queue.Queue(maxsize=100)
        with clients_lock:
            sse_clients.append(q)
            
        try:
            while True:
                try:
                    # Espera con timeout para enviar pings y evitar desconexiones por inactividad
                    msg = q.get(timeout=15.0)
                    self.wfile.write(msg.encode('utf-8'))
                    self.wfile.flush()
                except queue.Empty:
                    # Enviar ping
                    self.wfile.write(b": ping\n\n")
                    self.wfile.flush()
        except Exception as e:
            # Cliente desconectado (habitual al cerrar pestaña)
            pass
        finally:
            with clients_lock:
                if q in sse_clients:
                    sse_clients.remove(q)

    def handle_vote_post(self, body):
        community_id = body.get('communityId')
        voter_name = body.get('voterName', '').strip()
        vote1 = body.get('vote1', '').strip()
        vote2 = body.get('vote2', '').strip()
        
        # Validaciones de campos requeridos
        if not community_id or not voter_name or not vote1 or not vote2:
            self.send_json({"status": "error", "message": "Todos los campos son obligatorios."}, 400)
            return
            
        # Comprobar que la comunidad existe
        if community_id not in votes:
            self.send_json({"status": "error", "message": "La comunidad seleccionada no es válida."}, 400)
            return

        # Comprobar si el temporizador está activo
        with timer_lock:
            timer_active = timer_state["running"]
            timer_remaining = timer_state["remaining"]
            
        if not timer_active or timer_remaining <= 0:
            self.send_json({"status": "error", "message": "La votación no está activa en este momento."}, 400)
            return

        # Validar si el votante existe en la lista oficial de participantes
        voter_clean = voter_name.lower()
        participant = None
        for p in config_data.get("participantes", []):
            if p["nombre"].lower() == voter_clean:
                participant = p
                break
                
        if not participant:
            self.send_json({"status": "error", "message": "Tu nombre no figura en la lista oficial de participantes. Escríbelo completo (MAYÚSCULAS) tal como aparece en el listado."}, 400)
            return

        # Validar si intenta votar en otra comunidad que no es la suya
        official_community_id = participant["comunidad"]
        if community_id != official_community_id:
            self.send_json({"status": "error", "message": f"Solo puedes votar en tu comunidad oficial."}, 400)
            return

        # Validar autovoto
        if voter_clean == vote1.lower() or voter_clean == vote2.lower():
            self.send_json({"status": "error", "message": "No está permitido votarse a sí mismo."}, 400)
            return
            
        # Validar votos duplicados en la misma persona
        if vote1.lower() == vote2.lower():
            self.send_json({"status": "error", "message": "Debes proponer a 2 personas distintas."}, 400)
            return

        # Validar que los candidatos propuestos existen en la lista oficial y pertenecen a su misma comunidad
        vote1_participant = None
        vote2_participant = None
        for p in config_data.get("participantes", []):
            p_name_lower = p["nombre"].lower()
            if p_name_lower == vote1.lower():
                vote1_participant = p
            if p_name_lower == vote2.lower():
                vote2_participant = p

        if not vote1_participant:
            self.send_json({"status": "error", "message": f"El primer candidato '{vote1}' no está en la lista oficial de participantes."}, 400)
            return
        if vote1_participant["comunidad"] != official_community_id:
            self.send_json({"status": "error", "message": f"El primer candidato ({vote1}) pertenece a otra comunidad. Deben ser de tu mismo grupo."}, 400)
            return

        if not vote2_participant:
            self.send_json({"status": "error", "message": f"El segundo candidato '{vote2}' no está en la lista oficial de participantes."}, 400)
            return
        if vote2_participant["comunidad"] != official_community_id:
            self.send_json({"status": "error", "message": f"El segundo candidato ({vote2}) pertenece a otra comunidad. Deben ser de tu mismo grupo."}, 400)
            return

        with data_lock:
            # Comprobar si ya ha votado globalmente en alguna de las comunidades
            voted_already = False
            for comm_key in registered_voters:
                if voter_clean in [v.lower() for v in registered_voters[comm_key]]:
                    voted_already = True
                    break
            
            if voted_already:
                self.send_json({"status": "error", "message": "Ya has registrado tu voto en esta sesión de votación."}, 400)
                return
                
            # Registrar al votante (usamos el nombre oficial del participante)
            registered_voters[community_id].add(participant["nombre"])
            
            # Incrementar votos para los candidatos
            # Como ambos existen oficialmente y están precargados en la comunidad (porque load_config inicializa a todos los miembros de la config con 0 votos),
            # incrementamos directamente sobre el nombre oficial para mantener uniformidad.
            votes[community_id][vote1_participant["nombre"]] += 1
            votes[community_id][vote2_participant["nombre"]] += 1

        # Enviar actualización en tiempo real a todos los Dashboards
        state = get_current_state()
        broadcast("vote_update", state)
        
        self.send_json({"status": "success", "message": "¡Tu voto ha sido registrado con éxito!"})

        # Enviar actualización en tiempo real a todos los Dashboards
        state = get_current_state()
        broadcast("vote_update", state)
        
        self.send_json({"status": "success", "message": "¡Tu voto ha sido registrado con éxito!"})

    def handle_timer_post(self, body):
        action = body.get('action')
        duration = body.get('duration', 180)
        
        global timer_state
        with timer_lock:
            if action == 'start':
                timer_state["running"] = True
                # Solo reinicia si el tiempo es cero o si se fuerza una duración distinta
                if timer_state["remaining"] <= 0:
                    timer_state["remaining"] = duration
                timer_state["duration"] = duration
            elif action == 'pause':
                timer_state["running"] = False
            elif action == 'reset':
                timer_state["running"] = False
                timer_state["remaining"] = duration
                timer_state["duration"] = duration
        
        broadcast("timer", timer_state)
        self.send_json({"status": "success", "timer": timer_state})

    def send_json(self, data, status_code=200):
        body_bytes = json.dumps(data).encode('utf-8')
        self.send_response(status_code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body_bytes)))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(body_bytes)

def run():
    load_config()
    server_address = ('', PORT)
    httpd = ThreadingHTTPServer(server_address, VotingHandler)
    print(f"Servidor de Votación Telefónica iniciado en http://localhost:{PORT}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nApagando servidor...")
        httpd.server_close()

if __name__ == '__main__':
    run()
