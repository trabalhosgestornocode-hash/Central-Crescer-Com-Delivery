// Motor GENÉRICO de análise de importação (puro: bytes → prévia). Não grava nada e não conhece banco.
//
// Fluxo coberto aqui (passos 2–9 do processo): identificar fonte/formato → validar estrutura → validar período e
// estabelecimento → ler sem alterar o arquivo → normalizar → totais de controle → duplicidades no arquivo → divergências.
// A gravação (passos 11–14) só acontece em aplicacao/importacoes.js, depois de confirmação autorizada.
//
// Identificação de cada registro (idempotência):
//   ID_EXTERNO        → fonte + tipo de registro + identificador fornecido pela fonte (o escopo entra na chave única do banco);
//   IMPRESSAO_DIGITAL → quando a fonte NÃO fornece identificador estável: SHA-256 dos campos que a fonte declara como
//                       identidade da linha + o número de ocorrência daquela mesma impressão dentro do arquivo.
//                       Duas linhas iguais no mesmo arquivo continuam sendo DUAS (nunca se fundem por valor e data).
//                       Risco documentado (docs/financeiro-v2/05): uma versão corrigida que reordene linhas idênticas
//                       muda as ocorrências — por isso correções entram como SUBSTITUIÇÃO explícita da importação anterior.
import { createHash } from "node:crypto";
import { CODIGO, ErroFinanceiro } from "../dominio/erros.js";
import { somar } from "../dominio/dinheiro.js";
import { centavos, dataHora, decodificar, erroDeLinha, localizarCabecalho, micros, rotulo } from "./leitor.js";
import { FORMATO, detectarFormato, paraTabelas } from "./formatos/index.js";
import { compatibilidadeNoFormato } from "./fontes/comum.js";

export const sha256 = (texto) => createHash("sha256").update(texto).digest("hex");

/** JSON com chaves em ordem: a mesma informação gera sempre a mesma impressão. */
export function canonico(v) {
  if (Array.isArray(v)) return `[${v.map(canonico).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonico(v[k])}`).join(",")}}`;
  return JSON.stringify(v ?? null);
}

export const ERRO = Object.freeze({
  FORMATO_NAO_RECONHECIDO: "FORMATO_NAO_RECONHECIDO",
  ARQUIVO_VAZIO: "ARQUIVO_VAZIO",
  CAMPO_OBRIGATORIO: "CAMPO_OBRIGATORIO",
  VALOR_INVALIDO: "VALOR_INVALIDO",
  DATA_INVALIDA: "DATA_INVALIDA",
  PERIODO_INCORRETO: "PERIODO_INCORRETO",
  UNIDADE_INCOMPATIVEL: "UNIDADE_INCOMPATIVEL",
  CONFLITO_NO_ARQUIVO: "CONFLITO_NO_ARQUIVO",
  CATEGORIA_DESCONHECIDA: "CATEGORIA_DESCONHECIDA",
  FORMATO_NAO_SUPORTADO: "FORMATO_NAO_SUPORTADO",
  PDF_DIGITALIZADO: "PDF_DIGITALIZADO",
  PDF_INCOMPLETO: "PDF_INCOMPLETO",
});

export const DIVERGENCIA = Object.freeze({
  TOTAL_NAO_CONFERE: "TOTAL_NAO_CONFERE",
  SALDO_NAO_FECHA: "SALDO_NAO_FECHA",
  LINHA_NAO_FECHA: "LINHA_NAO_FECHA",
  ESTABELECIMENTO_NAO_VERIFICADO: "ESTABELECIMENTO_NAO_VERIFICADO",
  VALOR_A_CLASSIFICAR: "VALOR_A_CLASSIFICAR",
  CONFLITO_COM_IMPORTADO: "CONFLITO_COM_IMPORTADO",
  LEITURA_INCOMPLETA: "LEITURA_INCOMPLETA",
  PERIODO_DO_DOCUMENTO: "PERIODO_DO_DOCUMENTO",
  ANOMALIA_DE_PLANILHA: "ANOMALIA_DE_PLANILHA",
});

export const diferenca = (codigo, mensagem, esperadoCentavos, encontradoCentavos, extra = {}) => ({
  codigo, mensagem, esperadoCentavos, encontradoCentavos, diferencaCentavos: encontradoCentavos - esperadoCentavos, ...extra,
});

/** Utilitário de conversão de UMA linha: erros são anotados com o número da linha e a linha é descartada. */
function utilitario(celulas, mapa, numeroLinha, periodo, cabecalho = []) {
  const erros = [];
  const bruto = (campo) => (campo in mapa ? (celulas[mapa[campo]] ?? "") : "");
  const pegar = (campo, opcional, conv) => {
    const t = bruto(campo);
    if (!t) {
      if (!opcional) erros.push(erroDeLinha(ERRO.CAMPO_OBRIGATORIO, `Campo obrigatório vazio: ${campo}.`, numeroLinha, campo));
      return null;
    }
    try {
      return conv(t);
    } catch (e) {
      if (!(e instanceof ErroFinanceiro)) throw e;
      erros.push(erroDeLinha(e.codigo === CODIGO.DATA_INVALIDA ? ERRO.DATA_INVALIDA : ERRO.VALOR_INVALIDO, e.message, numeroLinha, campo));
      return null;
    }
  };
  return {
    erros,
    linha: numeroLinha,
    periodo,
    bruto,
    texto: (campo, { opcional = false } = {}) => pegar(campo, opcional, (t) => t),
    valor: (campo, { opcional = false } = {}) => pegar(campo, opcional, (t) => centavos(t, campo)),
    micros: (campo, { opcional = false } = {}) => pegar(campo, opcional, (t) => micros(t, campo)),
    data: (campo, { opcional = false } = {}) => pegar(campo, opcional, (t) => dataHora(t, campo).data),
    dataHora: (campo, { opcional = false } = {}) => pegar(campo, opcional, (t) => dataHora(t, campo)),
    erro: (codigo, mensagem, campo) => erros.push(erroDeLinha(codigo, mensagem, numeroLinha, campo)),
    /** Colunas cujo rótulo casa com o padrão (ex.: "Dia - 01/09/2026"): [{ rotulo, texto }]. */
    colunasPorPadrao: (padrao) => cabecalho.map((h, j) => ({ rotulo: h, texto: celulas[j] ?? "" })).filter((c) => padrao.test(c.rotulo)),
  };
}

/**
 * Analisa um arquivo com o adaptador da fonte. Nunca lança por conteúdo ruim: tudo vira erro/divergência na prévia.
 * @param {{bytes:Uint8Array, adaptador:object, periodo:{inicio:string, fim:string}, estabelecimentosDaUnidade?:string[]|null}} p
 */
export function analisarArquivo({ bytes, adaptador, periodo, estabelecimentosDaUnidade = null }) {
  const base = { fonte: adaptador.fonte, tipoRelatorio: adaptador.tipoRelatorio, compatibilidade: "SINTETICA" };
  const rejeitar = (erros) => ({ ...base, reconhecido: false, erros, divergencias: [], registros: [], duplicadosNoArquivo: [], controles: {}, estabelecimentos: [] });

  if (!bytes.byteLength || !decodificar(bytes.subarray(0, 4096)).trim()) return rejeitar([erroDeLinha(ERRO.ARQUIVO_VAZIO, "Arquivo vazio.", null)]);
  const formato = detectarFormato(bytes);
  base.compatibilidade = compatibilidadeNoFormato(adaptador, formato);
  const aceitos = adaptador.formatos ?? [FORMATO.CSV, FORMATO.XLSX];
  if (!aceitos.includes(formato)) {
    return rejeitar([erroDeLinha(ERRO.FORMATO_NAO_SUPORTADO, `Formato "${formato}" não é aceito para ${adaptador.descricao} (aceitos: ${aceitos.join(", ")}).`, null)]);
  }
  let convertido;
  try {
    convertido = paraTabelas(bytes, formato, adaptador, periodo);
  } catch (e) {
    if (!(e instanceof ErroFinanceiro)) throw e;
    return rejeitar([erroDeLinha(ERRO.FORMATO_NAO_RECONHECIDO, e.message, null)]);
  }
  const doc = convertido.documento;
  if (formato === FORMATO.PDF && doc?.digitalizado) {
    return rejeitar([erroDeLinha(ERRO.PDF_DIGITALIZADO, "PDF digitalizado (imagem sem texto): não há OCR automático. O arquivo foi preservado; envie o PDF digital ou o OFX.", null)]);
  }
  if (formato === FORMATO.PDF && doc?.incompleto) {
    return rejeitar([erroDeLinha(ERRO.PDF_INCOMPLETO, `PDF incompleto: ${doc.paginas.length} página(s) lida(s) de ${doc.paginasDeclaradas ?? "?"} declarada(s) ou página corrompida.`, null)]);
  }
  let linhas = [];
  let cab = { indice: -1, faltando: Object.keys(adaptador.colunas) };
  let aba = null;
  for (const t of convertido.tabelas) {
    const c = localizarCabecalho(t.linhas, adaptador.colunas);
    if (c.indice >= 0 && !c.faltando.length) { linhas = t.linhas; cab = c; aba = t.nome; break; }
    if (c.faltando.length < cab.faltando.length) cab = c;
  }
  if (cab.indice < 0 || cab.faltando.length) {
    return rejeitar([erroDeLinha(ERRO.FORMATO_NAO_RECONHECIDO,
      `O arquivo não tem o formato esperado de ${adaptador.descricao}. Colunas ausentes: ${cab.faltando.join(", ")}.`, null)]);
  }
  const cabecalho = linhas[cab.indice];

  const erros = [];
  const brutos = [];
  const declarados = [];
  for (let i = cab.indice + 1; i < linhas.length; i += 1) {
    const celulas = linhas[i];
    if (!celulas.some((c) => c)) continue;
    const u = utilitario(celulas, cab.mapa, i + 1, periodo, linhas[cab.indice]);
    if (adaptador.ehTotal?.(u)) {
      const total = adaptador.lerTotal?.(u) ?? null;
      if (total) declarados.push({ ...total, linha: i + 1 });
      erros.push(...u.erros);
      continue;
    }
    const convertido = adaptador.converter(u);
    erros.push(...u.erros);
    if (u.erros.length || !convertido) continue;
    // Colunas sensíveis (ex.: número de cartão, mesmo mascarado) não são guardadas na cópia da linha.
    const omitidas = new Set((adaptador.colunasOmitidas ?? []).map(rotulo));
    const original = Object.fromEntries(cabecalho.map((h, j) => [h || `coluna_${j + 1}`, omitidas.has(rotulo(h)) ? "[omitido]" : (celulas[j] ?? "")]));
    for (const r of [].concat(convertido)) brutos.push({ ...r, linha: i + 1, original });
  }
  if (!brutos.length && !erros.length) erros.push(erroDeLinha(ERRO.ARQUIVO_VAZIO, "O arquivo não tem nenhuma linha de dados.", null));

  // Período: nenhum registro pode cair fora do período declarado na importação.
  for (const r of brutos) {
    if (r.data < periodo.inicio || r.data > periodo.fim) {
      erros.push(erroDeLinha(ERRO.PERIODO_INCORRETO, `Registro de ${r.data} fora do período declarado (${periodo.inicio} a ${periodo.fim}).`, r.linha, "data"));
    }
  }

  // Identificação e duplicidades DENTRO do arquivo.
  const ocorrencias = new Map();
  const porChave = new Map();
  const registros = [];
  const duplicadosNoArquivo = [];
  for (const r of brutos) {
    const conteudo = { tipoRegistro: r.tipoRegistro, idExterno: r.idExterno ?? null, data: r.data, valorCentavos: r.valorCentavos, dados: r.dados };
    const impressao = sha256(canonico(conteudo));
    let chave;
    let identificacao;
    if (r.idExterno) {
      identificacao = "ID_EXTERNO";
      chave = `${adaptador.fonte}|${r.tipoRegistro}|id:${r.idExterno}`;
    } else {
      identificacao = "IMPRESSAO_DIGITAL";
      const digital = sha256(canonico(r.identidade ?? conteudo));
      const n = (ocorrencias.get(digital) ?? 0) + 1;
      ocorrencias.set(digital, n);
      chave = `${adaptador.fonte}|${r.tipoRegistro}|imp:${digital}:${n}`;
    }
    const anterior = porChave.get(chave);
    if (anterior) {
      if (anterior.impressao === impressao) duplicadosNoArquivo.push({ chave, linhas: [anterior.linha, r.linha] });
      else erros.push(erroDeLinha(ERRO.CONFLITO_NO_ARQUIVO, `O identificador ${r.idExterno} aparece com conteúdos diferentes nas linhas ${anterior.linha} e ${r.linha}.`, r.linha, "idExterno"));
      continue;
    }
    const registro = {
      tipoRegistro: r.tipoRegistro, idExterno: r.idExterno ?? null, identificacao, chave, impressao, linha: r.linha,
      data: r.data, competencia: r.data.slice(0, 7), valorCentavos: r.valorCentavos, dados: r.dados, original: r.original,
    };
    porChave.set(chave, registro);
    registros.push(registro);
  }

  // Totais de controle: genéricos + conferências próprias da fonte (somas declaradas, saldos, subtotais).
  const porTipo = {};
  for (const r of registros) {
    porTipo[r.tipoRegistro] ??= { quantidade: 0, somaCentavos: 0 };
    porTipo[r.tipoRegistro].quantidade += 1;
    porTipo[r.tipoRegistro].somaCentavos = somar(porTipo[r.tipoRegistro].somaCentavos, r.valorCentavos);
  }
  const fechamento = adaptador.fechar ? adaptador.fechar(registros, { declarados, periodo }) : { controles: {}, divergencias: [] };
  erros.push(...(fechamento.erros ?? []));
  const divergencias = [...fechamento.divergencias, ...convertido.avisos.map((a) => ({
    codigo: a.codigo === "LINHA_NAO_INTERPRETADA" ? DIVERGENCIA.LEITURA_INCOMPLETA : a.codigo === "PERIODO_DIVERGENTE" ? DIVERGENCIA.PERIODO_DO_DOCUMENTO : DIVERGENCIA.ANOMALIA_DE_PLANILHA, mensagem: a.mensagem, linha: a.linha ?? null,
  }))];

  // Estabelecimento: o arquivo precisa ser DA unidade. Sem cadastro para comparar, a dúvida vira pendência explícita.
  const estabelecimentos = [...new Set(registros.map((r) => r.dados.estabelecimento).filter(Boolean))].sort();
  if (estabelecimentos.length) {
    if (Array.isArray(estabelecimentosDaUnidade)) {
      const alheios = estabelecimentos.filter((e) => !estabelecimentosDaUnidade.includes(e));
      if (alheios.length) erros.push(erroDeLinha(ERRO.UNIDADE_INCOMPATIVEL, `O arquivo é de estabelecimento não vinculado a esta unidade (${alheios.length}).`, null, "estabelecimento"));
    } else {
      divergencias.push({ codigo: DIVERGENCIA.ESTABELECIMENTO_NAO_VERIFICADO, mensagem: "Não há cadastro de estabelecimentos desta unidade para conferir o arquivo." });
    }
  }

  return {
    ...base, reconhecido: true, formato, aba, erros, divergencias, registros, duplicadosNoArquivo, estabelecimentos,
    controles: {
      linhasLidas: brutos.length, registros: registros.length, porTipo, declarados, ...fechamento.controles,
      ...(doc?.paginas ? { paginas: doc.paginas.length, paginasDeclaradas: doc.paginasDeclaradas } : {}),
    },
  };
}

/** Conferência padrão "soma das linhas = total declarado no rodapé". */
export function conferirTotalDeclarado(registros, declarados, { tipoRegistro, campo = "valorCentavos", rotuloTotal, filtro = () => true }) {
  const encontrado = registros.filter((r) => r.tipoRegistro === tipoRegistro && filtro(r)).reduce((s, r) => somar(s, campo === "valorCentavos" ? r.valorCentavos : r.dados[campo]), 0);
  const divergencias = [];
  for (const d of declarados.filter((x) => x[campo] !== undefined)) {
    if (d[campo] !== encontrado) divergencias.push(diferenca(DIVERGENCIA.TOTAL_NAO_CONFERE, `A soma das linhas não confere com o total declarado (${rotuloTotal}).`, d[campo], encontrado, { linha: d.linha }));
  }
  return { encontrado, divergencias };
}

export { rotulo };
