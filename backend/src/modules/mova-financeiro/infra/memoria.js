// Armazenamentos em MEMÓRIA do MOVA (simulação e testes): propostas, histórico do agente, documentos vistos, mensagens
// relacionadas e caixa de saída de respostas. Tudo é separado por organização + unidade; nenhuma listagem sem unidade.
//
// A versão persistente é PENDENTE (tabelas próprias do MOVA, com RLS por unidade — exige migração e autorização). Os
// métodos abaixo são o contrato que ela deve cumprir.
import { randomUUID } from "node:crypto";

export const ESTADO_PROPOSTA_MOVA = Object.freeze({ AGUARDANDO_REVISAO: "AGUARDANDO_REVISAO", REJEITADA: "REJEITADA", APLICADA: "APLICADA" });
const chave = (e) => `${e.organizacaoId}|${e.unidadeId}`;

export function criarArmazenamentoMemoria({ gerarId = randomUUID, relogio = () => new Date() } = {}) {
  const propostas = new Map();            // id → proposta
  const propostaPorChave = new Map();     // chave de idempotência → id
  const historico = [];
  const documentos = new Map();           // sha256 → {organizacaoId, unidadeId, propostaId, eventoId}
  const mensagens = new Map();            // mensagemId → {grupoId, unidadeId|null, pendente: carga|null}
  const saida = [];

  return Object.freeze({
    propostas: Object.freeze({
      /** Idempotente por `chaveIdempotencia` (evento + tipo). */
      criar(escopo, dados) {
        const existente = propostaPorChave.get(dados.chaveIdempotencia);
        if (existente) return { proposta: propostas.get(existente), repetida: true };
        const p = Object.freeze({ id: gerarId(), organizacaoId: escopo.organizacaoId, unidadeId: escopo.unidadeId, estado: ESTADO_PROPOSTA_MOVA.AGUARDANDO_REVISAO, simulada: true, criadaEm: relogio().toISOString(), ...dados });
        propostas.set(p.id, p);
        propostaPorChave.set(dados.chaveIdempotencia, p.id);
        return { proposta: p, repetida: false };
      },
      listar(escopo) { return [...propostas.values()].filter((p) => chave(p) === chave(escopo)); },
      obter(escopo, id) { const p = propostas.get(id); return p && chave(p) === chave(escopo) ? p : null; },
      quantidade: () => propostas.size,
    }),
    historico: Object.freeze({
      registrar(entrada) { const h = Object.freeze({ id: gerarId(), em: relogio().toISOString(), ...entrada }); historico.push(h); return h; },
      /** Por unidade; `unidadeId: null` lista só os eventos sem unidade (bloqueios antes da identificação). */
      listar({ organizacaoId, unidadeId }) { return historico.filter((h) => h.organizacaoId === organizacaoId && h.unidadeId === unidadeId); },
      todos: () => [...historico],
    }),
    documentos: Object.freeze({
      visto(sha256) { return documentos.get(sha256) ?? null; },
      marcar(sha256, dados) { if (!documentos.has(sha256)) documentos.set(sha256, Object.freeze({ ...dados })); },
    }),
    mensagens: Object.freeze({
      lembrar(mensagemId, dados) { mensagens.set(mensagemId, Object.freeze({ ...dados })); },
      obter(mensagemId) { return mensagens.get(mensagemId) ?? null; },
    }),
    saida: Object.freeze({
      /** Caixa de saída SIMULADA: nada é enviado ao WhatsApp nesta execução. */
      enfileirar(resposta) { saida.push(Object.freeze({ ...resposta })); },
      listar: () => [...saida],
    }),
  });
}
