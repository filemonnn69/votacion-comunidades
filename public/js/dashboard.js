// Estado del Dashboard
let configData = {};
let votesData = {};
let votersData = {};
let timerState = { running: false, remaining: 180, duration: 180 };
let sseSource = null;

// Configuración de audio
let audioCtx = null;

// Elementos del DOM
const timerDisplay = document.getElementById('timer-display');
const timerStatus = document.getElementById('timer-status');
const progressCircle = document.getElementById('progress-circle');
const totalVotersDisplay = document.getElementById('total-voters');
const totalVotesDisplay = document.getElementById('total-votes');
const communitiesLiveGrid = document.getElementById('communities-live-grid');
const timerDurationInput = document.getElementById('timer-duration-input');

const winnerOverlay = document.getElementById('winner-overlay');
const winnerNameDisplay = document.getElementById('winner-name');

const btnStart = document.getElementById('btn-start');
const btnPause = document.getElementById('btn-pause');
const btnCelebrate = document.getElementById('btn-celebrate');
const btnStop = document.getElementById('btn-stop');

// Circunferencia del círculo SVG (2 * PI * R) -> 2 * 3.14159 * 90 = 565.48
const CIRCUMFERENCE = 565.48;

document.addEventListener('DOMContentLoaded', () => {
  // Generar el código QR dinámicamente según el dominio actual
  const qrImg = document.getElementById('qr-code-img');
  if (qrImg) {
    const rootUrl = window.location.origin;
    qrImg.src = `https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=${encodeURIComponent(rootUrl)}`;
  }
  
  initDashboard();
  connectSSE();
});

// 1. Inicialización
async function initDashboard() {
  try {
    const res = await fetch('/api/state');
    if (!res.ok) throw new Error('Error de conexión');
    const state = await res.json();
    
    // Guardar datos
    votesData = state.votes || {};
    votersData = state.voters || {};
    timerState = state.timer || { running: false, remaining: 180, duration: 180 };
    
    // Cargar config de comunidades
    const configRes = await fetch('/api/config');
    configData = await configRes.json();
    
    updateTimerUI(timerState);
    updateStatsUI();
    renderChart();

    
  } catch (err) {
    console.error('Error al inicializar dashboard:', err);
    // Si falla, limpiar y mostrar error en toda la pantalla
    communitiesLiveGrid.innerHTML = `<div class="no-votes-message" style="color: var(--accent-red); border-color: var(--accent-red); grid-column: 1 / -1;">
      Error al conectar con el servidor. Por favor, asegúrate de que server.py está corriendo.
    </div>`;
  }
}

// 2. Escuchar Actualizaciones en Vivo (SSE)
function connectSSE() {
  if (sseSource) {
    sseSource.close();
  }
  
  sseSource = new EventSource('/api/stream');
  
  sseSource.addEventListener('state', (e) => {
    const state = JSON.parse(e.data);
    votesData = state.votes || {};
    votersData = state.voters || {};
    timerState = state.timer || { running: false, remaining: 180, duration: 180 };
    updateTimerUI(timerState);
    updateStatsUI();
    renderChart();
  });
  
  sseSource.addEventListener('vote_update', (e) => {
    const state = JSON.parse(e.data);
    votesData = state.votes || {};
    votersData = state.voters || {};
    updateStatsUI();
    renderChart();
  });
  
  sseSource.addEventListener('timer', (e) => {
    const timer = JSON.parse(e.data);
    const prevRemaining = timerState.remaining;
    timerState = timer;
    updateTimerUI(timerState);
    
    // Efectos de sonido en cuenta atrás
    if (timer.running && timer.remaining <= 5 && timer.remaining > 0 && timer.remaining !== prevRemaining) {
      playBeep(440, 0.1); // Pitidos cortos
    }
  });

  sseSource.addEventListener('timer_end', (e) => {
    timerState.running = false;
    timerState.remaining = 0;
    updateTimerUI(timerState);
    
    // Sonar bocina final
    playBeep(220, 1.2); 
    setTimeout(() => playBeep(220, 0.8), 200);

    // Lanzar automáticamente la celebración y el resumen de ganadores
    setTimeout(() => {
      declareWinner();
    }, 1000);
  });

  
  sseSource.addEventListener('reset', (e) => {
    const state = JSON.parse(e.data);
    votesData = state.votes || {};
    votersData = state.voters || {};
    timerState = state.timer || { running: false, remaining: 180, duration: 180 };
    
    closeWinnerOverlay();
    updateTimerUI(timerState);
    updateStatsUI();
    renderChart();
  });
  
  sseSource.onerror = () => {
    console.warn('Conexión del Dashboard perdida. Intentando reconectar...');
  };
}

// 3. Renderizar Rejilla con todas las comunidades y sus rankings en vivo
function renderChart() {
  if (!configData.comunidades || configData.comunidades.length === 0) {
    return;
  }
  
  let gridHtml = '';
  
  configData.comunidades.forEach(comm => {
    const commId = comm.id;
    const commNombre = comm.nombre;
    const communityVotes = votesData[commId] || {};
    const communityVoters = votersData[commId] || [];
    
    const candidates = Object.entries(communityVotes);
    const activeCandidates = candidates.filter(([_, count]) => count > 0);
    activeCandidates.sort((a, b) => b[1] - a[1]);
    
    const maxVotes = activeCandidates.length > 0 ? activeCandidates[0][1] : 0;
    const totalVotesInComm = communityVoters.length;
    
    let leaderboardHtml = '';
    
    if (activeCandidates.length === 0) {
      leaderboardHtml = `
        <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; color: var(--text-muted); font-size: 0.8rem; padding: 1rem 0; text-align: center; border: 1px dashed hsla(217, 30%, 50%, 0.1); border-radius: 12px; margin-top: 0.25rem;">
          <span>⏳</span>
          <span style="margin-top: 0.2rem;">Esperando propuestas</span>
        </div>
      `;
    } else {
      // Mostrar los top 3 candidatos para ajustarse exactamente a la pantalla sin scroll
      const topCandidates = activeCandidates.slice(0, 3);
      topCandidates.forEach(([name, count], index) => {
        const percent = maxVotes > 0 ? (count / maxVotes) * 100 : 0;
        const isLeader = index === 0;
        const badge = isLeader ? '👑 ' : '';
        
        leaderboardHtml += `
          <div class="community-card-row">
            <div class="label-box" style="font-size: 0.8rem;">
              <span class="candidate-name" style="${isLeader ? 'color: var(--accent-gold); font-weight: 700;' : 'color: var(--text-main);'}" title="${name}">
                ${badge}${name.length > 20 ? name.substring(0, 18) + '...' : name}
              </span>
              <span class="candidate-votes" style="${isLeader ? 'color: var(--accent-gold); font-weight: 700;' : 'color: var(--secondary);'}">${count} v.</span>
            </div>
            <div class="bar-box">
              <div class="bar-fill-box" style="width: ${percent}%; ${isLeader ? 'background: linear-gradient(90deg, var(--accent-gold) 0%, var(--primary) 100%);' : ''}"></div>
            </div>
          </div>
        `;
      });
    }
    
    const communityIcons = {
      gobierno: '🛡️',
      desarrolladores: '🪄',
      data_scientist: '🔮',
      analistas_negocio: '⚡',
      diseno_presentacion: '🧪',
      usuarios_ofimaticos: '🦉',
      soporte_incidencias: '🧙‍♂️'
    };
    const icon = communityIcons[commId] || '🪄';

    gridHtml += `
      <div class="glass-card community-live-card" style="animation: fadeIn 0.4s ease; --watermark-icon: '${icon}';">
        <div class="community-card-header">
          <span class="community-card-title" style="font-size: 1rem;" title="${commNombre}">
            ${commNombre.length > 25 ? commNombre.substring(0, 23) + '...' : commNombre}
          </span>
          <span class="community-card-votes-badge" style="padding: 0.2rem 0.5rem; font-size: 0.75rem;">${totalVotesInComm} v.</span>
        </div>
        <div class="community-card-leaderboard">
          ${leaderboardHtml}
        </div>
      </div>
    `;
  });
  
  // Limpiar todas las tarjetas excepto la primera (el panel de control del administrador)
  while (communitiesLiveGrid.children.length > 1) {
    communitiesLiveGrid.removeChild(communitiesLiveGrid.lastChild);
  }
  
  // Insertar las 7 tarjetas de comunidades
  const tempWrapper = document.createElement('div');
  tempWrapper.innerHTML = gridHtml;
  while (tempWrapper.firstChild) {
    communitiesLiveGrid.appendChild(tempWrapper.firstChild);
  }
}

// 4. Actualizar Indicadores de Tiempos
function updateTimerUI(timer) {
  const min = String(Math.floor(timer.remaining / 60)).padStart(2, '0');
  const sec = String(timer.remaining % 60).padStart(2, '0');
  timerDisplay.textContent = `${min}:${sec}`;
  
  // Calcular porcentaje del círculo SVG
  const pct = timer.duration > 0 ? (timer.remaining / timer.duration) : 0;
  const offset = CIRCUMFERENCE - (pct * CIRCUMFERENCE);
  progressCircle.style.strokeDashoffset = offset;
  
  // Estilo del color del temporizador según urgencia
  if (timer.remaining < 30) {
    progressCircle.style.stroke = 'var(--accent-red)';
    timerDisplay.style.color = 'var(--accent-red)';
    timerDisplay.style.textShadow = '0 0 15px var(--accent-red-glow)';
    timerStatus.textContent = '¡Últimos segundos!';
    timerStatus.style.color = 'var(--accent-red)';
  } else {
    progressCircle.style.stroke = 'var(--primary)';
    timerDisplay.style.color = 'var(--text-main)';
    timerDisplay.style.textShadow = 'none';
    timerStatus.style.color = 'var(--text-muted)';
    timerStatus.textContent = timer.running ? 'Votando...' : 'Pausado';
  }
  
  if (timer.remaining === 0) {
    timerStatus.textContent = 'Finalizado';
    timerStatus.style.color = 'var(--accent-gold)';
    progressCircle.style.stroke = 'var(--accent-gold)';
  }
  
  // Mostrar u ocultar el botón de Celebrar según el tiempo restante
  if (timer.remaining === 0 && !timer.running) {
    btnCelebrate.style.display = 'flex';
  } else {
    btnCelebrate.style.display = 'none';
  }

  // Bloquear/desbloquear controles e inputs según el estado del temporizador
  if (timer.running) {
    timerDurationInput.disabled = true;
    
    // Iniciar deshabilitado
    btnStart.disabled = true;
    btnStart.style.opacity = '0.4';
    btnStart.style.pointerEvents = 'none';
    
    // Pausar habilitado
    btnPause.disabled = false;
    btnPause.style.opacity = '1';
    btnPause.style.pointerEvents = 'auto';
  } else {
    // Si quedan 0 segundos, deshabilitar ambos botones (finalizado)
    if (timer.remaining === 0) {
      timerDurationInput.disabled = false;
      
      btnStart.disabled = true;
      btnStart.style.opacity = '0.4';
      btnStart.style.pointerEvents = 'none';
      
      btnPause.disabled = true;
      btnPause.style.opacity = '0.4';
      btnPause.style.pointerEvents = 'none';
    } else {
      timerDurationInput.disabled = false;
      
      // Iniciar habilitado
      btnStart.disabled = false;
      btnStart.style.opacity = '1';
      btnStart.style.pointerEvents = 'auto';
      
      // Pausar deshabilitado
      btnPause.disabled = true;
      btnPause.style.opacity = '0.4';
      btnPause.style.pointerEvents = 'none';
    }
  }

  // Deshabilitar botón de Finalizar si el tiempo ya llegó a 0
  if (btnStop) {
    if (timer.remaining === 0) {
      btnStop.disabled = true;
      btnStop.style.opacity = '0.4';
      btnStop.style.pointerEvents = 'none';
    } else {
      btnStop.disabled = false;
      btnStop.style.opacity = '1';
      btnStop.style.pointerEvents = 'auto';
    }
  }
}

// 5. Actualizar Estadísticas Generales
function updateStatsUI() {
  let totalVoters = 0;
  Object.values(votersData).forEach(list => {
    totalVoters += list.length;
  });
  totalVotersDisplay.textContent = totalVoters;
  
  let totalVotes = 0;
  Object.values(votesData).forEach(commVotes => {
    totalVotes += Object.values(commVotes).reduce((sum, count) => sum + count, 0);
  });
  totalVotesDisplay.textContent = totalVotes;
}

// 6. Enviar Comandos de Control de Temporizador al Servidor (duración configurable)
async function controlTimer(action) {
  initAudio();
  
  // Leer la duración del input configurable (minutos a segundos)
  const durationMinutes = parseFloat(timerDurationInput.value) || 3;
  const durationSeconds = Math.round(durationMinutes * 60);
  
  try {
    await fetch('/api/timer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: action, duration: durationSeconds })
    });
  } catch (err) {
    console.error('Error al controlar temporizador:', err);
  }
}

// 7. Enviar Comando de Reset Completo
async function resetVotacion() {
  if (!confirm('¿Estás seguro de que quieres reiniciar todas las votaciones y borrar los datos de censo? Esta acción no se puede deshacer.')) {
    return;
  }
  try {
    await fetch('/api/reset', { method: 'POST' });
  } catch (err) {
    console.error('Error al resetear votación:', err);
  }
}

// 8. Declaración conjunta de Ganadores en cada Comunidad
function declareWinner() {
  if (!configData.comunidades) return;
  
  // Limpiar y crear una visualización en cuadrícula de todos los ganadores
  winnerNameDisplay.innerHTML = '';
  winnerNameDisplay.style.fontSize = "1rem";
  winnerNameDisplay.style.textAlign = "left";
  winnerNameDisplay.style.background = "none";
  winnerNameDisplay.style.webkitTextFillColor = "initial";
  winnerNameDisplay.style.display = "flex";
  winnerNameDisplay.style.flexDirection = "column";
  winnerNameDisplay.style.gap = "0.5rem";
  winnerNameDisplay.style.margin = "1rem 0";
  
  configData.comunidades.forEach(comm => {
    const commId = comm.id;
    const commVotes = votesData[commId] || {};
    const candidates = Object.entries(commVotes).filter(([_, count]) => count > 0);
    
    let winnerText = '';
    if (candidates.length === 0) {
      winnerText = `<span style="color: var(--text-muted); font-style: italic;">Sin propuestas</span>`;
    } else {
      candidates.sort((a, b) => b[1] - a[1]);
      const topWinnerName = candidates[0][0];
      const topWinnerVotes = candidates[0][1];
      
      const ties = candidates.filter(([_, count]) => count === topWinnerVotes);
      if (ties.length > 1) {
        winnerText = `<strong style="color: var(--accent-gold);">${ties.map(t => t[0].split(' ')[0]).join('/')}</strong> <span style="font-size: 0.8rem; color: var(--text-muted);">(${topWinnerVotes} v. Empate)</span>`;
      } else {
        winnerText = `<strong style="color: #fff;">${topWinnerName}</strong> <span style="font-size: 0.8rem; color: var(--accent-gold);">(${topWinnerVotes} v.)</span>`;
      }
    }
    
    const row = document.createElement('div');
    row.style.display = 'flex';
    row.style.justifyContent = 'space-between';
    row.style.padding = '0.35rem 0';
    row.style.borderBottom = '1px solid hsla(217, 30%, 50%, 0.1)';
    row.innerHTML = `
      <span style="color: var(--text-muted); font-weight: 500; font-size: 0.9rem; max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${comm.nombre}</span>
      <span style="text-align: right;">${winnerText}</span>
    `;
    winnerNameDisplay.appendChild(row);
  });
  
  // Activar overlay
  winnerOverlay.classList.add('active');
  
  // Disparar confeti
  triggerConfettiExplosion();
}

function closeWinnerOverlay() {
  winnerOverlay.classList.remove('active');
}

// 9. Disparador de confeti
function triggerConfettiExplosion() {
  const duration = 5 * 1000;
  const animationEnd = Date.now() + duration;
  const defaults = { startVelocity: 30, spread: 360, ticks: 60, zIndex: 1100 };

  function randomInRange(min, max) {
    return Math.random() * (max - min) + min;
  }

  const interval = setInterval(function() {
    const timeLeft = animationEnd - Date.now();

    if (timeLeft <= 0) {
      return clearInterval(interval);
    }

    const particleCount = 50 * (timeLeft / duration);
    confetti(Object.assign({}, defaults, { particleCount, origin: { x: randomInRange(0.1, 0.3), y: Math.random() - 0.2 } }));
    confetti(Object.assign({}, defaults, { particleCount, origin: { x: randomInRange(0.7, 0.9), y: Math.random() - 0.2 } }));
  }, 250);
}

// 10. Generador de Pitidos Nativos (Web Audio API)
function initAudio() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
}

function playBeep(frequency, duration) {
  try {
    initAudio();
    if (!audioCtx) return;
    
    if (audioCtx.state === 'suspended') {
      audioCtx.resume();
    }
    
    const oscillator = audioCtx.createOscillator();
    const gainNode = audioCtx.createGain();
    
    oscillator.type = 'sine';
    oscillator.frequency.value = frequency;
    
    gainNode.gain.setValueAtTime(0.15, audioCtx.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + duration);
    
    oscillator.connect(gainNode);
    gainNode.connect(audioCtx.destination);
    
    oscillator.start();
    oscillator.stop(audioCtx.currentTime + duration);
  } catch (e) {
    console.warn("La reproducción de audio falló o no está soportada:", e);
  }
}
