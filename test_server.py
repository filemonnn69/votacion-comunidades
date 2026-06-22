import subprocess
import time
import urllib.request
import urllib.error
import json
import sys
import os

PORT = 3000
SERVER_URL = f"http://localhost:{PORT}"

def make_request(path, method="GET", data=None):
    url = f"{SERVER_URL}{path}"
    headers = {"Content-Type": "application/json"}
    
    req_data = json.dumps(data).encode('utf-8') if data else None
    req = urllib.request.Request(url, data=req_data, headers=headers, method=method)
    
    try:
        with urllib.request.urlopen(req) as response:
            status = response.status
            body = response.read().decode('utf-8')
            return status, json.loads(body) if body else {}
    except urllib.error.HTTPError as e:
        status = e.code
        body = e.read().decode('utf-8')
        return status, json.loads(body) if body else {}
    except urllib.error.URLError as e:
        print(f"Error de red al conectar a {url}: {e}")
        return None, None

def run_tests():
    print("Iniciando pruebas de integración...")
    
    # 1. Iniciar el servidor como subproceso
    server_process = subprocess.Popen(
        [sys.executable, "server.py"],
        cwd=os.path.dirname(os.path.abspath(__file__)),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE
    )
    
    # Esperar a que el servidor se levante
    time.sleep(1.5)
    
    try:
        # 2. Probar GET /api/config
        status, config = make_request("/api/config")
        print(f"[TEST 1] GET /api/config: HTTP {status}")
        assert status == 200, "Fallo al obtener la configuración"
        assert len(config.get("comunidades", [])) > 0, "No se cargaron comunidades"
        print(" -> OK: Comunidades cargadas con éxito.")
        
        # 3. Intentar votar antes de iniciar temporizador (debe fallar)
        vote_payload = {
            "communityId": "ia_datos",
            "voterName": "Pedro",
            "vote1": "Carlos Rodríguez",
            "vote2": "Beatriz Martínez"
        }
        status, resp = make_request("/api/vote", "POST", vote_payload)
        print(f"[TEST 2] Votar con temporizador parado: HTTP {status}")
        assert status == 400, "Votación permitida con temporizador parado"
        assert "no está activa" in resp.get("message", ""), "Mensaje de error incorrecto"
        print(" -> OK: El servidor rechaza votos cuando la votación no está activa.")

        # 4. Iniciar Temporizador
        timer_payload = {"action": "start", "duration": 180}
        status, timer_resp = make_request("/api/timer", "POST", timer_payload)
        print(f"[TEST 3] Iniciar temporizador: HTTP {status}")
        assert status == 200, "Error al arrancar el temporizador"
        assert timer_resp.get("timer", {}).get("running") is True, "El temporizador no está corriendo"
        print(" -> OK: Temporizador iniciado correctamente.")

        # 5. Votación correcta 1
        status, resp = make_request("/api/vote", "POST", vote_payload)
        print(f"[TEST 4] Registrar voto válido 1: HTTP {status}")
        assert status == 200, "Error al registrar un voto válido"
        print(" -> OK: Primer voto registrado.")

        # 6. Votación correcta 2
        vote_payload2 = {
            "communityId": "ia_datos",
            "voterName": "Carlos Rodríguez",
            "vote1": "Alejandro Gómez",
            "vote2": "Diana Fernández"
        }
        status, resp = make_request("/api/vote", "POST", vote_payload2)
        print(f"[TEST 5] Registrar voto válido 2: HTTP {status}")
        assert status == 200, "Error al registrar segundo voto"
        print(" -> OK: Segundo voto registrado.")

        # 7. Intentar votar de nuevo (doble voto - debe fallar)
        status, resp = make_request("/api/vote", "POST", vote_payload)
        print(f"[TEST 6] Detectar doble voto: HTTP {status}")
        assert status == 400, "Se permitió doble voto al mismo votante"
        assert "Ya has registrado tu voto" in resp.get("message", ""), "Mensaje de doble voto incorrecto"
        print(" -> OK: Rechazado doble voto del mismo participante.")

        # 8. Intentar autovoto (debe fallar)
        autovote_payload = {
            "communityId": "ia_datos",
            "voterName": "Fátima Ruiz",
            "vote1": "Fátima Ruiz",
            "vote2": "Carlos Rodríguez"
        }
        status, resp = make_request("/api/vote", "POST", autovote_payload)
        print(f"[TEST 7] Detectar autovoto: HTTP {status}")
        assert status == 400, "Se permitió autovoto"
        assert "votarse a sí mismo" in resp.get("message", ""), "Mensaje de autovoto incorrecto"
        print(" -> OK: Rechazado autovoto del participante.")

        # 9. Comprobar resultados agregados
        status, state = make_request("/api/state")
        print(f"[TEST 8] GET /api/state: HTTP {status}")
        assert status == 200, "Error al consultar estado final"
        
        # Verificar conteo de votos individuales
        comm_votes = state.get("votes", {}).get("ia_datos", {})
        assert comm_votes.get("Carlos Rodríguez") == 1, "Voto incorrecto para Carlos"
        assert comm_votes.get("Beatriz Martínez") == 1, "Voto incorrecto para Beatriz"
        assert comm_votes.get("Alejandro Gómez") == 1, "Voto incorrecto para Alejandro"
        assert comm_votes.get("Diana Fernández") == 1, "Voto incorrecto para Diana"
        print(" -> OK: Resultados contados con precisión.")
        
        print("\n¡TODAS LAS PRUEBAS DE INTEGRACIÓN PASARON SATISFACTORIAMENTE! 🎉")
        return True
    
    except AssertionError as e:
        print(f"\n❌ FALLO DE ASSERT: {e}", file=sys.stderr)
        return False
    except Exception as e:
        print(f"\n❌ ERROR INESPERADO: {e}", file=sys.stderr)
        return False
    finally:
        # Asegurar el apagado del servidor al terminar
        server_process.terminate()
        server_process.wait()
        print("Servidor de pruebas detenido.")

if __name__ == "__main__":
    success = run_tests()
    sys.exit(0 if success else 1)
