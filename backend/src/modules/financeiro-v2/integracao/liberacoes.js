// LIBERAÇÃO DO FINANCEIRO V2 POR EMPRESA E UNIDADE (Execução 09B). Espelho, em memória, da migração 0021.
//   - desligado por padrão; unidade só vale com a empresa ligada;
//   - alterar exige ator identificado, justificativa (≥ 20) e prova VERIFICADA de segundo fator recente do ator
//     (provaDeAutenticacao.js) — quem decide é a autoridade/gateway, nunca o navegador;
//   - histórico imutável; desligar não apaga dados do v2 (só tira a disponibilidade da interface e das rotas);
//   - liberar NÃO concede permissão financeira a ninguém.
import { CODIGO, falhar } from "../dominio/erros.js";
import { ehUuid } from "../dominio/validacao.js";

export const JUSTIFICATIVA_MINIMA_LIBERACAO = 20;
const minusc = (x) => String(x).toLowerCase();
const chave = (org, uni) => `${minusc(org)}|${uni ? minusc(uni) : "*"}`;

/** Valida um ato de liberação (puro). Lança com motivo estável. */
export function validarAtoDeLiberacao(ato) {
  if (!ato || typeof ato !== "object") falhar(CODIGO.ENTRADA_INVALIDA, "Ato de liberação ausente.", { motivo: "ATO_AUSENTE" });
  if (!ehUuid(ato.organizacaoId)) falhar(CODIGO.ENTRADA_INVALIDA, "Empresa inválida.", { motivo: "EMPRESA_INVALIDA" });
  if (ato.unidadeId !== null && ato.unidadeId !== undefined && !ehUuid(ato.unidadeId)) falhar(CODIGO.ENTRADA_INVALIDA, "Unidade inválida.", { motivo: "UNIDADE_INVALIDA" });
  if (typeof ato.ativa !== "boolean") falhar(CODIGO.ENTRADA_INVALIDA, "Informe se liga ou desliga.", { motivo: "ESTADO_INVALIDO" });
  if (!ehUuid(ato.atorContaId)) falhar(CODIGO.PERMISSAO_INSUFICIENTE, "Ator não identificado.", { motivo: "ATOR_AUSENTE" });
  if (typeof ato.justificativa !== "string" || ato.justificativa.trim().length < JUSTIFICATIVA_MINIMA_LIBERACAO) {
    falhar(CODIGO.ENTRADA_INVALIDA, `Justificativa obrigatória (mínimo ${JUSTIFICATIVA_MINIMA_LIBERACAO} caracteres).`, { motivo: "JUSTIFICATIVA_INSUFICIENTE" });
  }
  const p = ato.provaDeSegundoFator;
  if (!p || p.ok !== true || minusc(p.contaId ?? "") !== minusc(ato.atorContaId) || !Number.isFinite(p.segundoFatorEm)) {
    falhar(CODIGO.PERMISSAO_INSUFICIENTE, "Liberar ou desligar exige segundo fator recente comprovado do próprio ator.", { motivo: "SEM_PROVA_DE_SEGUNDO_FATOR" });
  }
  return { organizacaoId: minusc(ato.organizacaoId), unidadeId: ato.unidadeId ? minusc(ato.unidadeId) : null, ativa: ato.ativa, ator: minusc(ato.atorContaId), justificativa: ato.justificativa.trim(), segundoFatorEm: p.segundoFatorEm };
}

/** Registro em memória (testes e homologação local). Mesma semântica da 0021. */
export function criarLiberacoesMemoria({ relogio = () => new Date() } = {}) {
  const estado = new Map();
  const historico = [];
  return Object.freeze({
    async consultar({ organizacaoId, unidadeId }) {
      const empresa = estado.get(chave(organizacaoId, null))?.ativa === true;
      return { empresa, unidade: empresa && estado.get(chave(organizacaoId, unidadeId))?.ativa === true };
    },
    async alterar(ato) {
      const a = validarAtoDeLiberacao(ato);
      const k = chave(a.organizacaoId, a.unidadeId);
      const antes = estado.get(k)?.ativa ?? null;
      const versao = (estado.get(k)?.versao ?? 0) + 1;
      estado.set(k, { ativa: a.ativa, versao });
      historico.push(Object.freeze({ organizacaoId: a.organizacaoId, unidadeId: a.unidadeId, ativaAntes: antes, ativaDepois: a.ativa, ator: a.ator, justificativa: a.justificativa, segundoFatorEm: a.segundoFatorEm, em: relogio().toISOString() }));
      return { versao };
    },
    historico: () => historico.map((h) => ({ ...h })),
  });
}
