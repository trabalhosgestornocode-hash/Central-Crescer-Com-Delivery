// Checklist Operacional — ORIGEM por loja iFood (várias lojas na mesma unidade).
//
// Uma unidade pode ter mais de uma loja no iFood (ex.: Sanduíches + Saladas, mesma operação). O Checklist já CONSOLIDA tudo da unidade
// (as consultas são por organização + unidade, nunca por merchant; `order_id` é único no banco, então um pedido não duplica). Este módulo
// só acrescenta a ORIGEM: o rótulo da loja em cada pedido e a contagem por loja — e um aviso quando uma loja cadastrada ainda NÃO está
// sendo recebida (sem isso a equipe acharia que a lista está completa).
//
// IDÊNTICO ao comportamento anterior com uma loja só: sem loja adicional cadastrada e com pedidos de um único merchant, `montarLojas`
// devolve null e nada é acrescentado à resposta. Nunca expõe merchant_id nem nome do merchant inteiro: só o rótulo curto.
//
// Falha segura: qualquer erro ao ler as lojas (ex.: a tabela ainda não existe) vira "sem lojas adicionais"; o Checklist nunca cai por isto.

import { montarResumo, chaveOpaca } from "./checklistOperacional.calc.js";

/** "Subway Sanduíches - Saci" -> "Sanduíches"; "Subway Saladas - Saci" -> "Saladas". Sem nome, null. */
export function rotuloCurtoDaLoja(nome) {
  const t = String(nome ?? "").replace(/\s+/g, " ").trim();
  if (!t) return null;
  let r = t.split(/\s+[-–—]\s+/)[0].trim();
  r = r.replace(/^subway\s+/i, "").trim();
  return (r || t).slice(0, 40);
}

const ESTADO_DA_LOJA = Object.freeze({ ativa: "ativa", liberada: "verificando", pendente: "pendente", bloqueada: "bloqueada" });

const MOTIVO_SEM_RECEBIMENTO = Object.freeze({
  pendente: "aguardando liberação",
  liberada: "em verificação",
  bloqueada: "autorização do iFood não confirmada",
});

/**
 * PURA. Agrupa por loja e acrescenta a origem. Devolve null quando só existe uma loja (comportamento idêntico ao de antes).
 * @param {{pedidos: object[], conexao: {merchant_id?: string|null, merchant_nome?: string|null}|null, extras?: object[],
 *          nomes?: Map<string,string>, agoraMs: number}} p
 * @returns {{lojas: object[], rotuloDoPedido: Map<string,string>, alertas: object[]}|null}
 */
export function montarLojas({ pedidos, conexao, extras = [], nomes = new Map(), agoraMs }) {
  const principal = conexao?.merchant_id ?? null;
  const extrasVivas = (extras ?? []).filter((x) => x?.merchant_id && x.estado !== "desativada");
  const merchantsDosPedidos = new Set((pedidos ?? []).map((p) => p?.merchant_id).filter(Boolean));
  if (extrasVivas.length === 0 && merchantsDosPedidos.size <= 1) return null;

  const porMerchant = new Map();
  const ordem = [principal, ...extrasVivas.map((x) => x.merchant_id), ...merchantsDosPedidos].filter(Boolean);
  for (const m of ordem) if (!porMerchant.has(m)) porMerchant.set(m, { merchantId: m, extra: extrasVivas.find((x) => x.merchant_id === m) ?? null });

  // Rótulo: o configurado na loja adicional > nome da conexão (principal) > nome curto vindo do próprio iFood > genérico. Único por unidade.
  const usados = new Map();
  const unico = (base) => {
    const n = (usados.get(base) ?? 0) + 1;
    usados.set(base, n);
    return n === 1 ? base : `${base} ${n}`;
  };
  const lojas = [];
  for (const { merchantId, extra } of porMerchant.values()) {
    const ehPrincipal = merchantId === principal;
    const base = (extra?.rotulo?.trim() || null)
      ?? (ehPrincipal ? (conexao?.merchant_nome?.trim() || null) : null)
      ?? rotuloCurtoDaLoja(nomes.get(merchantId))
      ?? (ehPrincipal ? "Loja principal" : "Loja adicional");
    const rotulo = unico(base.slice(0, 40));
    const rows = (pedidos ?? []).filter((p) => p?.merchant_id === merchantId);
    const c = montarResumo({ pedidos: rows, agoraMs }).contagemDia;
    lojas.push({
      merchantId, rotulo, principal: ehPrincipal,
      estado: ehPrincipal ? "ativa" : extra ? (ESTADO_DA_LOJA[extra.estado] ?? "pendente") : "encerrada",
      contagemDia: { recebidos: c.recebidos, concluidos: c.concluidos, cancelados: c.cancelados, emAndamento: c.emAndamento },
    });
  }

  const rotuloDoPedido = new Map();
  for (const p of pedidos ?? []) {
    const l = lojas.find((x) => x.merchantId === p?.merchant_id);
    if (l && p.order_id) rotuloDoPedido.set(chaveOpaca(p.order_id), l.rotulo);
  }

  const alertas = lojas
    .filter((l) => !l.principal && MOTIVO_SEM_RECEBIMENTO[extrasVivas.find((x) => x.merchant_id === l.merchantId)?.estado])
    .map((l) => ({
      codigo: "loja_sem_recebimento", nivel: "atencao", quantidade: 1,
      texto: `Loja ${l.rotulo}: os pedidos ainda NÃO estão chegando ao Checklist (${MOTIVO_SEM_RECEBIMENTO[extrasVivas.find((x) => x.merchant_id === l.merchantId).estado]})`,
    }));

  return { lojas: lojas.map(({ merchantId, ...resto }) => resto), rotuloDoPedido, alertas };
}

/** Lê o que `montarLojas` precisa. NUNCA lança: falha = sem lojas adicionais e sem nomes (o Checklist segue como antes). */
export async function carregarLojasDaUnidade({ repo, organizacaoId, unidadeId, conexao, pedidos }) {
  let extras = [];
  try {
    if (conexao?.id && typeof repo.listarLojasExtras === "function") extras = await repo.listarLojasExtras({ organizacaoId, unidadeId, conexaoId: conexao.id }) ?? [];
  } catch { extras = []; }
  const merchants = new Set([conexao?.merchant_id, ...extras.map((x) => x.merchant_id), ...(pedidos ?? []).map((p) => p?.merchant_id)].filter(Boolean));
  const multi = extras.length > 0 || merchants.size > 1;
  let nomes = new Map();
  if (multi && typeof repo.obterNomesDasLojas === "function") {
    try { nomes = await repo.obterNomesDasLojas({ organizacaoId, unidadeId, merchantIds: [...merchants] }) ?? new Map(); } catch { nomes = new Map(); }
  }
  return { extras, nomes };
}

/** Acrescenta a origem à resposta (muta `resumo`). Devolve `{lojas}` para a resposta, ou null (uma loja só: nada muda). */
export async function anotarOrigem({ resumo, pedidos, conexao, repo, organizacaoId, unidadeId, agoraMs }) {
  const { extras, nomes } = await carregarLojasDaUnidade({ repo, organizacaoId, unidadeId, conexao, pedidos });
  const r = montarLojas({ pedidos, conexao, extras, nomes, agoraMs });
  if (!r) return null;
  for (const lista of [resumo.pedidosAtivos, resumo.ultimosPedidos]) {
    for (const item of lista ?? []) {
      const rotulo = r.rotuloDoPedido.get(item.id);
      if (rotulo) item.loja = { rotulo };
    }
  }
  resumo.alertas.push(...r.alertas);
  return { lojas: r.lojas };
}
