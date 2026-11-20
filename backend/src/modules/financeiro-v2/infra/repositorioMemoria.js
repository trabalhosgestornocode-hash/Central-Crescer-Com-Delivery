// Adaptador EM MEMÓRIA da porta de persistência. Serve para testar as regras e como referência de comportamento
// para o adaptador PostgreSQL. Não é persistência de produção.
//
// Atomicidade: cada transação trabalha sobre uma cópia do estado; a cópia só substitui o estado se fn terminar sem erro.
// Transações são serializadas (uma por vez), então não há leitura suja nem escrita perdida — e as travas são triviais.
import { CODIGO, falhar } from "../dominio/erros.js";
import { congelar } from "../dominio/validacao.js";
import { ORDEM_DE_GRAVACAO, normalizarConsulta, normalizarFiltro } from "../contratos/repositorio.js";

const mesmoEscopo = (r, e) => r.organizacaoId === e.organizacaoId && r.unidadeId === e.unidadeId;
const copia = (v) => congelar(structuredClone(v));
/** Cópia com a ordem de gravação (posição na tabela, que preserva a ordem de inserção). */
const copiaOrdenada = (v, i) => { const c = structuredClone(v); Object.defineProperty(c, ORDEM_DE_GRAVACAO, { value: i }); return congelar(c); };
const atende = (r, filtro) => Object.entries(filtro.onde).every(([campo, valor]) => r[campo] === valor) && filtro.predicado(r);
const vazio = (v) => v === null || v === undefined;
/** Mesma semântica do adaptador PostgreSQL: `onde` nulo = "is null"; faixas inclusivas ignoram nulos; `em` = lista. */
const atendeConsulta = (r, q) => Object.entries(q.onde).every(([k, v]) => (vazio(v) ? vazio(r[k]) : r[k] === v))
  && Object.entries(q.desde).every(([k, v]) => !vazio(r[k]) && r[k] >= v)
  && Object.entries(q.ate).every(([k, v]) => !vazio(r[k]) && r[k] <= v)
  && Object.entries(q.em).every(([k, lista]) => { const x = valorDoCampo(r, k); return lista.some((v) => (typeof x === "string" ? x === String(v) : x === v)); });
/** 08C: `em` aceita um subcampo de objeto (ex.: "origem.id"), como o adaptador PostgreSQL faz com colunas JSON. */
const valorDoCampo = (r, k) => (k.includes(".") ? k.split(".").reduce((o, p) => (o === null || o === undefined ? o : o[p]), r) : r[k]);
const comparar = (a, b) => (a === b ? 0 : vazio(a) ? 1 : vazio(b) ? -1 : a < b ? -1 : 1);

function criarTx(estado, { somenteLeitura = false } = {}) {
  const tabela = (tipo) => (estado.registros[tipo] ??= {});
  const exigirEscrita = () => {
    if (somenteLeitura) falhar(CODIGO.REPOSITORIO_INVALIDO, "Escrita fora de transação.");
  };
  const exigirEscopoDoRegistro = (r) => {
    if (!r?.id || !r.organizacaoId || !r.unidadeId) falhar(CODIGO.REPOSITORIO_INVALIDO, "Registro sem id/organização/unidade.");
  };
  return {
    inserir(tipo, registro) {
      exigirEscrita();
      exigirEscopoDoRegistro(registro);
      const t = tabela(tipo);
      if (t[registro.id]) falhar(CODIGO.REPOSITORIO_INVALIDO, "Identificador já existente.", { tipo });
      if (registro.chaveIdempotencia && Object.values(t).some((r) => mesmoEscopo(r, registro) && r.chaveIdempotencia === registro.chaveIdempotencia)) {
        falhar(CODIGO.CONFLITO_IDEMPOTENCIA, "Já existe um registro com a mesma origem externa.", { tipo });
      }
      t[registro.id] = structuredClone(registro);
    },
    atualizar(tipo, registro, versaoEsperada) {
      exigirEscrita();
      exigirEscopoDoRegistro(registro);
      const atual = tabela(tipo)[registro.id];
      if (!atual || !mesmoEscopo(atual, registro)) falhar(CODIGO.NAO_ENCONTRADO, "Registro não encontrado.", { tipo });
      if (atual.versao !== versaoEsperada || registro.versao !== versaoEsperada + 1) {
        falhar(CODIGO.CONFLITO_VERSAO, "O registro foi alterado por outra operação. Recarregue e tente de novo.", { tipo });
      }
      tabela(tipo)[registro.id] = structuredClone(registro);
    },
    obter(escopo, tipo, id) {
      const r = tabela(tipo)[id];
      return r && mesmoEscopo(r, escopo) ? copia(r) : null;
    },
    listar(escopo, tipo, filtro) {
      const f = normalizarFiltro(filtro);
      return Object.values(tabela(tipo)).map((r, i) => [r, i]).filter(([r]) => mesmoEscopo(r, escopo) && atende(r, f)).map(([r, i]) => copiaOrdenada(r, i));
    },
    buscarPorChave(escopo, tipo, chave) {
      const r = Object.values(tabela(tipo)).find((x) => mesmoEscopo(x, escopo) && x.chaveIdempotencia === chave);
      return r ? copia(r) : null;
    },
    /** Várias chaves de uma vez: Map chave → registro (só as encontradas). */
    buscarPorChaves(escopo, tipo, chaves) {
      const procuradas = new Set(chaves);
      const achados = new Map();
      for (const r of Object.values(tabela(tipo))) {
        if (mesmoEscopo(r, escopo) && procuradas.has(r.chaveIdempotencia) && !achados.has(r.chaveIdempotencia)) achados.set(r.chaveIdempotencia, copia(r));
      }
      return achados;
    },
    inserirVarios(tipo, registros) {
      for (const r of registros) this.inserir(tipo, r);
    },
    anexarHistoricos(eventos) {
      for (const e of eventos) this.anexarHistorico(e);
    },
    travar() {
      // Transações em memória já são serializadas: a trava é sempre concedida.
    },
    anexarHistorico(evento) {
      exigirEscrita();
      exigirEscopoDoRegistro(evento);
      estado.historico.push(structuredClone(evento));
    },
    listarHistorico(escopo, filtro) {
      const f = normalizarFiltro(filtro);
      return estado.historico.filter((h) => mesmoEscopo(h, escopo) && atende(h, f)).map(copia);
    },
    paginar(escopo, tipo, consulta) {
      const q = normalizarConsulta(consulta);
      const filtrados = Object.values(tabela(tipo)).map((r, i) => [r, i]).filter(([r]) => mesmoEscopo(r, escopo) && atendeConsulta(r, q));
      filtrados.sort(([a, ia], [b, ib]) => {
        for (const o of q.ordem) {
          const c = comparar(a[o.campo], b[o.campo]);
          if (c) return o.desc && !vazio(a[o.campo]) && !vazio(b[o.campo]) ? -c : c;
        }
        return ia - ib;
      });
      return { itens: filtrados.slice(q.deslocamento, q.deslocamento + q.limite).map(([r, i]) => copiaOrdenada(r, i)), total: q.contar ? filtrados.length : null };
    },
    agregar(escopo, tipo, consulta) {
      const q = normalizarConsulta(consulta, { paginada: false });
      const grupos = new Map();
      for (const r of Object.values(tabela(tipo)).filter((x) => mesmoEscopo(x, escopo) && atendeConsulta(x, q))) {
        const k = q.agruparPor ? (vazio(r[q.agruparPor]) ? null : String(r[q.agruparPor])) : null;
        const g = grupos.get(k) ?? { grupo: k, quantidade: 0, somaCentavos: q.somar ? 0 : null };
        g.quantidade += 1;
        if (q.somar) g.somaCentavos += r[q.somar] ?? 0;
        grupos.set(k, g);
      }
      return [...grupos.values()].sort((a, b) => comparar(a.grupo ?? "", b.grupo ?? ""));
    },
  };
}

export function criarRepositorioMemoria() {
  let estado = { registros: {}, historico: [] };
  let fila = Promise.resolve();

  function transacao(fn) {
    const executar = async () => {
      const rascunho = structuredClone(estado);
      const resultado = await fn(criarTx(rascunho));
      estado = rascunho; // confirmação: só acontece se fn não lançou
      return resultado;
    };
    const p = fila.then(executar, executar);
    fila = p.catch(() => {});
    return p;
  }

  async function leitura(fn) {
    await fila;
    return fn(criarTx(structuredClone(estado), { somenteLeitura: true }));
  }

  return Object.freeze({ transacao, leitura });
}
