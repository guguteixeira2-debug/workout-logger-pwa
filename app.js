/* ==========================================================================
   Workout Logger - App Logic Module
   ========================================================================== */

var API_BASE_URL = "https://script.google.com/macros/s/AKfycbx_SEU_SCRIPT_ID/exec"; // Substituir com seu Endpoint Apps Script

var WORKOUT_ACADEMIAS_KEY = 'workout_sugestoes_academias';
var WORKOUT_TREINOS_KEY = 'workout_sugestoes_treinos';
var WORKOUT_EXERCICIOS_KEY = 'workout_sugestoes_exercicios';
var WORKOUT_CARDIO_TIPOS_KEY = 'workout_sugestoes_cardio_tipos';

// --- Módulos Helper de Armazenamento Offline e Cache ---

var Sugestoes = {
  obter: function (chave) {
    try {
      var itens = localStorage.getItem(chave);
      return itens ? JSON.parse(itens) : [];
    } catch (e) {
      return [];
    }
  },
  adicionar: function (chave, valor) {
    if (!valor || typeof valor !== 'string') return;
    var v = valor.trim();
    if (!v) return;
    var lista = this.obter(chave);
    if (!lista.includes(v)) {
      lista.unshift(v);
      if (lista.length > 30) lista = lista.slice(0, 30);
      try {
        localStorage.setItem(chave, JSON.stringify(lista));
      } catch (e) {}
    }
  },
  preencherDatalist: function (datalistId, chave) {
    var dl = document.getElementById(datalistId);
    if (!dl) return;
    dl.innerHTML = '';
    var lista = this.obter(chave);
    lista.forEach(function (item) {
      var opt = document.createElement('option');
      opt.value = item;
      dl.appendChild(opt);
    });
  }
};

var FilaOffline = {
  CHAVE: 'workout_fila_offline',
  obter: function () {
    try {
      var f = localStorage.getItem(this.CHAVE);
      return f ? JSON.parse(f) : [];
    } catch (e) {
      return [];
    }
  },
  enfileirar: function (tipo, payload) {
    var fila = this.obter();
    fila.push({ tipo: tipo, payload: payload, timestamp: new Date().toISOString() });
    try {
      localStorage.setItem(this.CHAVE, JSON.stringify(fila));
    } catch (e) {}
    this.atualizarBarraStatus();
  },
  limpar: function () {
    localStorage.removeItem(this.CHAVE);
    this.atualizarBarraStatus();
  },
  atualizarBarraStatus: function () {
    var bar = document.getElementById('sync-bar');
    if (!bar) return;
    var fila = this.obter();
    if (fila.length > 0) {
      bar.classList.remove('hidden');
      document.getElementById('sync-bar-text').innerText = 'Possui ' + fila.length + ' registro(s) pendente(s) de envio.';
    } else {
      bar.classList.add('hidden');
    }
  }
};

var WorkoutCache = {
  CHAVE: 'workout_estado_ativo',
  salvar: function (estado) {
    try {
      localStorage.setItem(this.CHAVE, JSON.stringify(estado));
    } catch (e) {}
  },
  carregar: function () {
    try {
      var d = localStorage.getItem(this.CHAVE);
      return d ? JSON.parse(d) : null;
    } catch (e) {
      return null;
    }
  },
  limpar: function () {
    localStorage.removeItem(this.CHAVE);
  }
};

var SessaoCache = {
  CHAVE: 'workout_sessao_historico',
  salvar: function (historico) {
    try {
      localStorage.setItem(this.CHAVE, JSON.stringify(historico));
    } catch (e) {}
  },
  carregar: function () {
    try {
      var h = localStorage.getItem(this.CHAVE);
      return h ? JSON.parse(h) : {};
    } catch (e) {
      return {};
    }
  },
  limpar: function () {
    localStorage.removeItem(this.CHAVE);
  }
};

// --- Módulo Principal da Aplicação ---

var app = (function () {

  var estado = {
    academiaAtual: '',
    nomeTreinoAtual: '',
    exercicioAtual: '',
    inicioTreinoMs: null,
    seriesPorExercicio: {}, // { "Supino Reto": [{ carga, reps, tipo, rpe, obs }, ...] }
    rpeSelecionado: null,
    dadosRelatorio: null
  };

  var rpeGlobalSelecionado = null;
  var rpeCardioSelecionado = null;
  var motivacaoCardioSelecionada = null;

  var timerInterval = null;
  var wakeLock = null;

  // Realiza requisição genérica POST à API
  function apiPost(action, payload) {
    return fetch(API_BASE_URL + '?action=' + action, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function (res) {
      return res.json();
    });
  }

  // Realiza requisição GET à API
  function apiGet(action, params) {
    var query = '?action=' + action;
    if (params) {
      Object.keys(params).forEach(function (k) {
        query += '&' + encodeURIComponent(k) + '=' + encodeURIComponent(params[k]);
      });
    }
    return fetch(API_BASE_URL + query).then(function (res) {
      return res.json();
    });
  }

  // Solicitar o Wake Lock para manter tela ativa
  function solicitarWakeLock() {
    if ('wakeLock' in navigator) {
      navigator.wakeLock.request('screen').then(function (lock) {
        wakeLock = lock;
      }).catch(function (err) {
        console.warn('Wake Lock falhou:', err);
      });
    }
  }

  function liberarTelaAtiva() {
    if (wakeLock) {
      wakeLock.release().then(function () {
        wakeLock = null;
      });
    }
  }

  // Cronômetro
  function iniciarTimer() {
    if (timerInterval) clearInterval(timerInterval);
    var timerDisplay = document.getElementById('timer-display');
    var timerText = document.getElementById('timer-text');
    timerDisplay.classList.remove('hidden');

    timerInterval = setInterval(function () {
      if (!estado.inicioTreinoMs) return;
      var pass = Math.floor((Date.now() - estado.inicioTreinoMs) / 1000);
      var m = Math.floor(pass / 60);
      var s = pass % 60;
      timerText.innerText = (m < 10 ? '0' + m : m) + ':' + (s < 10 ? '0' + s : s);
    }, 1000);
  }

  function pararTimer() {
    if (timerInterval) clearInterval(timerInterval);
    document.getElementById('timer-display').classList.add('hidden');
  }

  // Alternância de Telas
  function mostrarTela(idTela) {
    var telas = ['tela-menu', 'tela-execucao', 'tela-relatorio', 'tela-cardio-registro'];
    telas.forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.classList.add('hidden');
    });
    var ativa = document.getElementById(idTela);
    if (ativa) ativa.classList.remove('hidden');

    var btnHist = document.getElementById('btn-historico');
    if (idTela === 'tela-execucao') {
      if (btnHist) btnHist.style.display = 'block';
    } else {
      if (btnHist) btnHist.style.display = 'none';
    }

    window.scrollTo(0, 0);
  }

  function mostrarLoading(msg) {
    document.getElementById('loading-text').innerText = msg || 'Carregando...';
    document.getElementById('loading-overlay').classList.remove('hidden');
  }

  function ocultarLoading() {
    document.getElementById('loading-overlay').classList.add('hidden');
  }

  // Seletores
  function selecionarRpe(valor) {
    estado.rpeSelecionado = valor;
    document.querySelectorAll('#seletor-rpe .rpe-btn').forEach(function (btn) {
      btn.classList.toggle('selecionada', parseInt(btn.dataset.valor, 10) === valor);
    });
  }

  function selecionarRpeGlobal(valor) {
    rpeGlobalSelecionado = valor;
    document.querySelectorAll('#seletor-rpe-global .rpe-opcao').forEach(function (btn) {
      btn.classList.toggle('selecionada', parseInt(btn.dataset.valor, 10) === valor);
    });
  }

  function selecionarRpeCardio(valor) {
    rpeCardioSelecionado = valor;
    document.querySelectorAll('#seletor-rpe-cardio .rpe-opcao').forEach(function (btn) {
      btn.classList.toggle('selecionada', parseInt(btn.dataset.valor, 10) === valor);
    });
  }

  function selecionarMotivacao(valor) {
    motivacaoCardioSelecionada = valor;
    document.querySelectorAll('#seletor-motivacao .motivacao-opcao').forEach(function (btn) {
      btn.classList.toggle('selecionada', parseInt(btn.dataset.valor, 10) === valor);
    });
  }

  function atualizarBadgeTipoSerie() {
    var sel = document.getElementById('select-tipo-serie');
    var badge = document.getElementById('indicador-tipo-serie');
    if (sel && badge) {
      badge.innerText = sel.value;
    }
  }

  // --- Fluxo de Musculação ---

  function iniciarTreinoMusculacao() {
    var ac = document.getElementById('input-academia').value.trim();
    var tr = document.getElementById('input-nome-treino').value.trim();

    if (!ac || !tr) {
      alert("Por favor, preencha a Academia e o Nome do Treino.");
      return;
    }

    Sugestoes.adicionar(WORKOUT_ACADEMIAS_KEY, ac);
    Sugestoes.adicionar(WORKOUT_TREINOS_KEY, tr);

    estado.academiaAtual = ac;
    estado.nomeTreinoAtual = tr;
    estado.exercicioAtual = '';
    estado.inicioTreinoMs = Date.now();
    estado.seriesPorExercicio = {};

    document.getElementById('app-title').innerText = tr;
    document.getElementById('input-nome-exercicio').value = '';
    document.getElementById('exercicio-atual-display').classList.add('hidden');

    solicitarWakeLock();
    iniciarTimer();
    WorkoutCache.salvar(estado);

    mostrarTela('tela-execucao');
  }

  function confirmarTrocaExercicio() {
    var ex = document.getElementById('input-nome-exercicio').value.trim();
    if (!ex) {
      alert("Informe o nome do exercício.");
      return;
    }

    Sugestoes.adicionar(WORKOUT_EXERCICIOS_KEY, ex);
    estado.exercicioAtual = ex;

    if (!estado.seriesPorExercicio[ex]) {
      estado.seriesPorExercicio[ex] = [];
    }

    var disp = document.getElementById('exercicio-atual-display');
    disp.innerText = ex;
    disp.classList.remove('hidden');

    prepararFormularioSerie();
    renderizarListaSeriesExercicio();
    WorkoutCache.salvar(estado);
  }

  function prepararFormularioSerie() {
    var seriesAtuais = estado.seriesPorExercicio[estado.exercicioAtual] || [];
    var numSerie = seriesAtuais.length + 1;

    document.getElementById('label-num-serie').innerText = numSerie;
    document.getElementById('input-obs-serie').value = '';

    if (seriesAtuais.length > 0) {
      var ultima = seriesAtuais[seriesAtuais.length - 1];
      document.getElementById('input-carga').value = ultima.carga;
      document.getElementById('input-reps').value = ultima.reps;
      selecionarRpe(ultima.rpe);
    } else {
      document.getElementById('input-carga').value = '';
      document.getElementById('input-reps').value = '';
      selecionarRpe(8);
    }
  }

  function registrarSerie() {
    if (!estado.exercicioAtual) {
      confirmarTrocaExercicio();
      if (!estado.exercicioAtual) return;
    }

    var carga = parseFloat(document.getElementById('input-carga').value);
    var reps = parseInt(document.getElementById('input-reps').value, 10);
    var tipo = document.getElementById('select-tipo-serie').value;
    var obs = document.getElementById('input-obs-serie').value.trim();

    if (isNaN(carga) || isNaN(reps) || reps <= 0) {
      alert("Preencha valores válidos de Carga e Repetições.");
      return;
    }

    var novaSerie = {
      numero: estado.seriesPorExercicio[estado.exercicioAtual].length + 1,
      carga: carga,
      reps: reps,
      tipo: tipo,
      rpe: estado.rpeSelecionado || 8,
      obs: obs
    };

    estado.seriesPorExercicio[estado.exercicioAtual].push(novaSerie);
    WorkoutCache.salvar(estado);

    prepararFormularioSerie();
    renderizarListaSeriesExercicio();
  }

  function removerSerie(idx) {
    if (!estado.exercicioAtual || !estado.seriesPorExercicio[estado.exercicioAtual]) return;
    estado.seriesPorExercicio[estado.exercicioAtual].splice(idx, 1);
    
    // Reindexar séries
    estado.seriesPorExercicio[estado.exercicioAtual].forEach(function (s, i) {
      s.numero = i + 1;
    });

    WorkoutCache.salvar(estado);
    prepararFormularioSerie();
    renderizarListaSeriesExercicio();
  }

  function renderizarListaSeriesExercicio() {
    var container = document.getElementById('lista-series-exercicio');
    var series = estado.seriesPorExercicio[estado.exercicioAtual] || [];

    if (series.length === 0) {
      container.innerHTML = '<p class="empty-state">Nenhuma série registrada para este exercício ainda.</p>';
      return;
    }

    var html = '';
    series.forEach(function (s, index) {
      html += '<div class="serie-item">';
      html += '  <div class="serie-info">';
      html += '    <strong>#' + s.numero + '</strong> — ' + s.carga + 'kg × ' + s.reps + ' reps (' + s.tipo + ') [RPE ' + s.rpe + ']';
      if (s.obs) html += '<br><small style="color:var(--text-muted);">' + s.obs + '</small>';
      html += '  </div>';
      html += '  <button class="btn-delete" onclick="app.removerSerie(' + index + ')">🗑️</button>';
      html += '</div>';
    });

    container.innerHTML = html;
  }

  function proximoExercicio() {
    document.getElementById('input-nome-exercicio').value = '';
    document.getElementById('exercicio-atual-display').classList.add('hidden');
    estado.exercicioAtual = '';
    document.getElementById('lista-series-exercicio').innerHTML = '<p class="empty-state">Informe o próximo exercício acima para começar.</p>';
    window.scrollTo(0, 0);
  }

  function irParaRelatorio() {
    var nomesExercicios = Object.keys(estado.seriesPorExercicio);
    var totalSeries = 0;
    var volumeTotal = 0;
    var somaRpe = 0;

    nomesExercicios.forEach(function (ex) {
      estado.seriesPorExercicio[ex].forEach(function (s) {
        totalSeries++;
        volumeTotal += (s.carga * s.reps);
        somaRpe += s.rpe;
      });
    });

    if (totalSeries === 0) {
      alert("Registre ao menos uma série antes de finalizar o treino.");
      return;
    }

    var duracaoMin = Math.round((Date.now() - estado.inicioTreinoMs) / 60000);
    var rpeMedio = (somaRpe / totalSeries).toFixed(1);

    document.getElementById('resumo-duracao').innerText = duracaoMin + ' min';
    document.getElementById('resumo-volume').innerText = volumeTotal.toLocaleString('pt-BR') + ' kg';
    document.getElementById('resumo-series').innerText = totalSeries;
    document.getElementById('resumo-exercicios').innerText = nomesExercicios.length;

    var detalheHtml = '';
    nomesExercicios.forEach(function (ex) {
      var arr = estado.seriesPorExercicio[ex];
      if (arr.length === 0) return;
      detalheHtml += '<div style="margin-bottom: 12px;">';
      detalheHtml += '<strong>' + ex + '</strong>';
      detalheHtml += '<ul style="margin: 4px 0 0 16px; padding: 0; font-size: 0.85rem; color: var(--text-muted);">';
      arr.forEach(function (s) {
        detalheHtml += '<li>#' + s.numero + ': ' + s.carga + 'kg × ' + s.reps + ' (' + s.tipo + ') - RPE ' + s.rpe + '</li>';
      });
      detalheHtml += '</ul></div>';
    });

    document.getElementById('detalhamento-treino-completo').innerHTML = detalheHtml;

    estado.dadosRelatorio = {
      academia: estado.academiaAtual,
      nomeTreino: estado.nomeTreinoAtual,
      duracaoMinutos: duracaoMin,
      volumeTotalKg: volumeTotal,
      totalSeries: totalSeries,
      rpeMedio: rpeMedio,
      exercicios: estado.seriesPorExercicio
    };

    pararTimer();
    mostrarTela('tela-relatorio');
  }

  function voltarParaExecucao() {
    iniciarTimer();
    mostrarTela('tela-execucao');
  }

  function finalizarTreino() {
    var obsGeral = document.getElementById('input-obs-geral').value;
    estado.dadosRelatorio.observacaoGeral = obsGeral;
    estado.dadosRelatorio.rpeGlobal = rpeGlobalSelecionado || estado.dadosRelatorio.rpeMedio;

    var relatorio = estado.dadosRelatorio;

    function concluirNaTela() {
      WorkoutCache.limpar();
      SessaoCache.limpar();
      liberarTelaAtiva();

      document.getElementById('timer-display').classList.add('hidden');
      document.getElementById('app-title').innerText = "Workout Logger";
      var exercicioDisplay = document.getElementById('exercicio-atual-display');
      if (exercicioDisplay) exercicioDisplay.classList.add('hidden');
      mostrarTela('tela-menu');
    }

    if (!navigator.onLine) {
      FilaOffline.enfileirar('treino', relatorio);
      alert("Sem internet no momento — o treino foi salvo no aparelho e será enviado pra planilha assim que a conexão voltar.");
      concluirNaTela();
      return;
    }

    mostrarLoading('Salvando treino completo...');
    apiPost('finalizarTreino', relatorio)
      .then(function () {
        ocultarLoading();
        alert("Treino registrado com sucesso!");
        concluirNaTela();
      })
      .catch(function (err) {
        ocultarLoading();
        console.warn('Falha ao salvar treino online, será sincronizado depois:', err);
        FilaOffline.enfileirar('treino', relatorio);
        alert("Não consegui conectar agora — o treino foi salvo no aparelho e será enviado assim que a conexão voltar.");
        concluirNaTela();
      });
  }

  // --- Fluxo de Cardio ---

  function iniciarRegistroCardio() {
    var ac = document.getElementById('input-academia').value.trim();
    if (ac) {
      estado.academiaAtual = ac;
      Sugestoes.adicionar(WORKOUT_ACADEMIAS_KEY, ac);
    }
    prepararTelaCardio();
  }

  function prepararTelaCardio() {
    document.getElementById('cardio-academia-display').innerText = 'Academia: ' + (estado.academiaAtual || '--');
    document.getElementById('input-cardio-tipo-registro').value = '';
    document.getElementById('input-cardio-duracao-registro').value = '';
    document.getElementById('input-cardio-distancia').value = '';
    document.getElementById('input-cardio-velocidade').value = '';
    document.getElementById('input-cardio-bpm').value = '';
    document.getElementById('input-cardio-inclinacao').value = '';
    document.getElementById('input-cardio-obs-registro').value = '';
    Sugestoes.preencherDatalist('lista-cardio-tipos', WORKOUT_CARDIO_TIPOS_KEY);

    motivacaoCardioSelecionada = null;
    rpeCardioSelecionado = null;

    document.querySelectorAll('#seletor-motivacao .motivacao-opcao').forEach(function (btn) {
      btn.classList.remove('selecionada');
    });
    document.querySelectorAll('#seletor-rpe-cardio .rpe-opcao').forEach(function (btn) {
      btn.classList.remove('selecionada');
    });

    mostrarTela('tela-cardio-registro');
  }

  function salvarCardio() {
    var tipo = document.getElementById('input-cardio-tipo-registro').value.trim();
    var duracao = document.getElementById('input-cardio-duracao-registro').value;
    var distancia = document.getElementById('input-cardio-distancia').value;
    var velocidade = document.getElementById('input-cardio-velocidade').value;
    var bpm = document.getElementById('input-cardio-bpm').value;
    var inclinacao = document.getElementById('input-cardio-inclinacao').value;
    var obs = document.getElementById('input-cardio-obs-registro').value.trim();

    if (motivacaoCardioSelecionada === null) {
      alert("Selecione sua motivação de início (0 a 5) antes de salvar.");
      return;
    }

    var payload = {
      academia: estado.academiaAtual,
      tipo: tipo,
      duracao: duracao,
      distancia: distancia,
      velocidadeMedia: velocidade,
      bpmMedio: bpm,
      inclinacaoMedia: inclinacao,
      rpeCardio: rpeCardioSelecionado || '',
      motivacaoInicio: motivacaoCardioSelecionada,
      observacao: obs
    };

    Sugestoes.adicionar(WORKOUT_CARDIO_TIPOS_KEY, tipo);

    function concluirCardio() {
      mostrarTela('tela-menu');
    }

    if (!navigator.onLine) {
      FilaOffline.enfileirar('cardio', payload);
      alert("Sem internet no momento — o cardio foi salvo no aparelho e será enviado assim que a conexão voltar.");
      concluirCardio();
      return;
    }

    mostrarLoading('Salvando cardio...');
    apiPost('salvarCardio', payload)
      .then(function () {
        ocultarLoading();
        alert("Cardio registrado com sucesso!");
        concluirCardio();
      })
      .catch(function (err) {
        ocultarLoading();
        console.warn('Falha ao salvar cardio online, será sincronizado depois:', err);
        FilaOffline.enfileirar('cardio', payload);
        alert("Não consegui conectar agora — o cardio foi salvo no aparelho e será enviado assim que a conexão voltar.");
        concluirCardio();
      });
  }

  // --- Histórico / Modal ---

  function abrirHistorico() {
    var ex = estado.exercicioAtual;
    if (!ex) return;

    var modal = document.getElementById('modal-historico');
    var corpo = document.getElementById('modal-historico-corpo');
    document.getElementById('modal-historico-titulo').innerText = 'Histórico: ' + ex;
    corpo.innerHTML = '<p class="empty-state">Buscando dados no histórico...</p>';
    modal.classList.remove('hidden');

    apiGet('obterHistoricoExercicio', { exercicio: ex })
      .then(function (res) {
        if (!res || !res.historico || res.historico.length === 0) {
          corpo.innerHTML = '<p class="empty-state">Nenhum registro anterior encontrado para este exercício.</p>';
          return;
        }

        var html = '';
        res.historico.forEach(function (h) {
          html += '<div style="border-bottom:1px solid var(--border-color); padding: 8px 0;">';
          html += '<small style="color:var(--accent); font-weight:bold;">' + h.data + '</small><br>';
          html += '<strong>' + h.carga + 'kg</strong> × ' + h.reps + ' reps (RPE ' + h.rpe + ')';
          html += '</div>';
        });
        corpo.innerHTML = html;
      })
      .catch(function (err) {
        corpo.innerHTML = '<p class="empty-state">Não foi possível carregar o histórico offline.</p>';
      });
  }

  function fecharHistorico() {
    document.getElementById('modal-historico').classList.add('hidden');
  }

  // --- Inicialização do App ---

  function init() {
    Sugestoes.preencherDatalist('lista-academias', WORKOUT_ACADEMIAS_KEY);
    Sugestoes.preencherDatalist('lista-nomes-treino', WORKOUT_TREINOS_KEY);
    Sugestoes.preencherDatalist('lista-exercicios', WORKOUT_EXERCICIOS_KEY);
    Sugestoes.preencherDatalist('lista-cardio-tipos', WORKOUT_CARDIO_TIPOS_KEY);

    FilaOffline.atualizarBarraStatus();

    // Sincronização automática quando voltar a ficar online
    window.addEventListener('online', function () {
      var fila = FilaOffline.obter();
      if (fila.length === 0) return;

      mostrarLoading('Sincronizando registros offline...');
      var promessas = fila.map(function (item) {
        var action = item.tipo === 'cardio' ? 'salvarCardio' : 'finalizarTreino';
        return apiPost(action, item.payload);
      });

      Promise.all(promessas)
        .then(function () {
          FilaOffline.limpar();
          ocultarLoading();
          alert("Todos os treinos salvos offline foram sincronizados!");
        })
        .catch(function (err) {
          ocultarLoading();
          console.warn('Falha na sincronização offline:', err);
        });
    });

    // Recuperação de sessão ativa se houver
    var estadoSalvo = WorkoutCache.carregar();
    if (estadoSalvo && estadoSalvo.inicioTreinoMs) {
      if (confirm("Você possui uma sessão de treino em andamento. Deseja retomar?")) {
        estado = estadoSalvo;
        document.getElementById('app-title').innerText = estado.nomeTreinoAtual;
        solicitarWakeLock();
        iniciarTimer();
        mostrarTela('tela-execucao');
        if (estado.exercicioAtual) {
          document.getElementById('input-nome-exercicio').value = estado.exercicioAtual;
          confirmarTrocaExercicio();
        }
      } else {
        WorkoutCache.limpar();
      }
    }
  }

  window.addEventListener('DOMContentLoaded', init);

  return {
    iniciarTreinoMusculacao: iniciarTreinoMusculacao,
    confirmarTrocaExercicio: confirmarTrocaExercicio,
    selecionarRpe: selecionarRpe,
    selecionarRpeGlobal: selecionarRpeGlobal,
    selecionarRpeCardio: selecionarRpeCardio,
    selecionarMotivacao: selecionarMotivacao,
    atualizarBadgeTipoSerie: atualizarBadgeTipoSerie,
    registrarSerie: registrarSerie,
    removerSerie: removerSerie,
    proximoExercicio: proximoExercicio,
    irParaRelatorio: irParaRelatorio,
    voltarParaExecucao: voltarParaExecucao,
    finalizarTreino: finalizarTreino,
    iniciarRegistroCardio: iniciarRegistroCardio,
    salvarCardio: salvarCardio,
    abrirHistorico: abrirHistorico,
    fecharHistorico: fecharHistorico,
    mostrarTela: mostrarTela
  };

})();
