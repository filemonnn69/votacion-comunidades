// Estado de la App del Votante
let communitiesData = [];
let participantsData = [];
let currentCommunity = null;
let sseSource = null;

// Elementos del DOM
const voterSelect = document.getElementById('voter-select');
const communitySelect = document.getElementById('community-select');
const vote1Select = document.getElementById('vote1');
const vote2Select = document.getElementById('vote2');
const btnSubmitVote = document.getElementById('btn-submit-vote');

const voteForm = document.getElementById('vote-form');
const waitingScreen = document.getElementById('status-waiting');
const successScreen = document.getElementById('voted-success');
const errorAlert = document.getElementById('local-error-alert');
const errorText = document.getElementById('local-error-text');

const voterTimerBadge = document.getElementById('voter-timer-badge');
const voterTimerText = document.getElementById('voter-timer-text');
const voterTimerDot = document.getElementById('voter-timer-dot');

const summaryVote1 = document.getElementById('summary-vote1');
const summaryVote2 = document.getElementById('summary-vote2');

// Inicialización al cargar la página
document.addEventListener('DOMContentLoaded', () => {
  fetchConfig();
  connectSSE();
});

// 1. Cargar Configuración de Comunidades y Participantes
async function fetchConfig() {
  try {
    const res = await fetch('/api/config');
    if (!res.ok) throw new Error('Error al cargar la configuración');
    const data = await res.json();
    communitiesData = data.comunidades || [];
    participantsData = data.participantes || [];
    
    // Ordenar participantes alfabéticamente
    participantsData.sort((a, b) => a.nombre.localeCompare(b.nombre));
    
    // Rellenar selector de participantes
    voterSelect.innerHTML = '<option value="" disabled selected>-- Elige tu Nombre y Apellidos --</option>';
    participantsData.forEach(p => {
      const option = document.createElement('option');
      option.value = p.nombre;
      option.textContent = p.nombre;
      voterSelect.appendChild(option);
    });

    // Rellenar selector de comunidades para que estén listos los IDs correspondientes
    communitySelect.innerHTML = '<option value="" disabled selected>Comunidad...</option>';
    communitiesData.forEach(comm => {
      const option = document.createElement('option');
      option.value = comm.id;
      option.textContent = comm.nombre;
      communitySelect.appendChild(option);
    });
    
    // Restaurar estado guardado si aplica
    restoreVoterState();
  } catch (err) {
    showError('No se pudo conectar con el servidor para obtener la configuración.');
  }
}

// 2. Conectar al Stream de Eventos (SSE)
function connectSSE() {
  if (sseSource) {
    sseSource.close();
  }
  
  sseSource = new EventSource('/api/stream');
  
  sseSource.addEventListener('state', (e) => {
    const state = JSON.parse(e.data);
    updateTimerUI(state.timer);
  });
  
  sseSource.addEventListener('timer', (e) => {
    const timer = JSON.parse(e.data);
    updateTimerUI(timer);
  });

  sseSource.addEventListener('timer_end', (e) => {
    showError("La sesión de votación ha finalizado. El tiempo expiró.");
    disableVoting();
  });
  
  sseSource.addEventListener('reset', (e) => {
    localStorage.clear();
    voteForm.reset();
    voterSelect.disabled = false;
    successScreen.style.display = 'none';
    waitingScreen.style.display = 'block';
    voteForm.style.display = 'none';
    const state = JSON.parse(e.data);
    updateTimerUI(state.timer);
  });
  
  sseSource.onerror = () => {
    console.warn('Conexión SSE perdida. Intentando reconectar...');
  };
}

// 3. Sincronizar UI del temporizador flotante y control de formularios
function updateTimerUI(timer) {
  if (!timer) return;
  
  const min = String(Math.floor(timer.remaining / 60)).padStart(2, '0');
  const sec = String(timer.remaining % 60).padStart(2, '0');
  voterTimerText.textContent = `${min}:${sec}`;
  
  if (timer.remaining < 30) {
    voterTimerDot.style.background = 'var(--accent-red)';
    voterTimerBadge.style.boxShadow = '0 0 15px var(--accent-red-glow)';
  } else {
    voterTimerDot.style.background = 'var(--accent-green)';
    voterTimerBadge.style.boxShadow = 'none';
  }
  
  const savedVoter = localStorage.getItem('voter_name_profile');
  const savedComm = localStorage.getItem('voter_last_community');
  const hasVotedThisComm = savedVoter && savedComm && localStorage.getItem(`voted_${savedComm}`);
  
  if (hasVotedThisComm) {
    waitingScreen.style.display = 'none';
    voteForm.style.display = 'none';
    successScreen.style.display = 'block';
    voterTimerBadge.style.display = timer.running ? 'flex' : 'none';
    return;
  }
  
  if (timer.running && timer.remaining > 0) {
    waitingScreen.style.display = 'none';
    successScreen.style.display = 'none';
    voteForm.style.display = 'block';
    voterTimerBadge.style.display = 'flex';
  } else {
    voterTimerBadge.style.display = 'none';
    if (timer.remaining === 0) {
      waitingScreen.style.display = 'none';
      successScreen.style.display = 'none';
      voteForm.style.display = 'block';
      disableVoting();
      showError("El tiempo de votación ha finalizado.");
    } else {
      successScreen.style.display = 'none';
      voteForm.style.display = 'none';
      waitingScreen.style.display = 'block';
    }
  }
}

function disableVoting() {
  btnSubmitVote.disabled = true;
  voterSelect.disabled = true;
  vote1Select.disabled = true;
  vote2Select.disabled = true;
}

// 4. Al seleccionar un Participante del Desplegable
function handleVoterSelectChange() {
  const voterName = voterSelect.value;
  const participant = participantsData.find(p => p.nombre === voterName);
  
  if (!participant) return;
  
  // Buscar su comunidad
  const commId = participant.comunidad;
  currentCommunity = communitiesData.find(c => c.id === commId);
  const commNombre = currentCommunity ? currentCommunity.nombre : commId;
  
  // Auto-seleccionar Comunidad
  communitySelect.value = commId;
  
  // Mostrar mensaje de confirmación
  const validationMsg = document.getElementById('voter-validation-msg');
  validationMsg.innerHTML = `✅ Comunidad: <strong>${commNombre}</strong>`;
  
  // Comprobar si este votante concreto ya ha votado (guardado local)
  const savedVote = localStorage.getItem(`voted_${commId}`);
  if (savedVote && localStorage.getItem('voter_name_profile') === voterName) {
    const voteData = JSON.parse(savedVote);
    summaryVote1.textContent = voteData.vote1;
    summaryVote2.textContent = voteData.vote2;
    
    waitingScreen.style.display = 'none';
    voteForm.style.display = 'none';
    successScreen.style.display = 'block';
    return;
  }
  
  // Filtrar miembros de su comunidad (excluyéndose a sí mismo)
  const members = currentCommunity ? currentCommunity.miembros : [];
  const otherMembers = members.filter(m => m !== voterName);
  
  // Poblar los desplegables de voto
  [vote1Select, vote2Select].forEach(selectEl => {
    selectEl.innerHTML = '<option value="" disabled selected>-- Elige a un compañero --</option>';
    otherMembers.forEach(member => {
      const option = document.createElement('option');
      option.value = member;
      option.textContent = member;
      selectEl.appendChild(option);
    });
    selectEl.disabled = false;
  });
  
  // Activar botón de envío
  btnSubmitVote.disabled = false;
}

function restoreVoterState() {
  const savedVoter = localStorage.getItem('voter_name_profile');
  if (savedVoter) {
    voterSelect.value = savedVoter;
    handleVoterSelectChange();
  }
}

// 5. Enviar Formulario de Votación
async function submitVote(event) {
  event.preventDefault();
  
  const voterName = voterSelect.value;
  const commId = communitySelect.value;
  const vote1 = vote1Select.value;
  const vote2 = vote2Select.value;
  
  if (!voterName || !commId || !vote1 || !vote2) {
    showError("Todos los campos del formulario son obligatorios.");
    return;
  }
  
  if (vote1 === vote2) {
    showError("Debes proponer a 2 personas distintas.");
    return;
  }
  
  const payload = {
    communityId: commId,
    voterName: voterName,
    vote1: vote1,
    vote2: vote2
  };
  
  try {
    const res = await fetch('/api/vote', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
    
    const responseData = await res.json();
    
    if (!res.ok) {
      showError(responseData.message || "Error al enviar el voto.");
      return;
    }
    
    // Guardar estado local
    localStorage.setItem(`voted_${commId}`, JSON.stringify({ vote1, vote2 }));
    localStorage.setItem('voter_name_profile', voterName);
    localStorage.setItem('voter_last_community', commId);
    
    // Resumen visual de éxito
    summaryVote1.textContent = vote1;
    summaryVote2.textContent = vote2;
    
    // Cambiar vista a éxito
    voteForm.reset();
    voterSelect.disabled = true;
    voteForm.style.display = 'none';
    successScreen.style.display = 'block';
    
  } catch (err) {
    showError("No se pudo enviar el voto. Comprueba tu conexión de red.");
  }
}

// Mostrar alerta de error temporal
function showError(msg) {
  errorText.textContent = msg;
  errorAlert.style.display = 'flex';
  
  setTimeout(() => {
    if (errorText.textContent === msg) {
      errorAlert.style.display = 'none';
    }
  }, 6000);
}
