// Adaptador EM MEMÓRIA da porta de persistência. Serve para testar as regras e como referência de comportamento
// para o adaptador PostgreSQL. Não é persistência de produção.
//
// Atomicidade: cada transação trabalha sobre uma cópia do estado; a cópia só substitui o estado se fn terminar sem erro.
// Transações são serializadas (uma por vez), então não há leitura suja nem escrita perdida — e as travas são triviais.
import { CODIGO, falhar } from "../dominio/erros.js";
import { congelar } from "../dominio/validacao.js";
import { normalizarFiltro } from "../contratos/repositorio.js";

const mesmoEscopo = (r, e) => r.organizacaoId === e.organizacaoId && r.unidadeId === e.unidadeId;
const copia = (v) => congelar(structuredClone(v));
const atende = (r, filtro) => Object.entries(filtro.onde).every(([campo, valor]) => r[campo] === valor) && filtro.predicado(r);

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
      return Object.values(tabela(tipo)).filter((r) => mesmoEscopo(r, escopo) && atende(r, f)).map(copia);
    },
    buscarPorChave(escopo, tipo, chave) {
      const r = Object.values(tabela(tipo)).find((x) => mesmoEscopo(x, escopo) && x.chaveIdempotencia === chave);
      return r ? copia(r) : null;
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
