// MOVA — IDENTIDADE FISCAL: o conhecimento fiscal que o MOVA adquire sozinho das notas que o Financeiro já guarda (28/11/2026).
// Só LEITURA do Financeiro (porta de leitura); escrita só nas tabelas internas do MOVA (migração 0028), com auditoria. Sem formulário.
//   aprender({ entregador? })  lê as notas históricas (estruturadas, sem IA), aprende a empresa tomadora de cada unidade, consolida a
//                              identidade de cada entregador por evidência inequívoca e deixa em revisão SÓ os casos conflitantes.
// Idempotente: pode rodar quantas vezes for (cada nota é uma evidência por unidade; vínculos já consolidados só são confirmados).
import { aprenderTomadores, consolidarIdentidades, FORCA, mascararDocumento, SITUACAO_IDENTIDADE, tipoDoDocumento } from "../dominio/identidadeFiscal.js";

const SEM_NOTA = new Set(["AGUARDANDO_NF"]);
const naoEncontrado = (e) => e?.codigo === "FV2_NAO_ENCONTRADO";

export function criarIdentidadeFiscal({ cfg, porta, armazenamento: a, escopoDe, cnpjDe, registrar = () => {} }) {
  const fiscal = a.identidadesFiscais ?? null;
  const disponivel = async () => Boolean(fiscal && (await fiscal.disponivel()));
  const ativos = () => (cfg.entregadores ?? []).filter((e) => e.ativo);

  /** Notas históricas (já ligadas a uma obrigação) de um entregador numa unidade, direto do Financeiro. */
  async function notasDoEntregador(ent) {
    const esc = escopoDe(ent.unidadeId);
    let fechamentos;
    try { fechamentos = (await porta.ler("consultarEntregador", esc, { entregador: ent.chave })).fechamentos.filter((f) => f.entregador?.chave === ent.chave); }
    catch (e) { if (naoEncontrado(e)) return []; throw e; }
    const notas = [];
    for (const f of fechamentos) {
      if (SEM_NOTA.has(f.situacaoDocumental)) continue;
      let d;
      try { d = await porta.ler("detalharFechamentoDoEntregador", esc, { inicio: f.semanaInicio, entregador: ent.chave }); } catch (e) { if (naoEncontrado(e)) continue; throw e; }
      for (const n of d.notas ?? []) {
        notas.push({ organizacaoId: esc.organizacaoId, unidadeId: ent.unidadeId, entregador: ent.chave, semanaInicio: f.semanaInicio, sha256: null, documentoId: n.documentoId ?? null,
          leitura: n.leitura ?? null, situacao: n.situacao, vigente: n.vigente !== false, obrigacao: { valorCentavos: f.valorCentavos, semanaInicio: f.semanaInicio, semanaFim: f.semanaFim } });
      }
    }
    return notas;
  }

  /**
   * @param {{ entregador?: string|null }} opcoes  entregador = aprende só dele (nas unidades em que ele está cadastrado); senão, de todos.
   * @returns resumo (sem documentos completos): documentos analisados, identidades consolidadas/em revisão, divergências.
   */
  async function aprender({ entregador = null, unidadeId = null } = {}) {
    if (!(await disponivel())) return { disponivel: false };
    const lista = ativos().filter((e) => (!entregador || e.chave === entregador) && (!unidadeId || e.unidadeId === unidadeId));
    const chaves = new Set(lista.map((e) => e.chave));
    // notas de TODAS as unidades dos entregadores envolvidos (a identidade vale entre unidades; a nota continua da sua empresa)
    const notas = [];
    for (const e of lista) notas.push(...(await notasDoEntregador(e)));
    // a empresa tomadora de cada unidade: a configurada manda; senão, a aprendida das notas aprovadas (de TODOS os entregadores da unidade)
    const unidades = [...new Set((unidadeId ? ativos().filter((e) => e.unidadeId === unidadeId) : ativos()).map((e) => e.unidadeId))];
    const doTomador = entregador ? notas : [...notas];
    const aprendidos = aprenderTomadores(doTomador);
    const tomadores = new Map();
    for (const u of unidades) {
      const configurado = cnpjDe(u);
      const anterior = await fiscal.tomadorDaUnidade(u);
      const esc = escopoDe(u);
      if (configurado) { tomadores.set(u, configurado); await fiscal.definirTomador({ organizacaoId: esc.organizacaoId, unidadeId: u, documento: configurado, situacao: "CONFIGURADO" }); continue; }
      const t = aprendidos.get(u);
      if (t?.documento) { tomadores.set(u, t.documento); await fiscal.definirTomador({ organizacaoId: esc.organizacaoId, unidadeId: u, documento: t.documento, situacao: "APRENDIDO", notas: t.notas, entregadores: t.entregadores }); }
      else if (anterior?.documento) tomadores.set(u, anterior.documento);
    }
    const r = consolidarIdentidades(notas, tomadores);
    let evidencias = 0;
    for (const x of r.avaliacoes) {
      const l = x.avaliacao.leitura;
      if (!l || !x.documentoId) continue;
      const nova = await fiscal.registrarEvidencia({ organizacaoId: x.organizacaoId, unidadeId: x.unidadeId, entregador: x.entregador, semanaInicio: x.semanaInicio, documentoId: x.documentoId, numero: l.numero, chaveAcesso: l.chaveAcesso,
        prestadorDocumento: l.prestadorDocumento, tomadorDocumento: l.tomadorDocumento, valorCentavos: l.valorCentavos, competencia: /^\d{4}-\d{2}-\d{2}$/.test(l.competencia ?? "") ? l.competencia : null, fonte: "FINANCEIRO", forca: x.avaliacao.forca, motivos: x.avaliacao.motivos });
      if (nova) evidencias += 1;
    }
    const saida = { disponivel: true, documentosAnalisados: notas.length, comLeituraEstruturada: notas.filter((n) => n.leitura).length, evidenciasNovas: evidencias, consolidadas: 0, emRevisao: 0, semHistorico: 0, divergencias: 0, entregadores: [] };
    for (const id of r.identidades.values()) {
      if (!chaves.has(id.entregador)) continue;
      saida.divergencias += id.divergencias.length;
      const vinculos = ativos().filter((e) => e.chave === id.entregador && (!unidadeId || e.unidadeId === unidadeId));
      if (id.situacao === SITUACAO_IDENTIDADE.CONSOLIDADA) {
        const l = r.avaliacoes.find((x) => x.entregador === id.entregador && x.avaliacao.forca === FORCA.FORTE && x.avaliacao.leitura.prestadorDocumento === id.documento)?.avaliacao.leitura;
        for (const v of vinculos) {
          const esc = escopoDe(v.unidadeId);
          const c = await fiscal.consolidar({ organizacaoId: esc.organizacaoId, unidadeId: v.unidadeId, entregador: id.entregador, documento: id.documento, tipo: tipoDoDocumento(id.documento), nome: id.nome ?? null, nomeFantasia: l?.nomeFantasia ?? null, municipio: l?.municipio ?? null, origem: "HISTORICO", motivo: id.motivo });
          if (c.resultado === "CONSOLIDADA") { saida.consolidadas += c.nova ? 1 : 0; if (c.nova) await auditar("IDENTIDADE_FISCAL_CONSOLIDADA", v.unidadeId, { entregador: id.entregador, origem: "HISTORICO", fortes: id.notasFortes, documento: mascararDocumento(id.documento) }); }
          else { saida.emRevisao += 1; await auditar("IDENTIDADE_FISCAL_EM_REVISAO", v.unidadeId, { entregador: id.entregador, motivo: c.motivo }); }
        }
      } else if (id.situacao === SITUACAO_IDENTIDADE.EM_REVISAO) {
        for (const v of vinculos) {
          const esc = escopoDe(v.unidadeId);
          await fiscal.marcarRevisao({ organizacaoId: esc.organizacaoId, unidadeId: v.unidadeId, entregador: id.entregador, motivo: id.motivo, candidatos: id.candidatos, origem: "HISTORICO" });
          await auditar("IDENTIDADE_FISCAL_EM_REVISAO", v.unidadeId, { entregador: id.entregador, motivo: id.motivo, candidatos: id.candidatos.map(mascararDocumento) });
        }
        saida.emRevisao += 1;
      } else saida.semHistorico += 1;
      saida.entregadores.push({ entregador: id.entregador, situacao: id.situacao, motivo: id.motivo });
    }
    registrar({ tipo: "MOVA_IDENTIDADE_FISCAL_APRENDIDA", consolidadas: saida.consolidadas, emRevisao: saida.emRevisao });
    return saida;
  }

  async function auditar(acao, unidadeId, dados) {
    await a.auditoria.registrar({ acao, atorTipo: "SISTEMA", alvo: unidadeId, dados }).catch(() => {});
  }

  return Object.freeze({ disponivel, aprender, auditar });
}
