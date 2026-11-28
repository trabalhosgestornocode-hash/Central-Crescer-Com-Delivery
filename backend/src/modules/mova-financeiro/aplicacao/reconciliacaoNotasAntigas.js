// MOVA — RECONCILIAÇÃO das notas antigas (29/11/2026). Corrige SÓ o registro do MOVA (mova.nota_entregador) de notas que o Financeiro já
// tem anexadas e aprovadas, mas que o MOVA ainda mostra como PENDENTE_ANEXO (foram recebidas antes da identidade operacional existir).
//
// O que faz: para cada item do plano, REVALIDA no Financeiro (leitura) documento, entregador, unidade, tomador, valor, competência e
// obrigação e só então marca o registro do MOVA como ANEXADA/CONFERE. Se qualquer coisa mudou, PARA aquele registro e diz por quê.
// O que NÃO faz: não escreve no Financeiro; não apaga, desvincula nem reanexa documento; não altera valor, obrigação, conta ou baixa;
// não pede nova nota e não envia mensagem (nenhuma notificação retroativa).
//
// Segurança de execução: dry-run por padrão; `executar` exige a função de backup (chamada ANTES de qualquer escrita, com as linhas atuais);
// cada registro roda em transação própria com a linha travada; idempotente (já reconciliada ⇒ JA_RECONCILIADA, nada é reescrito).
import { avaliarNota, FORCA, mascararDocumento, normalizarLeitura, SITUACAO_IDENTIDADE } from "../dominio/identidadeFiscal.js";

export const RESULTADO = Object.freeze({ PRONTA: "PRONTA", RECONCILIADA: "RECONCILIADA", JA_RECONCILIADA: "JA_RECONCILIADA", PARADA: "PARADA" });
const APROVADAS = new Set(["NF_APROVADA", "LIBERADO_PAGAMENTO", "APROVADA"]);
const naoEncontrado = (e) => e?.codigo === "FV2_NAO_ENCONTRADO";
const cru = (r) => ({ id: r.id, estado: r.estado, motivo: r.motivo, documentoId: r.documento_id, situacaoDocumental: r.situacao_documental, conferencia: r.conferencia, semanaInicio: r.semana_inicio });

/**
 * @param {object} p
 * @param {Array<{unidadeId:string, entregador:string, numero:string, semanaInicio:string, valorCentavos:number}>} p.plano
 * @param {(escopo, entregador, semanaInicio) => Promise<{fechamento:object, notas:object[]}>} p.ler  leitura do Financeiro (somente leitura)
 * @param {object} p.armazenamento  armazenamento Postgres do MOVA (precisa de `transacao`, `auditoria`, `identidadesFiscais`)
 * @param {(unidadeId:string)=>({organizacaoId:string,unidadeId:string})} p.escopoDe
 * @param {(unidadeId:string)=>(string|null)} p.tomadorDe  CNPJ da empresa tomadora da unidade (configurado ou aprendido)
 * @param {boolean} [p.executar=false]
 * @param {(linhas:object[])=>Promise<void>} [p.backup]  obrigatório com `executar`
 */
export async function reconciliarNotasAntigas({ plano, ler, armazenamento, escopoDe, tomadorDe, executar = false, backup = null }) {
  if (!Array.isArray(plano) || plano.length === 0) throw Object.assign(new Error("Plano vazio."), { codigo: "PLANO_VAZIO" });
  if (executar && typeof backup !== "function") throw Object.assign(new Error("Execução exige a função de backup."), { codigo: "BACKUP_OBRIGATORIO" });
  const resultados = [];
  const analisados = [];
  for (const item of plano) analisados.push({ item, ...(await analisar(item)) });
  if (executar) await backup(analisados.filter((x) => x.linha).map((x) => x.linha));
  for (const x of analisados) {
    if (x.resultado !== RESULTADO.PRONTA || !executar) { resultados.push(visao(x)); continue; }
    resultados.push(visao(await aplicar(x)));
  }
  const conta = (r) => resultados.filter((x) => x.resultado === r).length;
  return { executou: executar, resultados, resumo: { total: resultados.length, prontas: conta(RESULTADO.PRONTA), reconciliadas: conta(RESULTADO.RECONCILIADA), jaReconciliadas: conta(RESULTADO.JA_RECONCILIADA), paradas: conta(RESULTADO.PARADA) } };

  function visao(x) {
    return { item: { unidadeId: x.item.unidadeId, entregador: x.item.entregador, numero: x.item.numero, semanaInicio: x.item.semanaInicio, valorCentavos: x.item.valorCentavos }, resultado: x.resultado, motivo: x.motivo ?? null, antes: x.antes ?? null, depois: x.depois ?? null, prestador: x.prestador ?? null };
  }

  async function analisar(item) {
    const parar = (motivo, extra = {}) => ({ resultado: RESULTADO.PARADA, motivo, ...extra });
    const rows = (await armazenamento.transacao((tx) => tx("select * from mova.nota_entregador where unidade_id = $1 and entregador = $2 and semana_inicio = $3 and leitura->>'identificadorDocumento' = $4", [item.unidadeId, item.entregador, item.semanaInicio, String(item.numero)]))).rows;
    if (rows.length === 0) return parar("NOTA_DO_MOVA_NAO_ENCONTRADA");
    if (rows.length > 1) return parar("NOTA_DO_MOVA_AMBIGUA");
    const r = rows[0];
    const antes = cru(r);
    if (r.estado === "ANEXADA" && r.documento_id) return { resultado: RESULTADO.JA_RECONCILIADA, antes, linha: r };
    if (r.estado !== "PENDENTE_ANEXO") return parar("ESTADO_INESPERADO_NO_MOVA", { antes, linha: r });
    const esc = escopoDe(item.unidadeId);
    let d;
    try { d = await ler(esc, item.entregador, item.semanaInicio); } catch (e) { return parar(naoEncontrado(e) ? "FECHAMENTO_NAO_ENCONTRADO_NO_FINANCEIRO" : "FINANCEIRO_INDISPONIVEL", { antes, linha: r }); }
    const f = d?.fechamento;
    if (!f || f.semanaInicio !== item.semanaInicio || (f.entregador?.chave && f.entregador.chave !== item.entregador)) return parar("FECHAMENTO_DIFERENTE_DO_PLANO", { antes, linha: r });
    if (f.valorCentavos !== item.valorCentavos) return parar("VALOR_DA_OBRIGACAO_MUDOU", { antes, linha: r });
    const nota = (d.notas ?? []).find((n) => String(normalizarLeitura(n.leitura)?.numero ?? "") === String(item.numero) && n.vigente !== false);
    if (!nota) return parar("NOTA_NAO_ESTA_VIGENTE_NO_FINANCEIRO", { antes, linha: r });
    if (!nota.documentoId) return parar("NOTA_SEM_DOCUMENTO_ANEXADO", { antes, linha: r });
    if (!APROVADAS.has(nota.situacao)) return parar("NOTA_NAO_APROVADA_NO_FINANCEIRO", { antes, linha: r });
    const tomador = await tomadorDe(item.unidadeId);
    if (!tomador) return parar("TOMADOR_DA_UNIDADE_DESCONHECIDO", { antes, linha: r });
    const av = avaliarNota({ nota, obrigacao: { valorCentavos: f.valorCentavos, semanaInicio: f.semanaInicio, semanaFim: f.semanaFim }, tomadorDaUnidade: tomador });
    if (av.forca !== FORCA.FORTE || av.tomadorOk !== true) return parar(`NOTA_NAO_CONFERE:${av.motivos[0] ?? "TOMADOR_NAO_CONFIRMADO"}`, { antes, linha: r });
    if (av.leitura.valorCentavos !== r.leitura?.valorCentavos) return parar("VALOR_DA_NOTA_DIFERE_DO_REGISTRO_DO_MOVA", { antes, linha: r });
    const chaveMova = r.leitura?.chaveAcesso ?? null;
    if (chaveMova && av.leitura.chaveAcesso && chaveMova !== av.leitura.chaveAcesso) return parar("CHAVE_DE_ACESSO_DIFERENTE", { antes, linha: r });
    const id = await armazenamento.identidadesFiscais.doEntregador({ unidadeId: item.unidadeId, entregador: item.entregador });
    if (id?.situacao === SITUACAO_IDENTIDADE.EM_REVISAO) return parar("IDENTIDADE_EM_REVISAO", { antes, linha: r });
    if (id?.situacao === SITUACAO_IDENTIDADE.CONSOLIDADA && id.documento !== av.leitura.prestadorDocumento) return parar("PRESTADOR_DIFERENTE_DA_IDENTIDADE", { antes, linha: r });
    const depois = { id: r.id, estado: "ANEXADA", motivo: null, documentoId: nota.documentoId, situacaoDocumental: f.situacaoDocumental ?? nota.situacao, conferencia: "CONFERE", semanaInicio: antes.semanaInicio };
    return { resultado: RESULTADO.PRONTA, antes, depois, linha: r, nota, prestador: mascararDocumento(av.leitura.prestadorDocumento) };
  }

  async function aplicar(x) {
    // revalida DENTRO da transação com a linha travada: se mudou entre a análise e a escrita, não escreve.
    const r = await armazenamento.transacao(async (tx) => {
      const atual = (await tx("select id, estado, documento_id from mova.nota_entregador where id = $1 for update", [x.linha.id])).rows[0];
      if (!atual) return RESULTADO.PARADA + ":NOTA_SUMIU";
      if (atual.estado === "ANEXADA" && atual.documento_id) return RESULTADO.JA_RECONCILIADA;
      if (atual.estado !== "PENDENTE_ANEXO") return RESULTADO.PARADA + ":ESTADO_MUDOU_DURANTE_A_EXECUCAO";
      await tx("update mova.nota_entregador set estado = 'ANEXADA', motivo = null, documento_id = $2, situacao_documental = $3, conferencia = 'CONFERE', atualizada_em = now() where id = $1 and estado = 'PENDENTE_ANEXO'", [x.linha.id, x.depois.documentoId, x.depois.situacaoDocumental]);
      await tx("insert into mova.auditoria (acao, ator_tipo, ator_ref, alvo, dados) values ('NOTA_ANTIGA_RECONCILIADA','SISTEMA','reconciliacao-notas-antigas',$1,$2)", [x.item.unidadeId, JSON.stringify({ notaId: x.linha.id, entregador: x.item.entregador, numero: String(x.item.numero), semanaInicio: x.item.semanaInicio, valorCentavos: x.item.valorCentavos, de: x.antes.estado, para: "ANEXADA", prestador: x.prestador })]);
      return RESULTADO.RECONCILIADA;
    });
    if (r === RESULTADO.RECONCILIADA || r === RESULTADO.JA_RECONCILIADA) return { ...x, resultado: r };
    return { ...x, resultado: RESULTADO.PARADA, motivo: String(r).split(":")[1] };
  }
}
