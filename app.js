/**
 * CAMADA DE COMUNICAÇÃO COM O BACKEND (Apps Script), via fetch().
 *
 * IMPORTANTE: troque a URL abaixo pela URL do SEU Web App do Apps Script
 * (Extensões > Apps Script > Implantar > Gerenciar implantações > copiar a URL "...exec").
 */
const API_BASE_URL = "https://script.google.com/macros/s/AKfycbwN7f3Pm4qFxDjIzaTl0bDPjwrI5NiffrQmAi2MvZwhE83-Chws4zzYHuTuroRRKMHaKA/exec";

function apiGet(action, params) {
  var url = API_BASE_URL + '?action=' + encodeURIComponent(action);
  if (params) {
    Object.keys(params).forEach(function (chave) {
      url += '&' + encodeURIComponent(chave) + '=' + encodeURIComponent(params[chave]);
    });
  }
  return fetch(url).then(function (resposta) { return resposta.json(); })
    .then(function (dados) {
      if (dados && dados.erro) throw new Error(dados.mensagem || 'Erro desconhecido na API');
      return dados;
    });
}

function apiPost(action, payload) {
  return fetch(API_BASE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ action: action, payload: payload })
  }).then(function (resposta) { return resposta.json(); })
    .then(function (dados) {
      if (dados && dados.erro) throw new Error(dados.mensagem || 'Erro desconhecido na API');
      return dados;
    });
}

/**
 * TRAVA DE SEGURANÇA: IMPEDE FECHAMENTO/RECARREGAMENTO ACIDENTAL DA ABA
 */
window.addEventListener('beforeunload', function (e) {
  if (typeof app !== 'undefined' && app.isTreinoAtivo && app.isTreinoAtivo()) {
    e.preventDefault();
    e.returnValue = 'Você tem um treino em andamento. Deseja realmente sair e perder os dados digitados?';
    return e.returnValue;
  }
});

/**
 * MÓDULO DE PERSISTÊNCIA LOCAL (localStorage)
 */
const WORKOUT_STORAGE_KEY = 'WORKOUT_LOGGER_RASCUNHO';

const WorkoutCache = {
  salvar: function() {
    try {
      var inputs = document.querySelectorAll('input, select, textarea');
      var dadosInputs = {};

      inputs.forEach(function(input, idx) {
        var chave = input.id || ('input_' + idx);
        dadosInputs[chave] = input.value;
      });

      var rascunho = {
        timestamp: new Date().getTime(),
        dadosInputs: dadosInputs
      };

      localStorage.setItem(WORKOUT_STORAGE_KEY, JSON.stringify(rascunho));
    } catch (e) {
      console.warn('Erro ao salvar rascunho:', e);
    }
  },

  restaurar: function() {
    try {
      var rascunhoBruto = localStorage.getItem(WORKOUT_STORAGE_KEY);
      if (!rascunhoBruto) return;

      var rascunho = JSON.parse(rascunhoBruto);
      var dozeHoras = 12 * 60 * 60 * 1000;
      if (new Date().getTime() - rascunho.timestamp > dozeHoras) {
        this.limpar();
        return;
      }

      if (rascunho.dadosInputs) {
        Object.keys(rascunho.dadosInputs).forEach(function(chave) {
          var el = document.getElementById(chave);
          if (el && rascunho.dadosInputs[chave] !== undefined) {
            el.value = rascunho.dadosInputs[chave];
          }
        });
      }
      console.log('Rascunho de treino restaurado com sucesso!');
    } catch (e) {
      console.error('Erro ao restaurar rascunho:', e);
    }
  },

  limpar: function() {
    localStorage.removeItem(WORKOUT_STORAGE_KEY);
  }
};

/**
 * MÓDULO DE SESSÃO ATIVA (para "recuperar treino interrompido")
 * Diferente do WorkoutCache (que só guarda os campos visíveis do formulário),
 * este guarda o estado inteiro do treino em andamento: rotina, fila de
 * exercícios, índice atual, séries já registradas e o horário de início.
 */
const WORKOUT_SESSAO_KEY = 'WORKOUT_LOGGER_SESSAO_ATIVA';

const SessaoCache = {
  salvar: function (dados) {
    try {
      dados.timestamp = Date.now();
      localStorage.setItem(WORKOUT_SESSAO_KEY, JSON.stringify(dados));
    } catch (e) {
      console.warn('Erro ao salvar sessão do treino:', e);
    }
  },

  obter: function () {
    try {
      var bruto = localStorage.getItem(WORKOUT_SESSAO_KEY);
      if (!bruto) return null;

      var sessao = JSON.parse(bruto);
      var dozeHoras = 12 * 60 * 60 * 1000;
      if (Date.now() - sessao.timestamp > dozeHoras) {
        this.limpar();
        return null;
      }
      return sessao;
    } catch (e) {
      return null;
    }
  },

  limpar: function () {
    localStorage.removeItem(WORKOUT_SESSAO_KEY);
  }
};

/**
 * MÓDULO DE FILA OFFLINE
 * Quando não há internet (ou a chamada ao servidor falha), o registro do
 * exercício/treino é guardado aqui em vez de perdido. Assim que a conexão
 * volta (evento 'online' ou verificação periódica), a fila é reenviada
 * para a planilha, um item de cada vez, na ordem em que foram criados.
 */
const WORKOUT_FILA_KEY = 'WORKOUT_LOGGER_FILA_PENDENTE';

const FilaOffline = {
  listar: function () {
    try {
      var bruto = localStorage.getItem(WORKOUT_FILA_KEY);
      return bruto ? JSON.parse(bruto) : [];
    } catch (e) {
      return [];
    }
  },

  salvarLista: function (lista) {
    try {
      localStorage.setItem(WORKOUT_FILA_KEY, JSON.stringify(lista));
    } catch (e) {
      console.warn('Erro ao salvar fila offline:', e);
    }
  },

  enfileirar: function (tipo, payload) {
    var lista = this.listar();
    lista.push({
      id: Date.now() + '_' + Math.random().toString(36).slice(2),
      tipo: tipo, // 'exercicio' ou 'treino'
      payload: payload,
      timestamp: Date.now()
    });
    this.salvarLista(lista);
    atualizarStatusConexao();
  },

  remover: function (id) {
    var lista = this.listar().filter(function (item) { return item.id !== id; });
    this.salvarLista(lista);
    atualizarStatusConexao();
  },

  tamanho: function () {
    return this.listar().length;
  },

  // Processa um item por vez, em ordem, para não sobrecarregar o servidor
  // nem embaralhar a ordem das séries/exercícios na planilha.
  processando: false,

  processar: function () {
    if (this.processando) return;
    if (!navigator.onLine) return;

    var lista = this.listar();
    if (lista.length === 0) return;

    var item = lista[0];
    this.processando = true;

    var finalizarProcessamento = function () {
      FilaOffline.processando = false;
      FilaOffline.processar();
    };

    var acaoPorTipo = {
      exercicio: 'salvarExercicioCompleto',
      treino: 'finalizarTreino',
      cardio: 'salvarCardio'
    };
    var acao = acaoPorTipo[item.tipo];

    if (!acao) {
      FilaOffline.remover(item.id);
      finalizarProcessamento();
      return;
    }

    apiPost(acao, item.payload)
      .then(function () {
        FilaOffline.remover(item.id);
        finalizarProcessamento();
      })
      .catch(function (err) {
        console.warn('Falha ao sincronizar item da fila offline, tentando novamente mais tarde:', err);
        finalizarProcessamento();
      });
  }
};

/**
 * Atualiza a faixa de status de conexão no topo da tela.
 */
function atualizarStatusConexao() {
  var el = document.getElementById('status-conexao');
  if (!el) return;

  var pendentes = FilaOffline.tamanho();

  if (!navigator.onLine) {
    el.className = 'offline';
    el.innerText = pendentes > 0
      ? '📴 Sem internet — ' + pendentes + ' registro(s) salvo(s) no aparelho, aguardando conexão'
      : '📴 Sem internet — os próximos registros serão salvos no aparelho';
  } else if (pendentes > 0) {
    el.className = 'sincronizando';
    el.innerText = '🔄 Sincronizando ' + pendentes + ' registro(s) pendente(s)...';
  } else {
    el.className = '';
    el.innerText = '';
  }
}

window.addEventListener('online', function () {
  atualizarStatusConexao();
  FilaOffline.processar();
});

window.addEventListener('offline', function () {
  atualizarStatusConexao();
});

// Nova tentativa periódica, cobrindo casos em que o evento 'online' não dispara
// de forma confiável (comum em alguns navegadores mobile).
setInterval(function () {
  if (navigator.onLine) FilaOffline.processar();
}, 30000);

/**
 * MÓDULO DE SUGESTÕES (autocomplete de Academia e Tipo de Cardio)
 * Guarda os valores já digitados em localStorage e alimenta um <datalist>,
 * mostrando os mais recentes primeiro.
 */
const WORKOUT_ACADEMIAS_KEY = 'WORKOUT_LOGGER_ACADEMIAS';
const WORKOUT_CARDIO_TIPOS_KEY = 'WORKOUT_LOGGER_CARDIO_TIPOS';

const Sugestoes = {
  obter: function (chave) {
    try {
      var bruto = localStorage.getItem(chave);
      return bruto ? JSON.parse(bruto) : [];
    } catch (e) {
      return [];
    }
  },

  adicionar: function (chave, valor) {
    valor = (valor || '').trim();
    if (!valor) return;

    var lista = this.obter(chave);
    var idxExistente = lista.findIndex(function (v) { return v.toLowerCase() === valor.toLowerCase(); });
    if (idxExistente !== -1) lista.splice(idxExistente, 1);
    lista.unshift(valor);
    lista = lista.slice(0, 20);

    try {
      localStorage.setItem(chave, JSON.stringify(lista));
    } catch (e) {
      console.warn('Erro ao salvar sugestão:', e);
    }
  },

  preencherDatalist: function (idDatalist, chave) {
    var el = document.getElementById(idDatalist);
    if (!el) return;

    el.innerHTML = '';
    this.obter(chave).forEach(function (valor) {
      var opt = document.createElement('option');
      opt.value = valor;
      el.appendChild(opt);
    });
  }
};

/**
 * Workout Logger - Client Side Engine
 */
var app = (function () {
  // ESTADO DA APLICAÇÃO
  var estado = {
    isAquecimento: false,
    rotinaAtual: null,
    rotinaEscolhida: null,
    academiaAtual: '',
    exercicios: [],
    indexExercicioAtual: 0,
    seriesExercicioAtual: [],
    historicoExercicioAtual: null,

    // Limites de tempo de descanso (minutos), configurados por treino na planilha
    limiteAvisoMin: 3,
    limiteAlertaMin: 6,

    // Controle de Edição de Série
    indexSerieEmEdicao: null,

    // Cronômetros
    timerTreinoId: null,
    tempoTreinoSegundos: 0,

    timerExercicioId: null,
    tempoExercicioSegundos: 0,

    timerDescansoId: null,
    tempoDescansoSegundos: 0,

    // Métricas Consolidadas do Treino
    resumoExerciciosFinalizados: []
  };

  // VARIÁVEIS PARA CÁLCULO DE TEMPO ABSOLUTO (PONTO INICIAL)
  var tempoInicioTreino = null;
  var tempoInicioExercicio = null;
  var tempoInicioDescanso = null;

  // WAKE LOCK (impedir a tela de suspender)
  var wakeLockSentinel = null;
  var wakeLockDesejado = false;

  // CRONÔMETRO DE DESCANSO EM TELA CHEIA (modal)
  var cronometroModalId = null;

  // CALENDÁRIO DE CONSTÂNCIA (tela de menu)
  var calendarioAnoAtual = null;
  var calendarioMesAtual = null; // 1-12

  // REGISTRO DE CARDIO
  var motivacaoCardioSelecionada = null;

  function isTreinoAtivo() {
    return estado.timerTreinoId !== null;
  }

  // CÁLCULO DE 1RM ESTIMADO (FÓRMULA DE EPLEY) — ESPELHA Relatorios.calcular1RM NO BACKEND
  function calcular1RM(peso, reps) {
    var p = parseFloat(peso) || 0;
    var r = parseInt(reps, 10) || 0;

    if (p <= 0 || r <= 0) return 0;
    if (r === 1) return p;

    return p * (1 + r / 30);
  }

  // Atualiza o preview de 1RM no formulário, ao digitar peso/reps (antes de salvar)
  function atualizarPreview1RM() {
    var preview = document.getElementById('preview-1rm');
    if (!preview) return;

    var peso = document.getElementById('input-peso').value;
    var reps = document.getElementById('input-reps').value;
    var est = calcular1RM(peso, reps);

    preview.innerText = est > 0 ? '1RM estimado: ' + est.toFixed(1) + ' kg' : '1RM estimado: --';
  }

  // WAKE LOCK — impede a tela de suspender enquanto o treino está em andamento
  function alternarTelaAtiva() {
    if (wakeLockDesejado) {
      wakeLockDesejado = false;
      if (wakeLockSentinel) {
        wakeLockSentinel.release().catch(function () {});
      }
      atualizarBotaoTelaAtiva(false);
      return;
    }

    wakeLockDesejado = true;
    solicitarWakeLock();
  }

  function solicitarWakeLock() {
    if (!('wakeLock' in navigator)) {
      alert('Seu navegador não suporta manter a tela ativa automaticamente. Ajuste isso nas configurações de tela do seu celular, se precisar.');
      wakeLockDesejado = false;
      return;
    }

    navigator.wakeLock.request('screen').then(function (sentinel) {
      wakeLockSentinel = sentinel;
      atualizarBotaoTelaAtiva(true);

      sentinel.addEventListener('release', function () {
        wakeLockSentinel = null;
        // Não mexe em wakeLockDesejado aqui: a liberação pode ter sido automática
        // (ex: app foi pra segundo plano) — tentamos readquirir ao voltar (ver visibilitychange abaixo).
      });
    }).catch(function (err) {
      console.warn('Não foi possível manter a tela ativa:', err);
      wakeLockDesejado = false;
      atualizarBotaoTelaAtiva(false);
      alert('Não foi possível manter a tela ativa neste momento (' + (err && err.message ? err.message : 'motivo desconhecido') + '). Se estiver usando o app instalado via atalho/casca, isso pode ser uma permissão bloqueada — tente também pelo navegador direto.');
    });
  }

  function atualizarBotaoTelaAtiva(ativo) {
    var btn = document.getElementById('btn-tela-ativa');
    if (!btn) return;
    btn.innerText = ativo ? '🔓 Tela ativa (toque para permitir suspender)' : '🔒 Manter tela ativa durante o treino';
    btn.classList.toggle('tela-ativa-ligada', ativo);
  }

  // Usado ao encerrar/sair do treino, para não deixar a trava de tela ligada à toa
  function liberarTelaAtiva() {
    wakeLockDesejado = false;
    if (wakeLockSentinel) {
      wakeLockSentinel.release().catch(function () {});
    }
    atualizarBotaoTelaAtiva(false);
  }

  // Reaquire o Wake Lock ao voltar pro app, se o usuário tinha ativado antes
  // (o navegador libera automaticamente quando a aba vai pra segundo plano).
  document.addEventListener('visibilitychange', function () {
    if (wakeLockDesejado && document.visibilityState === 'visible' && !wakeLockSentinel) {
      solicitarWakeLock();
    }
  });

  // CRONÔMETRO DE DESCANSO EM TELA CHEIA (modal, contagem regressiva)
  // Cronômetro simples, progressivo (conta pra cima a partir de 00:00).
  // Serve só pra você acompanhar quanto tempo já passou — sem alvo, sem alarme.
  function abrirCronometroDescanso() {
    var ex = estado.exercicios[estado.indexExercicioAtual];
    var segundosDecorridos = 0;

    var displayTempo = document.getElementById('modal-cronometro-tempo');
    var displayExercicio = document.getElementById('modal-cronometro-exercicio');

    displayTempo.innerText = '00:00';
    displayExercicio.innerText = ex ? ex.exercicio : '';

    document.getElementById('modal-cronometro').classList.remove('hidden');

    if (cronometroModalId) clearInterval(cronometroModalId);
    cronometroModalId = setInterval(function () {
      segundosDecorridos++;
      var mins = Math.floor(segundosDecorridos / 60);
      var segs = segundosDecorridos % 60;
      var mStr = mins < 10 ? '0' + mins : mins;
      var sStr = segs < 10 ? '0' + segs : segs;
      displayTempo.innerText = mStr + ':' + sStr;
    }, 1000);
  }

  function fecharCronometroDescanso() {
    document.getElementById('modal-cronometro').classList.add('hidden');
    if (cronometroModalId) {
      clearInterval(cronometroModalId);
      cronometroModalId = null;
    }
  }

  // ESPELHAM Relatorios.gs — usadas para dar um resumo imediato quando offline
  function calcularVolumeExercicioCliente(series) {
    var total = 0;
    series.forEach(function (s) {
      total += (parseFloat(s.peso) || 0) * (parseInt(s.repeticoes, 10) || 0);
    });
    return total;
  }

  function calcularRpeMedioCliente(series) {
    var soma = 0, contador = 0;
    series.forEach(function (s) {
      var r = parseFloat(s.rpe) || 0;
      if (r > 0) { soma += r; contador++; }
    });
    return contador > 0 ? soma / contador : 0;
  }

  function calcularMaior1RMCliente(series) {
    var maior = 0;
    series.forEach(function (s) {
      var est = calcular1RM(s.peso, s.repeticoes);
      if (est > maior) maior = est;
    });
    return maior;
  }

  // Salva o estado inteiro do treino em andamento, para recuperação caso o app feche
  function salvarSessao() {
    if (!estado.rotinaAtual) return;
    SessaoCache.salvar({
      rotinaAtual: estado.rotinaAtual,
      academiaAtual: estado.academiaAtual,
      exercicios: estado.exercicios,
      indexExercicioAtual: estado.indexExercicioAtual,
      seriesExercicioAtual: estado.seriesExercicioAtual,
      resumoExerciciosFinalizados: estado.resumoExerciciosFinalizados,
      tempoInicioTreino: tempoInicioTreino,
      limiteAvisoMin: estado.limiteAvisoMin,
      limiteAlertaMin: estado.limiteAlertaMin
    });
  }

  function confirmarEncerrarTreino() {
    var confirma = confirm("Deseja realmente finalizar o treino agora e ver o relatório?");
    if (confirma) {
      exibirRelatorioFinal();
    }
  }

  // INICIALIZAÇÃO
  function init() {
    atualizarStatusConexao();
    FilaOffline.processar();

    var sessao = SessaoCache.obter();
    if (sessao && sessao.rotinaAtual && sessao.exercicios && sessao.exercicios.length > 0) {
      var minutosAtras = Math.max(0, Math.floor((Date.now() - sessao.timestamp) / 60000));
      var continuar = confirm(
        'Encontramos um treino em andamento: "' + sessao.rotinaAtual + '" (última atividade há ' + minutosAtras + ' min).\n\nDeseja continuar de onde parou?'
      );

      if (continuar) {
        restaurarSessao(sessao);
        return;
      }
      SessaoCache.limpar();
    }

    carregarRotinas();
  }

  // RESTAURA UM TREINO INTERROMPIDO A PARTIR DA SESSÃO SALVA
  function restaurarSessao(sessao) {
    estado.rotinaAtual = sessao.rotinaAtual;
    estado.academiaAtual = sessao.academiaAtual || '';
    estado.exercicios = sessao.exercicios;
    estado.indexExercicioAtual = sessao.indexExercicioAtual;
    estado.resumoExerciciosFinalizados = sessao.resumoExerciciosFinalizados || [];
    estado.limiteAvisoMin = sessao.limiteAvisoMin || 3;
    estado.limiteAlertaMin = sessao.limiteAlertaMin || 6;

    atualizarListaExercicios(sessao.exercicios);
    document.getElementById('app-title').innerText = sessao.rotinaAtual;

    // O cronômetro do treino usa o horário de início ORIGINAL, então o tempo
    // decorrido continua correto mesmo depois do app ter ficado fechado.
    pararTimerTreino(); // precisa vir ANTES — essa função zera tempoInicioTreino
    tempoInicioTreino = sessao.tempoInicioTreino || Date.now();
    document.getElementById('timer-display').classList.remove('hidden');
    var horarioInicioEl = document.getElementById('horario-inicio-display');
    if (horarioInicioEl) {
      horarioInicioEl.innerText = 'Início: ' + formatarHorario(tempoInicioTreino);
      horarioInicioEl.classList.remove('hidden');
    }
    var tempoDescansoHeaderElRestaurado = document.getElementById('tempo-descanso-header');
    if (tempoDescansoHeaderElRestaurado) tempoDescansoHeaderElRestaurado.classList.remove('hidden');
    var btnAntecipado = document.getElementById('btn-encerrar-antecipado');
    if (btnAntecipado) btnAntecipado.classList.remove('hidden');
    estado.timerTreinoId = setInterval(function () {
      var msPassados = Date.now() - tempoInicioTreino;
      estado.tempoTreinoSegundos = Math.floor(msPassados / 1000);
      document.getElementById('timer-display').innerText = formatarTempo(estado.tempoTreinoSegundos);
    }, 1000);

    if (estado.indexExercicioAtual < estado.exercicios.length) {
      // carregarExercicioAtual() zera as séries do exercício e busca o histórico
      // no servidor (assíncrono); repomos as séries salvas logo em seguida.
      carregarExercicioAtual();
      estado.seriesExercicioAtual = sessao.seriesExercicioAtual || [];
      atualizarPainelInformacoesSuperiores();
      atualizarTabelaSeries();
    } else {
      exibirRelatorioFinal();
    }
  }

  // NAVEGAÇÃO E REGRAS DE TELA
  function mostrarTela(idTela) {
    document.getElementById('tela-menu').classList.add('hidden');
    document.getElementById('tela-pre-treino').classList.add('hidden');
    document.getElementById('tela-treino').classList.add('hidden');
    document.getElementById('tela-relatorio').classList.add('hidden');
    document.getElementById('tela-cardio-registro').classList.add('hidden');
    document.getElementById(idTela).classList.remove('hidden');

    if (idTela === 'tela-menu') {
      if (calendarioAnoAtual === null) {
        inicializarCalendario();
      } else {
        carregarCalendario();
      }
    }
  }

  function mostrarLoading(mensagem) {
    var overlay = document.getElementById('loading-overlay');
    var txt = document.getElementById('loading-text');
    if (txt && mensagem) txt.innerText = mensagem;
    overlay.classList.remove('hidden');
  }

  function ocultarLoading() {
    document.getElementById('loading-overlay').classList.add('hidden');
  }

  // CARREGAMENTO DAS ROTINAS (MENU PRINCIPAL)
  function carregarRotinas() {
    mostrarLoading('Carregando rotinas...');
    apiGet('listarRotinas')
      .then(function (rotinas) {
        var container = document.getElementById('lista-rotinas');
        container.innerHTML = '';

        rotinas.forEach(function (rotina) {
          var item = document.createElement('div');
          item.className = 'menu-item';
          item.innerText = rotina;
          item.onclick = function () { escolherRotina(rotina); };
          container.appendChild(item);
        });

        ocultarLoading();
        mostrarTela('tela-menu');
      })
      .catch(function (err) {
        ocultarLoading();
        alert("Erro ao carregar rotinas: " + err.message);
      });
  }

  // PROCESSA E ATUALIZA A LISTA DO DIA (popula o dropdown de exercício atual)
  function atualizarListaExercicios(exercicios) {
    var select = document.getElementById('select-exercicio');
    if (select) {
      select.innerHTML = '<option value="">Selecione um exercício...</option>';
      exercicios.forEach(function(item) {
        var opt = document.createElement('option');
        opt.value = item.exercicio;
        opt.innerText = item.exercicio;
        select.appendChild(opt);
      });
    }
  }

  // SELEÇÃO DIRETA PELO DROPDOWN "EXERCÍCIO ATUAL"
  function selecionarExercicio(nomeExercicio) {
    if (!nomeExercicio) return;
    var idx = estado.exercicios.findIndex(function(item) {
      return item.exercicio.toLowerCase() === nomeExercicio.toLowerCase();
    });

    if (idx !== -1) {
      estado.indexExercicioAtual = idx;
      carregarExercicioAtual();
    }
  }

  // BOTÃO "EXERCÍCIO ANTERIOR"
  // No primeiro exercício, funciona como "sair do treino" (volta ao menu).
  // Nos demais, volta para o exercício anterior e restaura as séries que já
  // tinham sido registradas nele (caso já estivesse finalizado).
  function exercicioAnterior() {
    if (estado.indexExercicioAtual === 0) {
      var sair = confirm(
        "Você está no primeiro exercício. Deseja sair do treino e voltar ao menu?\n\n" +
        "Séries deste exercício ainda não finalizadas serão perdidas."
      );
      if (!sair) return;

      pararTimerTreino();
      pararTimerExercicio();
      pararTimerDescanso();
      liberarTelaAtiva();
      SessaoCache.limpar();

      document.getElementById('timer-display').classList.add('hidden');
      document.getElementById('app-title').innerText = "Workout Logger";
      var exercicioDisplay = document.getElementById('exercicio-atual-display');
      if (exercicioDisplay) exercicioDisplay.classList.add('hidden');
      var tempoDescansoHeaderElSaida = document.getElementById('tempo-descanso-header');
      if (tempoDescansoHeaderElSaida) tempoDescansoHeaderElSaida.classList.add('hidden');
      var btnAntecipado = document.getElementById('btn-encerrar-antecipado');
      if (btnAntecipado) btnAntecipado.classList.add('hidden');

      mostrarTela('tela-menu');
      return;
    }

    estado.indexExercicioAtual--;

    var exercicioAlvo = estado.exercicios[estado.indexExercicioAtual].exercicio;
    var resumoAnterior = null;

    // Se o exercício anterior já tinha sido finalizado, remove ele do resumo
    // do treino e recupera as séries pra edição.
    var ultimoResumo = estado.resumoExerciciosFinalizados[estado.resumoExerciciosFinalizados.length - 1];
    if (ultimoResumo && ultimoResumo.exercicio === exercicioAlvo) {
      resumoAnterior = estado.resumoExerciciosFinalizados.pop();
    }

    carregarExercicioAtual();

    if (resumoAnterior) {
      estado.seriesExercicioAtual = resumoAnterior.seriesData || [];
      atualizarPainelInformacoesSuperiores();
      atualizarTabelaSeries();
    }

    salvarSessao();
  }

  // ABRE A TELA PRÉ-TREINO (pergunta a academia antes de começar as séries)
  function escolherRotina(nomeRotina) {
    estado.rotinaEscolhida = nomeRotina;
    document.getElementById('pre-treino-nome-rotina').innerText = nomeRotina;
    Sugestoes.preencherDatalist('lista-academias', WORKOUT_ACADEMIAS_KEY);
    document.getElementById('input-academia-inicio').value = '';
    mostrarTela('tela-pre-treino');
  }

  // CONFIRMA A ACADEMIA E EFETIVAMENTE INICIA O TREINO (ou o registro de cardio)
  function confirmarInicioTreino() {
    var academia = document.getElementById('input-academia-inicio').value.trim();
    estado.academiaAtual = academia;
    Sugestoes.adicionar(WORKOUT_ACADEMIAS_KEY, academia);

    if (estado.rotinaEscolhida.toLowerCase() === 'cardio') {
      prepararTelaCardio();
      return;
    }

    selecionarRotina(estado.rotinaEscolhida);
  }

  // PREPARA E ABRE A TELA DE REGISTRO DE CARDIO
  function prepararTelaCardio() {
    document.getElementById('cardio-academia-display').innerText = 'Academia: ' + (estado.academiaAtual || '--');
    document.getElementById('input-cardio-tipo-registro').value = '';
    document.getElementById('input-cardio-duracao-registro').value = '';
    document.getElementById('input-cardio-bpm').value = '';
    document.getElementById('input-cardio-obs-registro').value = '';
    Sugestoes.preencherDatalist('lista-cardio-tipos', WORKOUT_CARDIO_TIPOS_KEY);

    motivacaoCardioSelecionada = null;
    document.querySelectorAll('#seletor-motivacao .motivacao-opcao').forEach(function (btn) {
      btn.classList.remove('selecionada');
    });

    mostrarTela('tela-cardio-registro');
  }

  function selecionarMotivacao(valor) {
    motivacaoCardioSelecionada = valor;
    document.querySelectorAll('#seletor-motivacao .motivacao-opcao').forEach(function (btn) {
      btn.classList.toggle('selecionada', parseInt(btn.dataset.valor, 10) === valor);
    });
  }

  function salvarCardio() {
    var tipo = document.getElementById('input-cardio-tipo-registro').value.trim();
    var duracao = document.getElementById('input-cardio-duracao-registro').value;
    var bpm = document.getElementById('input-cardio-bpm').value;
    var obs = document.getElementById('input-cardio-obs-registro').value.trim();

    if (motivacaoCardioSelecionada === null) {
      alert("Selecione sua motivação de início (0 a 5) antes de salvar.");
      return;
    }

    var payload = {
      academia: estado.academiaAtual,
      tipo: tipo,
      duracao: duracao,
      bpmMedio: bpm,
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

  // CALENDÁRIO DE CONSTÂNCIA
  function inicializarCalendario() {
    var hoje = new Date();
    calendarioAnoAtual = hoje.getFullYear();
    calendarioMesAtual = hoje.getMonth() + 1;
    carregarCalendario();
  }

  function mudarMesCalendario(delta) {
    calendarioMesAtual += delta;
    if (calendarioMesAtual > 12) { calendarioMesAtual = 1; calendarioAnoAtual++; }
    if (calendarioMesAtual < 1) { calendarioMesAtual = 12; calendarioAnoAtual--; }
    carregarCalendario();
  }

  function carregarCalendario() {
    var nomesMeses = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
    var labelEl = document.getElementById('calendario-mes-label');
    if (labelEl) labelEl.innerText = nomesMeses[calendarioMesAtual - 1] + ' ' + calendarioAnoAtual;

    apiGet('calendarioMes', { ano: calendarioAnoAtual, mes: calendarioMesAtual })
      .then(function (dados) {
        renderizarCalendario(dados || {});
      })
      .catch(function (err) {
        console.warn('Erro ao carregar calendário de constância:', err);
        renderizarCalendario({});
      });
  }

  function renderizarCalendario(dados) {
    var container = document.getElementById('calendario-treinos');
    if (!container) return;

    var primeiroDiaSemana = new Date(calendarioAnoAtual, calendarioMesAtual - 1, 1).getDay();
    var totalDias = new Date(calendarioAnoAtual, calendarioMesAtual, 0).getDate();
    var hoje = new Date();
    var ehMesAtual = (hoje.getFullYear() === calendarioAnoAtual && (hoje.getMonth() + 1) === calendarioMesAtual);

    var html = '';
    ['D', 'S', 'T', 'Q', 'Q', 'S', 'S'].forEach(function (letra) {
      html += '<div class="calendario-dia-semana">' + letra + '</div>';
    });

    for (var i = 0; i < primeiroDiaSemana; i++) {
      html += '<div class="calendario-dia vazio"></div>';
    }

    for (var dia = 1; dia <= totalDias; dia++) {
      var mesStr = ('0' + calendarioMesAtual).slice(-2);
      var diaStr = ('0' + dia).slice(-2);
      var chave = calendarioAnoAtual + '-' + mesStr + '-' + diaStr;
      var info = dados[chave];

      var cores = [];
      var labels = [];
      if (info) {
        if (info.upper) { cores.push('var(--cal-upper)'); labels.push('U' + info.upper); }
        if (info.lower) { cores.push('var(--cal-lower)'); labels.push('L' + info.lower); }
        if (info.cardio) { cores.push('var(--cal-cardio)'); labels.push('Cardio'); }
      }

      var estiloFundo = '';
      if (cores.length === 1) {
        estiloFundo = 'background-color: ' + cores[0] + ';';
      } else if (cores.length > 1) {
        var fatia = 100 / cores.length;
        var stops = [];
        cores.forEach(function (cor, idx) {
          stops.push(cor + ' ' + (idx * fatia) + '%', cor + ' ' + ((idx + 1) * fatia) + '%');
        });
        estiloFundo = 'background: linear-gradient(135deg, ' + stops.join(', ') + ');';
      }

      var classes = 'calendario-dia' +
        (cores.length > 0 ? ' treinado' : '') +
        ((ehMesAtual && dia === hoje.getDate()) ? ' hoje' : '');

      html += '<div class="' + classes + '" style="' + estiloFundo + '">' +
                '<span class="dia-numero">' + dia + '</span>' +
                (labels.length > 0 ? '<span class="dia-label">' + labels.join('/') + '</span>' : '') +
              '</div>';
    }

    container.innerHTML = html;
  }

  // INÍCIO DO TREINO
  function selecionarRotina(nomeRotina) {
    mostrarLoading('Carregando exercícios de ' + nomeRotina + '...');
    estado.rotinaAtual = nomeRotina;

    apiGet('carregarExercicios', { rotina: nomeRotina })
      .then(function (resposta) {
        ocultarLoading();
        var exercicios = resposta ? resposta.exercicios : [];

        if (!exercicios || exercicios.length === 0) {
          alert("Nenhum exercício cadastrado na aba " + nomeRotina);
          return;
        }

        atualizarListaExercicios(exercicios);
        estado.exercicios = exercicios;
        estado.indexExercicioAtual = 0;
        estado.resumoExerciciosFinalizados = [];
        estado.limiteAvisoMin = (resposta && resposta.limiteAvisoMin) || 3;
        estado.limiteAlertaMin = (resposta && resposta.limiteAlertaMin) || 6;

        iniciarTimerTreino();
        document.getElementById('app-title').innerText = nomeRotina;
        salvarSessao();
        carregarExercicioAtual();
      })
      .catch(function (err) {
        ocultarLoading();
        alert("Erro ao carregar treino: " + err.message);
      });
  }

  // CARREGAR EXERCÍCIO DA FILA
  function carregarExercicioAtual() {
    var ex = estado.exercicios[estado.indexExercicioAtual];
    estado.seriesExercicioAtual = [];
    estado.indexSerieEmEdicao = null;

    pararTimerDescanso();
    document.getElementById('tempo-descanso-display').innerText = "--:--";
    document.getElementById('ex-nome').innerText = ex.exercicio;

    var grupos = ex.grupoPrincipal;
    if (ex.grupoSecundario) {
      grupos += " / " + ex.grupoSecundario;
    }
    document.getElementById('ex-grupos').innerText = grupos;
    document.getElementById('ex-series-alvo').innerText = ex.seriesAlvo;

    var exercicioDisplay = document.getElementById('exercicio-atual-display');
    if (exercicioDisplay) {
      exercicioDisplay.innerText = ex.exercicio;
      exercicioDisplay.classList.remove('hidden');
    }

    var selectEx = document.getElementById('select-exercicio');
    if (selectEx) selectEx.value = ex.exercicio;

    atualizarPainelInformacoesSuperiores();
    cancelarEdicaoSerie();
    atualizarTabelaSeries();
    iniciarTimerExercicio();

    mostrarLoading('Buscando histórico...');
    apiGet('historicoExercicio', { exercicio: ex.exercicio })
      .then(function (historico) {
        ocultarLoading();
        estado.historicoExercicioAtual = historico;
        renderizarHistorico(historico);
        mostrarTela('tela-treino');
      })
      .catch(function (err) {
        ocultarLoading();
        estado.historicoExercicioAtual = null;
        renderizarHistorico(null);
        mostrarTela('tela-treino');
      });
  }

  function atualizarPainelInformacoesSuperiores() {
    var ex = estado.exercicios[estado.indexExercicioAtual];
    var seriesFeitas = estado.seriesExercicioAtual.length;
    var restantes = ex.seriesAlvo - seriesFeitas;
    if (restantes < 0) restantes = 0;

    document.getElementById('series-restantes-display').innerText = restantes;

    var proximoExNode = document.getElementById('proximo-exercicio-display');
    if (estado.indexExercicioAtual + 1 < estado.exercicios.length) {
      var proxEx = estado.exercicios[estado.indexExercicioAtual + 1];
      proximoExNode.innerText = proxEx.exercicio;
    } else {
      proximoExNode.innerText = "Nenhum (Último exercício)";
    }
  }

  function renderizarHistorico(historico) {
    var container = document.getElementById('ex-historico-conteudo');
    container.innerHTML = '';

    if (!historico || !historico.series || historico.series.length === 0) {
      container.innerHTML = '<p style="font-size:0.85rem; color:var(--text-muted);">Nenhum registro anterior encontrado.</p>';
      return;
    }

    var serieAtualNum = estado.seriesExercicioAtual.length + 1;
    var html = '<div style="font-size:0.75rem; color:var(--primary); margin-bottom:6px; font-weight:600;">DATA: ' + historico.data + '</div>';

    historico.series.forEach(function (s) {
      var obsText = s.observacao ? ' <span style="color:var(--text-muted);">(' + s.observacao + ')</span>' : '';
      var classeAtual = (s.numeroSerie === serieAtualNum) ? ' history-item-atual' : '';
      html += '<div class="history-item' + classeAtual + '">' +
                '<span>S' + s.numeroSerie + ': ' + s.peso + 'kg x ' + s.repeticoes + ' reps</span>' +
                '<span>RPE ' + s.rpe + obsText + '</span>' +
              '</div>';
    });

    container.innerHTML = html;
  }

  // REGISTRO OU ATUALIZAÇÃO DE SÉRIE
  function salvarSerie() {
    var peso = parseFloat(document.getElementById('input-peso').value);
    var reps = parseInt(document.getElementById('input-reps').value, 10);
    var rpe = parseFloat(document.getElementById('input-rpe').value);
    var obsInput = document.getElementById('input-obs-serie');
    var observacaoOriginal = obsInput ? obsInput.value : '';

    if (isNaN(peso) || isNaN(reps) || peso <= 0 || reps <= 0) {
      alert("Por favor, informe valores válidos para peso e repetições.");
      return;
    }

    if (isNaN(rpe) || rpe < 1 || rpe > 10) {
      rpe = 0;
    }

    var observacaoFinal = estado.isAquecimento 
      ? "[Aquecimento] " + observacaoOriginal 
      : observacaoOriginal;

    var dadosSerie = {
      peso: peso,
      repeticoes: reps,
      rpe: rpe,
      observacao: observacaoFinal,
      est1RM: calcular1RM(peso, reps)
    };

    if (estado.indexSerieEmEdicao !== null) {
      estado.seriesExercicioAtual[estado.indexSerieEmEdicao] = dadosSerie;
    } else {
      estado.seriesExercicioAtual.push(dadosSerie);
      iniciarTimerDescanso();
    }

    if (estado.isAquecimento) {
      toggleAquecimento();
    }

    atualizarTabelaSeries();
    atualizarPainelInformacoesSuperiores();
    renderizarHistorico(estado.historicoExercicioAtual);
    cancelarEdicaoSerie();
    salvarSessao();
  }

  function editarSerie(index) {
    var s = estado.seriesExercicioAtual[index];
    if (!s) return;

    estado.indexSerieEmEdicao = index;
    document.getElementById('input-peso').value = s.peso;
    document.getElementById('input-reps').value = s.repeticoes;
    document.getElementById('input-rpe').value = s.rpe || '';
    
    var limpaObs = s.observacao ? s.observacao.replace("[Aquecimento] ", "") : "";
    document.getElementById('input-obs-serie').value = limpaObs;

    document.getElementById('form-serie-titulo').innerText = "Editar Série S" + (index + 1);
    document.getElementById('btn-salvar-serie').innerText = "Atualizar Série";
    document.getElementById('btn-cancelar-edicao').classList.remove('hidden');
  }

  function cancelarEdicaoSerie() {
    estado.indexSerieEmEdicao = null;
    document.getElementById('input-reps').value = '';
    document.getElementById('input-rpe').value = '';
    document.getElementById('input-obs-serie').value = '';

    document.getElementById('form-serie-titulo').innerText = "Registrar Série";
    document.getElementById('btn-salvar-serie').innerText = "Salvar Série";
    document.getElementById('btn-cancelar-edicao').classList.add('hidden');
  }

  function atualizarTabelaSeries() {
    var tbody = document.getElementById('tabela-series-correntes');
    if (!tbody) return;
    tbody.innerHTML = '';

    if (estado.seriesExercicioAtual.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" style="text-align:center; color:#71717a; padding: 12px 0; font-size:0.8rem;">Nenhuma série salva ainda.</td></tr>';
      return;
    }

    // Maior 1RM da sessão até agora, usado para destacar a série recordista
    var maior1RMSessao = 0;
    estado.seriesExercicioAtual.forEach(function (s) {
      var est = (typeof s.est1RM === 'number') ? s.est1RM : calcular1RM(s.peso, s.repeticoes);
      if (est > maior1RMSessao) maior1RMSessao = est;
    });

    estado.seriesExercicioAtual.forEach(function (s, index) {
      var est1RM = (typeof s.est1RM === 'number') ? s.est1RM : calcular1RM(s.peso, s.repeticoes);
      var ehRecorde = est1RM > 0 && est1RM === maior1RMSessao;
      var corRM = ehRecorde ? 'var(--primary)' : '#e4e4e7';
      var peso1RM = ehRecorde ? '700' : '400';

      var tr = document.createElement('tr');
      tr.style.borderTop = '1px solid #27272a';
      tr.innerHTML = '<td style="padding: 10px 0;">S' + (index + 1) + '</td>' +
                     '<td style="padding: 10px 0;">' + s.peso + ' kg</td>' +
                     '<td style="padding: 10px 0;">' + s.repeticoes + '</td>' +
                     '<td style="padding: 10px 0;">' + (s.rpe || '-') + '</td>' +
                     '<td style="padding: 10px 0; color:' + corRM + '; font-weight:' + peso1RM + ';">' + est1RM.toFixed(1) + ' kg' + (ehRecorde ? ' 🏆' : '') + '</td>' +
                     '<td style="padding: 10px 0; font-size:0.75rem; color:#a1a1aa;">' + (s.observacao || '-') + '</td>' +
                     '<td style="padding: 10px 0; text-align:right;"><button type="button" style="background:transparent; border:none; color:#7c3aed; font-size:0.8rem; cursor:pointer;" onclick="app.editarSerie(' + index + ')">Editar</button></td>';
      tbody.appendChild(tr);
    });
  }

  function finalizarExercicio() {
    if (estado.seriesExercicioAtual.length === 0) {
      alert("Registre pelo menos uma série antes de finalizar o exercício.");
      return;
    }

    pararTimerExercicio();
    pararTimerDescanso();

    var exAtual = estado.exercicios[estado.indexExercicioAtual];
    var tempoFormatado = formatarTempo(estado.tempoExercicioSegundos);
    var seriesDoExercicio = estado.seriesExercicioAtual;

    var payload = {
      treino: estado.rotinaAtual,
      exercicio: exAtual.exercicio,
      tempoExercicio: tempoFormatado,
      series: seriesDoExercicio
    };

    function avancarParaProximo(resumo) {
      estado.resumoExerciciosFinalizados.push({
        exercicio: exAtual.exercicio,
        seriesCount: seriesDoExercicio.length,
        volume: resumo.volume,
        rpeMedio: resumo.rpeMedio,
        maior1RM: resumo.maior1RM,
        seriesData: seriesDoExercicio
      });

      estado.indexExercicioAtual++;
      salvarSessao();

      if (estado.indexExercicioAtual < estado.exercicios.length) {
        carregarExercicioAtual();
      } else {
        exibirRelatorioFinal();
      }
    }

    var resumoLocal = {
      volume: calcularVolumeExercicioCliente(seriesDoExercicio),
      rpeMedio: calcularRpeMedioCliente(seriesDoExercicio),
      maior1RM: calcularMaior1RMCliente(seriesDoExercicio)
    };

    // Sem internet: não trava o treino — calcula localmente, guarda na fila e segue
    if (!navigator.onLine) {
      FilaOffline.enfileirar('exercicio', payload);
      avancarParaProximo(resumoLocal);
      return;
    }

    mostrarLoading('Salvando exercício...');
    apiPost('salvarExercicioCompleto', payload)
      .then(function (resumoServidor) {
        ocultarLoading();
        avancarParaProximo(resumoServidor);
      })
      .catch(function (err) {
        ocultarLoading();
        console.warn('Falha ao salvar exercício online, será sincronizado depois:', err);
        FilaOffline.enfileirar('exercicio', payload);
        avancarParaProximo(resumoLocal);
      });
  }

  // CRONÔMETROS BASEADOS EM TEMPO ABSOLUTO (COMPATÍVEIS COM TELA APAGADA / SEGUNDO PLANO)
  function iniciarTimerTreino() {
    pararTimerTreino();
    tempoInicioTreino = Date.now();
    estado.tempoTreinoSegundos = 0;
    
    document.getElementById('timer-display').classList.remove('hidden');
    var horarioInicioEl = document.getElementById('horario-inicio-display');
    if (horarioInicioEl) {
      horarioInicioEl.innerText = 'Início: ' + formatarHorario(tempoInicioTreino);
      horarioInicioEl.classList.remove('hidden');
    }
    var tempoDescansoHeaderEl = document.getElementById('tempo-descanso-header');
    if (tempoDescansoHeaderEl) tempoDescansoHeaderEl.classList.remove('hidden');
    var btnAntecipado = document.getElementById('btn-encerrar-antecipado');
    if (btnAntecipado) btnAntecipado.classList.remove('hidden');

    estado.timerTreinoId = setInterval(function () {
      var msPassados = Date.now() - tempoInicioTreino;
      estado.tempoTreinoSegundos = Math.floor(msPassados / 1000);
      document.getElementById('timer-display').innerText = formatarTempo(estado.tempoTreinoSegundos);
    }, 1000);
  }

  function formatarHorario(timestampMs) {
    var d = new Date(timestampMs);
    var h = ("0" + d.getHours()).slice(-2);
    var m = ("0" + d.getMinutes()).slice(-2);
    return h + ":" + m;
  }

  function pararTimerTreino() {
    if (estado.timerTreinoId) {
      clearInterval(estado.timerTreinoId);
      estado.timerTreinoId = null;
    }
    tempoInicioTreino = null;
  }

  function iniciarTimerExercicio() {
    pararTimerExercicio();
    tempoInicioExercicio = Date.now();
    estado.tempoExercicioSegundos = 0;
    
    estado.timerExercicioId = setInterval(function () {
      var msPassados = Date.now() - tempoInicioExercicio;
      estado.tempoExercicioSegundos = Math.floor(msPassados / 1000);
    }, 1000);
  }

  function pararTimerExercicio() {
    if (estado.timerExercicioId) {
      clearInterval(estado.timerExercicioId);
      estado.timerExercicioId = null;
    }
    tempoInicioExercicio = null;
  }

  // CONTROLE DO TIMER DE DESCANSO
  function iniciarTimerDescanso() {
    pararTimerDescanso();
    tempoInicioDescanso = Date.now();
    estado.tempoDescansoSegundos = 0;
    document.getElementById('tempo-descanso-display').innerText = "00:00";
    document.body.classList.remove('aviso-descanso', 'alerta-descanso');

    // Inicia o "vídeo" do modo flutuante (PiP) — o play() aqui acontece dentro
    // do mesmo gesto do usuário que salvou a série, o que é exigido pelo navegador.
    iniciarStreamPip();
    desenharFramePip('00:00');

    estado.timerDescansoId = setInterval(function () {
      var msPassados = Date.now() - tempoInicioDescanso;
      estado.tempoDescansoSegundos = Math.floor(msPassados / 1000);
      
      var mins = Math.floor(estado.tempoDescansoSegundos / 60);
      var segs = estado.tempoDescansoSegundos % 60;
      var mStr = mins < 10 ? "0" + mins : mins;
      var sStr = segs < 10 ? "0" + segs : segs;
      var textoTempo = mStr + ":" + sStr;
      document.getElementById('tempo-descanso-display').innerText = textoTempo;
      desenharFramePip(textoTempo);

      // Muda a cor do app conforme o tempo desde a última série (X/Y configurados na planilha)
      var minutosDecorridos = estado.tempoDescansoSegundos / 60;
      if (minutosDecorridos >= estado.limiteAlertaMin) {
        document.body.classList.add('alerta-descanso');
        document.body.classList.remove('aviso-descanso');
      } else if (minutosDecorridos >= estado.limiteAvisoMin) {
        document.body.classList.add('aviso-descanso');
        document.body.classList.remove('alerta-descanso');
      } else {
        document.body.classList.remove('aviso-descanso', 'alerta-descanso');
      }
    }, 1000);
  }

  function pararTimerDescanso() {
    if (estado.timerDescansoId) {
      clearInterval(estado.timerDescansoId);
      estado.timerDescansoId = null;
    }
    tempoInicioDescanso = null;
    document.body.classList.remove('aviso-descanso', 'alerta-descanso');
    pararStreamPip();
  }

  // ==========================================================================
  // MODO FLUTUANTE (Picture-in-Picture) DO CRONÔMETRO DE DESCANSO
  // Técnica: desenha o tempo num <canvas> escondido, "filma" esse canvas
  // (captureStream) como se fosse um vídeo, e pede pro navegador abrir esse
  // vídeo numa janelinha flutuante quando você sai do app. É best-effort —
  // depende de suporte a Picture-in-Picture no navegador/Android usado.
  // ==========================================================================
  var pipCanvas = null;
  var pipCtx = null;
  var pipVideo = null;
  var pipStreamAtivo = false;

  function inicializarPip() {
    pipCanvas = document.getElementById('pip-canvas');
    pipVideo = document.getElementById('pip-video');
    if (pipCanvas) pipCtx = pipCanvas.getContext('2d');
  }

  function desenharFramePip(texto) {
    if (!pipCtx || !pipCanvas) return;
    pipCtx.fillStyle = '#121214';
    pipCtx.fillRect(0, 0, pipCanvas.width, pipCanvas.height);
    pipCtx.fillStyle = '#fba94c';
    pipCtx.font = 'bold 56px sans-serif';
    pipCtx.textAlign = 'center';
    pipCtx.textBaseline = 'middle';
    pipCtx.fillText(texto, pipCanvas.width / 2, pipCanvas.height / 2 - 8);
    pipCtx.fillStyle = '#a8a8b3';
    pipCtx.font = '18px sans-serif';
    pipCtx.fillText('Última série', pipCanvas.width / 2, pipCanvas.height / 2 + 38);
  }

  function iniciarStreamPip() {
    if (pipStreamAtivo || !pipCanvas || !pipVideo) return;
    if (typeof pipCanvas.captureStream !== 'function') return; // navegador não suporta

    try {
      var stream = pipCanvas.captureStream(2); // 2 fps é mais que suficiente pra um relógio
      pipVideo.srcObject = stream;
      pipVideo.play().catch(function (err) {
        console.warn('Não foi possível iniciar o vídeo do modo flutuante:', err);
      });
      pipStreamAtivo = true;
    } catch (err) {
      console.warn('Modo flutuante indisponível:', err);
    }
  }

  function pararStreamPip() {
    pipStreamAtivo = false;
    if (document.pictureInPictureElement && pipVideo && document.pictureInPictureElement === pipVideo) {
      document.exitPictureInPicture().catch(function () {});
    }
  }

  // Ao sair do app (minimizar, trocar de app) enquanto o cronômetro de
  // descanso está rodando, tenta abrir automaticamente a janelinha flutuante.
  document.addEventListener('visibilitychange', function () {
    if (
      document.visibilityState === 'hidden' &&
      pipStreamAtivo &&
      pipVideo &&
      document.pictureInPictureEnabled &&
      document.pictureInPictureElement !== pipVideo
    ) {
      pipVideo.requestPictureInPicture().catch(function (err) {
        console.warn('Não foi possível abrir o modo flutuante automaticamente:', err);
      });
    }
  });

  function formatarTempo(totalSegundos) {
    var hrs = Math.floor(totalSegundos / 3600);
    var mins = Math.floor((totalSegundos % 3600) / 60);
    var segs = totalSegundos % 60;

    var hStr = hrs < 10 ? "0" + hrs : hrs;
    var mStr = mins < 10 ? "0" + mins : mins;
    var sStr = segs < 10 ? "0" + segs : segs;

    return hStr + ":" + mStr + ":" + sStr;
  }

  // TELA DE RELATÓRIO FINAL
  function exibirRelatorioFinal() {
    pararTimerTreino();
    pararTimerDescanso();
    document.body.classList.remove('aviso-descanso', 'alerta-descanso');
    
    var btnAntecipado = document.getElementById('btn-encerrar-antecipado');
    if (btnAntecipado) btnAntecipado.classList.add('hidden');
    
    var exercicioDisplay = document.getElementById('exercicio-atual-display');
    if (exercicioDisplay) exercicioDisplay.classList.add('hidden');

    var horarioInicioEl = document.getElementById('horario-inicio-display');
    if (horarioInicioEl) horarioInicioEl.classList.add('hidden');

    var tempoTotalStr = formatarTempo(estado.tempoTreinoSegundos);
    var cargaTotal = 0;
    var somaRpeGeral = 0;
    var totalSeriesGeral = 0;
    var maior1RMGeral = 0;

    estado.resumoExerciciosFinalizados.forEach(function (ex) {
      cargaTotal += ex.volume;
      totalSeriesGeral += ex.seriesCount;

      if (ex.maior1RM > maior1RMGeral) {
        maior1RMGeral = ex.maior1RM;
      }

      ex.seriesData.forEach(function (s) {
        if (s.rpe > 0) {
          somaRpeGeral += s.rpe;
        }
      });
    });

    var rpeMedioGeral = totalSeriesGeral > 0 ? (somaRpeGeral / totalSeriesGeral) : 0;
    var indiceFadiga = cargaTotal * rpeMedioGeral;

    document.getElementById('relatorio-tempo').innerText = tempoTotalStr;
    document.getElementById('relatorio-carga').innerText = cargaTotal.toFixed(1) + " kg";
    document.getElementById('relatorio-volume').innerText = cargaTotal.toFixed(1) + " kg";
    document.getElementById('relatorio-rpe').innerText = rpeMedioGeral.toFixed(1);
    document.getElementById('relatorio-fadiga').innerText = indiceFadiga.toFixed(1);
    document.getElementById('relatorio-1rm').innerText = maior1RMGeral.toFixed(1) + " kg";
    document.getElementById('relatorio-exercicios').innerText = estado.resumoExerciciosFinalizados.length;
    document.getElementById('relatorio-series').innerText = totalSeriesGeral;

    renderizarSeriesDetalhadas();

    estado.dadosRelatorio = {
      nomeTreino: estado.rotinaAtual,
      academia: estado.academiaAtual,
      tempoTotal: tempoTotalStr,
      cargaTotal: cargaTotal,
      volume: cargaTotal,
      rpeMedio: rpeMedioGeral,
      indiceFadiga: indiceFadiga,
      maior1RM: maior1RMGeral,
      numeroExercicios: estado.resumoExerciciosFinalizados.length,
      numeroSeries: totalSeriesGeral
    };

    Sugestoes.preencherDatalist('lista-academias', WORKOUT_ACADEMIAS_KEY);

    mostrarTela('tela-relatorio');
  }

  // Monta a lista completa de séries feitas no treino, agrupadas por exercício
  function renderizarSeriesDetalhadas() {
    var container = document.getElementById('relatorio-series-detalhe');
    if (!container) return;

    if (estado.resumoExerciciosFinalizados.length === 0) {
      container.innerHTML = '<p style="font-size:0.85rem; color:var(--text-muted);">Nenhuma série registrada.</p>';
      return;
    }

    var html = '';
    estado.resumoExerciciosFinalizados.forEach(function (ex) {
      html += '<div class="relatorio-exercicio-bloco">';
      html += '<div class="relatorio-exercicio-nome">' + ex.exercicio + '</div>';

      ex.seriesData.forEach(function (s, i) {
        var est1RM = (typeof s.est1RM === 'number') ? s.est1RM : calcular1RM(s.peso, s.repeticoes);
        var obsText = s.observacao ? ' — ' + s.observacao : '';
        html += '<div class="relatorio-serie-linha">' +
                  '<span>S' + (i + 1) + ': ' + s.peso + 'kg x ' + s.repeticoes + ' (RPE ' + (s.rpe || '-') + ')' + obsText + '</span>' +
                  '<span>1RM ' + est1RM.toFixed(1) + 'kg</span>' +
                '</div>';
      });

      html += '</div>';
    });

    container.innerHTML = html;
  }

  function finalizarTreino() {
    var obsGeral = document.getElementById('input-obs-geral').value;
    estado.dadosRelatorio.observacaoGeral = obsGeral;

    var relatorio = estado.dadosRelatorio;

    function concluirNaTela() {
      WorkoutCache.limpar();
      SessaoCache.limpar();
      liberarTelaAtiva();

      document.getElementById('timer-display').classList.add('hidden');
      document.getElementById('app-title').innerText = "Workout Logger";
      var exercicioDisplay = document.getElementById('exercicio-atual-display');
      if (exercicioDisplay) exercicioDisplay.classList.add('hidden');
      var tempoDescansoHeaderElConcluir = document.getElementById('tempo-descanso-header');
      if (tempoDescansoHeaderElConcluir) tempoDescansoHeaderElConcluir.classList.add('hidden');
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

  // BOTÃO DISCRETO DE AQUECIMENTO REPOSICIONADO
  function toggleAquecimento() {
    estado.isAquecimento = !estado.isAquecimento;
    var btn = document.getElementById('btn-aquecimento');
    if (!btn) return;
    
    if (estado.isAquecimento) {
      btn.style.borderColor = '#f59e0b';
      btn.style.color = '#f59e0b';
      btn.style.background = 'rgba(245, 158, 11, 0.1)';
    } else {
      btn.style.borderColor = '#3f3f46';
      btn.style.color = '#a1a1aa';
      btn.style.background = 'transparent';
    }
  }

  // LISTENERS DE INICIALIZAÇÃO E PERSISTÊNCIA
  window.onload = function () {
    inicializarPip();
    app.init();
    WorkoutCache.restaurar();
  };

  document.addEventListener('input', function(e) {
    WorkoutCache.salvar();
  });

  document.addEventListener('change', function(e) {
    WorkoutCache.salvar();
  });

  return {
    init: init,
    salvarSerie: salvarSerie,
    editarSerie: editarSerie,
    cancelarEdicaoSerie: cancelarEdicaoSerie,
    finalizarExercicio: finalizarExercicio,
    finalizarTreino: finalizarTreino,
    toggleAquecimento: toggleAquecimento,
    confirmarEncerrarTreino: confirmarEncerrarTreino,
    selecionarExercicio: selecionarExercicio,
    exercicioAnterior: exercicioAnterior,
    escolherRotina: escolherRotina,
    confirmarInicioTreino: confirmarInicioTreino,
    atualizarPreview1RM: atualizarPreview1RM,
    alternarTelaAtiva: alternarTelaAtiva,
    abrirCronometroDescanso: abrirCronometroDescanso,
    fecharCronometroDescanso: fecharCronometroDescanso,
    selecionarMotivacao: selecionarMotivacao,
    salvarCardio: salvarCardio,
    mudarMesCalendario: mudarMesCalendario,
    mostrarTela: mostrarTela,
    isTreinoAtivo: isTreinoAtivo
  };
})();
