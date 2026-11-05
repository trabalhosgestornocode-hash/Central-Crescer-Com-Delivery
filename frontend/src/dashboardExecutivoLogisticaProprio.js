// Apresentação do bloco INFORMATIVO "Entregadores próprios · Foody" na aba Indicadores do Dashboard Executivo.
//
// Só existe quando o backend devolve `logisticaProprio` (FOODY_CENTRAL_DASHBOARD_ENABLED + unidade autorizada). Sem a chave
// (flag desligada, padrão) devolve "" e a tela fica byte a byte igual. Nunca calcula nada: só formata o que o backend enviou,
// nunca se mistura com "Taxas de entregadores" (iFood), nunca mostra 0 no lugar de "sem dado" e nunca trata dia preliminar
// como custo definitivo.
import { escapeHtml, fmtMoeda } from "./utils.js";

const num = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));

function linha(rotulo, valor, nota) {
  return `<tr><td>${escapeHtml(rotulo)}</td><td class="num">${valor}</td><td class="dex-lp-nota">${nota ? escapeHtml(nota) : ""}</td></tr>`;
}

/** @param {object|null|undefined} b — `dadosMes.logisticaProprio` */
export function logisticaProprioHtml(b) {
  if (!b || typeof b !== "object") return "";
  const titulo = "Entregadores próprios · Foody";
  if (b.erro) {
    return `<section class="dex-painel dex-lp" data-logistica-proprio="erro"><h3>${titulo}</h3>`
      + `<p class="dex-lp-aviso">Indisponível no momento. Os indicadores acima não são afetados.</p></section>`;
  }
  const d = b.dias ?? {};
  const definitivos = num(d.definitivos) ?? 0;
  const foraDosValores = (num(d.pendentes) ?? 0) + (num(d.incompletos) ?? 0);
  const semValor = definitivos === 0;
  const money = (v) => (num(v) == null ? "—" : fmtMoeda(v));
  const resumoDias = semValor
    ? "Nenhum dia com fechamento definitivo neste mês — sem valores."
    : `${definitivos} dia(s) definitivo(s)${foraDosValores ? ` · ${foraDosValores} dia(s) pendente(s)/incompleto(s) fora dos valores` : ""}`;
  return `<section class="dex-painel dex-lp" data-logistica-proprio="${semValor ? "sem-valor" : b.parcial ? "parcial" : "completo"}">`
    + `<h3>${titulo}</h3>`
    + `<p class="dex-lp-aviso">${escapeHtml(b.aviso ?? "Informativo — não compõe deduções nem rentabilidade.")}</p>`
    + `<table class="dex-tabela"><thead><tr><th>Grandeza</th><th class="num">Valor</th><th>Observação</th></tr></thead><tbody>`
    + linha("Custo atribuído (entregadores próprios)", money(b.custoAtribuido), "Só dias com fechamento definitivo")
    + linha("Taxa prevista (sem entregador identificado)", money(b.taxaPrevista), "Previsão — não é custo")
    + linha("Taxa cobrada do cliente", money(b.taxaCobradaCliente), b.taxaCobradaClienteMotivo)
    + linha("Pagamento conciliado", money(b.pagamentoConciliado), b.pagamentoConciliadoMotivo)
    + `</tbody></table>`
    + `<p class="dex-lp-dias">${escapeHtml(resumoDias)}${b.parcial ? " · período parcial" : ""}</p>`
    + `</section>`;
}
