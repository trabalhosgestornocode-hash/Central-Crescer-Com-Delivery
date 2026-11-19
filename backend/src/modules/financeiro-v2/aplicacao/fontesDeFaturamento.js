// FONTES DE FATURAMENTO POR UNIDADE (19/11/2026): de qual sistema vem o faturamento de cada unidade.
//
//   - Sistema de loja (PDV): exatamente UM — SAIPOS (Açaí no Grau Saci) ou SWF (Subway Saci). Ele fornece o Presencial/Balcão.
//   - Plataformas: IFOOD e NOVENTA_E_NOVE_FOOD, sempre pelas fontes OFICIAIS das plataformas (o PDV só confere).
//
// Sem configuração gravada, vale o padrão histórico (SAIPOS + IFOOD + NOVENTA_E_NOVE_FOOD): nada muda para quem já opera.
// A configuração fica no registro da unidade (CONFIGURACAO_UNIDADE, sem migração), exige a permissão de configurar e
// justificativa, e cada alteração entra no histórico (antes/depois, quem, quando). Relatório de um sistema que a unidade
// não usa é RECUSADO na entrada — o arquivo de uma loja nunca vira dado de outra.
import { CODIGO, falhar } from "../dominio/erros.js";
import { EVENTO_HISTORICO, TIPO } from "../dominio/catalogos.js";
import { ACAO } from "../dominio/contexto.js";
import { exigirTexto, semCamposDesconhecidos } from "../dominio/validacao.js";
import { ehRelatorioSwf } from "../importacao/fontes/swf.js";

export const SISTEMAS_DE_LOJA = Object.freeze(["SAIPOS", "SWF"]);
export const PLATAFORMAS = Object.freeze(["IFOOD", "NOVENTA_E_NOVE_FOOD"]);
export const FONTES_PADRAO_DA_UNIDADE = Object.freeze(["SAIPOS", "IFOOD", "NOVENTA_E_NOVE_FOOD"]);
const TODAS = [...SISTEMAS_DE_LOJA, ...PLATAFORMAS];

/** Fontes de faturamento da unidade (padrão histórico quando nada foi configurado). */
export function fontesDaUnidade(config) {
  const c = config?.fontesDeFaturamento;
  const fontes = Array.isArray(c?.fontes) && c.fontes.length ? [...c.fontes] : [...FONTES_PADRAO_DA_UNIDADE];
  return {
    fontes, configurado: Boolean(c), sistemaDeLoja: fontes.find((f) => SISTEMAS_DE_LOJA.includes(f)) ?? null,
    plataformas: fontes.filter((f) => PLATAFORMAS.includes(f)), lojasSwf: Array.isArray(c?.lojasSwf) ? [...c.lojasSwf] : [],
  };
}
export const unidadeUsaSwf = (config) => fontesDaUnidade(config).sistemaDeLoja === "SWF";

/** Sistema de faturamento de um relatório (null = relatório que não é de faturamento: banco, adquirente, entregas). */
export function sistemaDoRelatorio(fonte, tipoRelatorio) {
  if (ehRelatorioSwf(tipoRelatorio)) return "SWF";
  if (fonte === "SAIPOS") return "SAIPOS";
  if (fonte === "IFOOD") return "IFOOD";
  if (tipoRelatorio === "NOVENTA_E_NOVE_FOOD_RELATORIO") return "NOVENTA_E_NOVE_FOOD";
  return null;
}
const NOME = { SAIPOS: "SAIPOS", SWF: "SWF", IFOOD: "iFood", NOVENTA_E_NOVE_FOOD: "99Food" };

/** Recusa relatório de um sistema que a unidade não usa. */
export function exigirFonteDaUnidade(config, fonte, tipoRelatorio) {
  const sistema = sistemaDoRelatorio(fonte, tipoRelatorio);
  if (!sistema) return;
  const { fontes } = fontesDaUnidade(config);
  if (!fontes.includes(sistema)) {
    falhar(CODIGO.OPERACAO_INVALIDA, `Esta unidade não usa ${NOME[sistema]} como fonte de faturamento (fontes: ${fontes.map((f) => NOME[f]).join(", ")}). Confira se o arquivo é desta loja.`, { motivo: "FONTE_FORA_DA_UNIDADE", sistema });
  }
}

function validarFontes(e) {
  semCamposDesconhecidos(e, ["fontes", "lojasSwf", "justificativa"], "fontesDeFaturamento");
  if (!Array.isArray(e.fontes) || !e.fontes.length) falhar(CODIGO.ENTRADA_INVALIDA, "Informe as fontes de faturamento da unidade.", { campo: "fontes" });
  const fontes = [...new Set(e.fontes.map((f) => String(f ?? "").toUpperCase()))];
  const desconhecidas = fontes.filter((f) => !TODAS.includes(f));
  if (desconhecidas.length) falhar(CODIGO.ENTRADA_INVALIDA, `Fonte desconhecida: ${desconhecidas.join(", ")}. Use ${TODAS.join(", ")}.`, { campo: "fontes" });
  const lojas = fontes.filter((f) => SISTEMAS_DE_LOJA.includes(f));
  if (lojas.length !== 1) falhar(CODIGO.ENTRADA_INVALIDA, "A unidade usa exatamente um sistema de loja: SAIPOS ou SWF.", { campo: "fontes" });
  let lojasSwf = [];
  if (e.lojasSwf !== undefined) {
    if (lojas[0] !== "SWF") falhar(CODIGO.ENTRADA_INVALIDA, "Lojas do SWF só se informam em unidade que usa o SWF.", { campo: "lojasSwf" });
    if (!Array.isArray(e.lojasSwf) || e.lojasSwf.length > 5) falhar(CODIGO.ENTRADA_INVALIDA, "lojasSwf: lista com até 5 nomes de loja como o SWF imprime.", { campo: "lojasSwf" });
    lojasSwf = [...new Set(e.lojasSwf.map((l) => exigirTexto(l, "lojasSwf", { max: 80 }).replace(/\s+/g, " ").trim().toUpperCase()))];
  }
  const ordem = (f) => TODAS.indexOf(f);
  return { fontes: fontes.sort((a, b) => ordem(a) - ordem(b)), lojasSwf, justificativa: exigirTexto(e.justificativa, "justificativa", { max: 500 }) };
}

export function operacoesDeFontesDeFaturamento(b) {
  return {
    consultarFontesDeFaturamento(ctx) {
      return b.consultar(ctx, async (cx, tx) => {
        const config = await tx.buscarPorChave(cx, TIPO.CONFIGURACAO_UNIDADE, "unidade");
        // Histórico só das alterações de fontes (antes/depois, quem, quando, justificativa) — a auditoria completa fica no histórico da unidade.
        const historico = config ? (await tx.listarHistorico(cx, { onde: { registroTipo: TIPO.CONFIGURACAO_UNIDADE, registroId: config.id } }))
          .filter((h) => JSON.stringify(h.antes?.fontesDeFaturamento?.fontes ?? null) !== JSON.stringify(h.depois?.fontesDeFaturamento?.fontes ?? null) || JSON.stringify(h.antes?.fontesDeFaturamento?.lojasSwf ?? null) !== JSON.stringify(h.depois?.fontesDeFaturamento?.lojasSwf ?? null))
          .sort((a, b2) => String(b2.em).localeCompare(String(a.em)))
          .map((h) => ({ em: h.em, por: h.usuarioId ?? h.por ?? null, justificativa: h.justificativa ?? null, antes: fontesDaUnidade(h.antes).fontes, depois: fontesDaUnidade(h.depois).fontes, lojasSwf: fontesDaUnidade(h.depois).lojasSwf }))
          : [];
        return { ...fontesDaUnidade(config), unidadeConfigurada: Boolean(config), historico, padrao: [...FONTES_PADRAO_DA_UNIDADE], opcoes: { sistemasDeLoja: [...SISTEMAS_DE_LOJA], plataformas: [...PLATAFORMAS] }, podeConfigurar: (ctx.permissoes ?? []).includes(ACAO.CONFIGURAR) };
      });
    },

    /** Define as fontes de faturamento da unidade do contexto. Repetir a mesma configuração não altera nada. */
    configurarFontesDeFaturamento(ctx, entrada = {}) {
      const c = validarFontes(entrada);
      return b.executar(ctx, ACAO.CONFIGURAR, async (cx, tx) => {
        await tx.travar(cx, "configuracao-unidade", "EXCLUSIVA");
        const atual = await tx.buscarPorChave(cx, TIPO.CONFIGURACAO_UNIDADE, "unidade");
        if (!atual) falhar(CODIGO.OPERACAO_INVALIDA, "Configure a unidade (nome de exibição) antes de definir as fontes de faturamento.");
        const novo = { fontes: c.fontes, lojasSwf: c.lojasSwf };
        const anterior = atual.fontesDeFaturamento ?? null;
        if (anterior && JSON.stringify({ fontes: anterior.fontes, lojasSwf: anterior.lojasSwf ?? [] }) === JSON.stringify(novo)) return { ...fontesDaUnidade(atual), repetido: true };
        const alterado = await b.alterar(tx, cx, TIPO.CONFIGURACAO_UNIDADE, atual, { fontesDeFaturamento: { ...novo, em: b.agora(), por: cx.usuarioId } }, EVENTO_HISTORICO.CONFIGURACAO, c.justificativa);
        return { ...fontesDaUnidade(alterado), repetido: false };
      });
    },
  };
}
