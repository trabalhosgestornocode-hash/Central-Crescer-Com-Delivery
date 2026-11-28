// Diagnóstico SOMENTE LEITURA por organização, usando as MESMAS funções de leitura da API (nenhuma escrita:
// saude/pendencias/previas só fazem SELECT; nenhuma função de aplicar é chamada).
// Uso: node --env-file=<.env> scripts/diagnosticar-fichas.mjs <organizacaoId> [...] > saida.json
import * as cmv from "../src/modules/produtos/produtosCmv.service.js";
import { listarFichasCatalogo } from "../src/modules/produtos/produtos.service.js";

const saida = {};
for (const organizacaoId of process.argv.slice(2)) {
  const [saude, pend, rend, homol, antigo] = await Promise.all([
    cmv.saude({ organizacaoId }), cmv.pendencias({ organizacaoId }), cmv.previaRendimentos({ organizacaoId }),
    cmv.previaHomologacao({ organizacaoId }), listarFichasCatalogo({ organizacaoId }),
  ]);
  const semCusto = pend.causas_raiz.filter((c) => c.codigo === "insumo_sem_custo");
  const custoZero = [];
  for (const c of semCusto) custoZero.push(await cmv.previaCustoZero({ organizacaoId, insumoId: c.alvo.id }));
  const antigasProntas = new Set(antigo.itens.filter((i) => i.pode_homologar).map((i) => i.id));
  const novasElegiveis = new Set(homol.elegiveis.map((i) => i.id));
  const motivoDif = {};
  for (const id of antigasProntas) if (!novasElegiveis.has(id)) {
    const p = pend.produtos.find((x) => x.id === id);
    for (const c of new Set(p.pendencias.map((x) => x.codigo))) motivoDif[c] = (motivoDif[c] ?? 0) + 1;
  }
  saida[organizacaoId] = {
    saude: { ...saude, causas_raiz: undefined },
    causas_raiz: pend.causas_raiz.map((c) => ({ codigo: c.codigo, nome: c.nome, criticidade: c.criticidade, impactados: c.qtd_impactados, diretos: c.qtd_diretos, detalhe: c.detalhe })),
    rendimentos: rend.itens.map((i) => ({ nome: i.nome, unidade: i.unidade, atual: i.rendimento_atual, massa: Math.round(i.massa_ingredientes), sugestao: i.sugestao, confianca: i.confianca, causa: i.causa,
      custo_antes: i.custo_unitario_antes, custo_depois: i.custo_unitario_depois, dependentes: i.dependentes, origem: i.origem })),
    custo_zero: custoZero.map((c) => ({ insumo: c.insumo.nome, afetados: c.afetados, ficariam_sem_pendencia: c.ficariam_sem_pendencia, continuariam: c.continuariam_com_pendencia })),
    homologacao: { criterio_antigo_prontas: antigasProntas.size, novo_elegiveis: novasElegiveis.size, bloqueadas: homol.bloqueadas.length,
      antigas_que_o_novo_bloqueia: [...antigasProntas].filter((id) => !novasElegiveis.has(id)).length, motivos_da_diferenca: motivoDif,
      novas_que_o_antigo_nao_listava: [...novasElegiveis].filter((id) => !antigasProntas.has(id)).length },
  };
}
console.log(JSON.stringify(saida, null, 1));
