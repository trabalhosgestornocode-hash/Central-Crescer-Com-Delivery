// MOVA — auxiliares de UNIDADE compartilhados pela rotina dos entregadores e pelas notificações de pagamento: quem é a unidade, o
// rótulo (empresa/unidade) usado nos textos, o escopo de leitura do Financeiro e o grupo financeiro AUTORIZADO SÓ para ela.
// Extraído de entregadoresMova.js sem mudança de regra (a rotina e os avisos continuam usando exatamente a mesma resolução).

export function criarAuxiliaresDeUnidade({ cfg, avisosNoGrupo = {} }) {
  const servico = cfg.identidadeServico.usuarioId;
  const unidadeDe = (id) => cfg.unidades.find((u) => u.unidadeId === id) ?? null;
  const rotuloDe = (id) => { const u = unidadeDe(id); return { unidade: u?.nome ?? null, empresa: u?.empresa ?? null }; };
  const cnpjDe = (id) => (unidadeDe(id)?.documentos ?? []).map((d) => String(d).replace(/\D/g, "")).find((d) => d.length === 14) ?? null;
  // Grupo financeiro AUTORIZADO SÓ para esta unidade (nunca publica dados de uma unidade em grupo de outra ou de várias).
  const grupoDaUnidade = (id) => {
    const g = cfg.gruposAutorizados.filter((x) => !x.privada && !x.entregador && x.politicaResposta === "GRUPO_FINANCEIRO" && x.unidades.length === 1 && x.unidades[0] === id);
    if (g.length === 1) return g[0];
    if (g.length > 1) return null; // dois grupos exclusivos: ambíguo, nunca escolhe
    // 27/11: grupo COMPARTILHADO por duas empresas com a marca explícita `multiempresa` (autorização do proprietário, 25/11): vale como o
    // grupo financeiro de cada uma das suas unidades. Os avisos levam empresa/unidade no texto e as chaves de envio são por unidade.
    // Antes disto, depois de 25/11 17:11 nenhuma das duas empresas achava grupo e todos os avisos ficavam SEM_GRUPO_DA_UNIDADE.
    const compartilhados = cfg.gruposAutorizados.filter((x) => !x.privada && !x.entregador && x.politicaResposta === "GRUPO_FINANCEIRO" && x.multiempresa === true && x.unidades.includes(id));
    if (compartilhados.length === 1) return compartilhados[0];
    // 23/11: unidade SEM grupo exclusivo cujo proprietário indicou, na configuração (MOVA_AVISOS_NO_GRUPO), o grupo da gerência
    // que ela COMPARTILHA (ex.: "Contas à Pagar Subway / Açaí"). Só avisos à gerência; o grupo precisa estar autorizado.
    const jid = Object.hasOwn(avisosNoGrupo, id) ? avisosNoGrupo[id] : null;
    return (jid && cfg.gruposAutorizados.find((x) => x.grupoId === jid && !x.privada && !x.entregador && x.politicaResposta === "GRUPO_FINANCEIRO")) || null;
  };
  const escopoDe = (unidadeId) => { const u = unidadeDe(unidadeId); return { organizacaoId: u.organizacaoId, unidadeId: u.unidadeId, usuarioId: servico }; };
  return Object.freeze({ unidadeDe, rotuloDe, cnpjDe, grupoDaUnidade, escopoDe });
}
