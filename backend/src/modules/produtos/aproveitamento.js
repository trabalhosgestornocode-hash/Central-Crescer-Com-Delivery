// Aproveitamento (peso bruto × peso líquido), fator de correção, índice de cocção — puro, sem I/O.
//
// Convenção única (evita contradição e perda contada duas vezes):
//   FC (fator de correção) = peso bruto ÷ peso líquido  (≥ 1)        aproveitamento % = líquido ÷ bruto × 100
//   perda de limpeza = bruto − líquido                                 IC (índice de cocção) = peso pronto ÷ peso líquido
//   QUANTIDADE COBRADA na ficha = peso bruto (é o que se compra). O custo efetivo do grama aproveitável = preço ÷ aproveitamento.
// O FC é SEMPRE derivado dos pesos quando os dois existem; um FC digitado que contradiga os pesos é recusado.

const POS = (x) => x != null && x !== "" && Number.isFinite(Number(x)) && Number(x) > 0;

/**
 * @param {{pesoBruto?: number|null, pesoLiquido?: number|null, aproveitamentoPct?: number|null, fatorCorrecao?: number|null,
 *          indiceCoccao?: number|null, precoUnitarioBase?: number|null, fatorCorrecaoNoPrecoDoInsumo?: number|null}} e
 * @returns {{ok: boolean, erros: string[], avisos: string[], peso_bruto: number|null, peso_liquido: number|null,
 *           fator_correcao: number|null, aproveitamento_pct: number|null, perda_limpeza: number|null,
 *           peso_pronto: number|null, quantidade_cobrada: number|null, custo_por_unidade_aproveitavel: number|null}}
 */
export function calcularAproveitamento(e) {
  const erros = []; const avisos = [];
  let bruto = POS(e.pesoBruto) ? Number(e.pesoBruto) : null;
  let liquido = POS(e.pesoLiquido) ? Number(e.pesoLiquido) : null;
  let fc = null;
  if (bruto != null && liquido != null) {
    if (liquido > bruto) erros.push("O peso líquido não pode ser maior que o peso bruto (a limpeza só retira).");
    fc = bruto / liquido;
    if (POS(e.fatorCorrecao) && Math.abs(Number(e.fatorCorrecao) - fc) / fc > 0.005) {
      erros.push(`Fator de correção informado (${Number(e.fatorCorrecao)}) contradiz os pesos (${fc.toFixed(4)}). Use os pesos ou o fator, não os dois diferentes.`);
    }
  } else if (POS(e.fatorCorrecao) || POS(e.aproveitamentoPct)) {
    fc = POS(e.fatorCorrecao) ? Number(e.fatorCorrecao) : 100 / Number(e.aproveitamentoPct);
    if (POS(e.fatorCorrecao) && POS(e.aproveitamentoPct) && Math.abs(Number(e.fatorCorrecao) - 100 / Number(e.aproveitamentoPct)) > 0.005 * fc) {
      erros.push("Fator de correção e aproveitamento % informados não são equivalentes.");
    }
    if (fc < 1) erros.push("Fator de correção menor que 1 significaria ganhar peso na limpeza.");
    if (liquido != null) bruto = liquido * fc; else if (bruto != null) liquido = bruto / fc;
  }
  if (fc != null && fc > 5) avisos.push("Aproveitamento abaixo de 20%: confira se os pesos estão na mesma unidade.");
  // Perda já embutida no PREÇO do insumo (insumos.fator_correcao > 1) + perda na ficha = perda contada duas vezes.
  if (fc != null && fc > 1 && Number(e.fatorCorrecaoNoPrecoDoInsumo) > 1) {
    erros.push("Este insumo já tem fator de correção aplicado no preço; aplicar perda também na ficha contaria a perda duas vezes.");
  }
  const ic = POS(e.indiceCoccao) ? Number(e.indiceCoccao) : null;
  const preco = e.precoUnitarioBase != null && Number.isFinite(Number(e.precoUnitarioBase)) ? Number(e.precoUnitarioBase) : null;
  return {
    ok: erros.length === 0, erros, avisos,
    peso_bruto: bruto, peso_liquido: liquido, fator_correcao: fc,
    aproveitamento_pct: fc ? 100 / fc : null,
    perda_limpeza: bruto != null && liquido != null ? bruto - liquido : null,
    peso_pronto: liquido != null && ic != null ? liquido * ic : null,
    quantidade_cobrada: bruto,
    custo_por_unidade_aproveitavel: preco != null && fc != null ? preco * fc : null,
  };
}
