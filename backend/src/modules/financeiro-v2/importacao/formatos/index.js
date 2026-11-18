// Detecção de formato pelo CONTEÚDO (nunca pela extensão do nome) e conversão para tabelas de texto que o motor lê.
//   csv  → texto tabular; xlsx → uma tabela por aba; pdf/ofx → tabela montada pelo adaptador da fonte (layout próprio).
// Anomalias de planilha (fórmula sem resultado guardado, célula de erro) ficam visíveis na célula e numa lista de avisos —
// nunca viram valor válido em silêncio.
import { decodificar, lerTabela } from "../leitor.js";
import { lerOfx } from "./ofx.js";
import { lerPdf } from "./pdf.js";
import { lerXlsx, xlsxDentroDoZip } from "./xlsx.js";

export const FORMATO = Object.freeze({ CSV: "csv", XLSX: "xlsx", PDF: "pdf", OFX: "ofx", DESCONHECIDO: "desconhecido" });
export const MARCA_FORMULA_SEM_VALOR = "#FORMULA_SEM_VALOR";

export function detectarFormato(bytes) {
  const b = bytes.subarray(0, 8);
  if (b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04) return FORMATO.XLSX;
  if (b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0) return FORMATO.DESCONHECIDO; // .xls binário antigo: não suportado
  const inicio = new TextDecoder("latin1").decode(bytes.subarray(0, 1024)).replace(/^﻿/, "").trimStart();
  if (inicio.startsWith("%PDF-")) return FORMATO.PDF;
  if (/^OFXHEADER|^<\?xml[\s\S]*<\?OFX|^<OFX>/i.test(inicio)) return FORMATO.OFX;
  if (bytes.subarray(0, 4096).includes(0)) return FORMATO.DESCONHECIDO; // binário que não é nenhum dos acima
  return FORMATO.CSV;
}

/** Célula XLSX → texto para o motor (datas no formato aaaa-mm-dd hh:mm:ss; números em decimal com ponto). */
function textoDaCelula(c) {
  if (!c) return "";
  if (c.tipo === "formula_sem_valor") return MARCA_FORMULA_SEM_VALOR;
  if (c.tipo === "erro") return `#ERRO:${c.texto}`;
  return c.texto;
}

/**
 * @returns {{formato:string, tabelas:Array<{nome:string, linhas:string[][]}>, avisos:Array<{codigo:string, mensagem:string}>, documento?:object}}
 */
export function paraTabelas(bytes, formato, adaptador, periodo) {
  if (formato === FORMATO.CSV) return { formato, tabelas: [{ nome: "csv", linhas: lerTabela(decodificar(bytes)).linhas }], avisos: [] };
  if (formato === FORMATO.XLSX) {
    const wb = lerXlsx(adaptador?.aceitaZip ? xlsxDentroDoZip(bytes) : bytes);
    const avisos = [];
    const tabelas = wb.abas.map((aba) => {
      const linhas = aba.linhas.map((l) => l.map(textoDaCelula));
      aba.linhas.forEach((l, i) => l.forEach((c, j) => {
        if (c?.tipo === "formula_sem_valor") avisos.push({ codigo: "FORMULA_SEM_VALOR", mensagem: `Aba "${aba.nome}", linha ${i + 1}, coluna ${j + 1}: fórmula sem resultado armazenado.` });
        if (c?.tipo === "erro") avisos.push({ codigo: "CELULA_COM_ERRO", mensagem: `Aba "${aba.nome}", linha ${i + 1}, coluna ${j + 1}: célula com erro (${c.texto}).` });
      }));
      return { nome: aba.nome, linhas };
    });
    return { formato, tabelas, avisos };
  }
  if (formato === FORMATO.PDF) {
    const documento = lerPdf(bytes);
    const montado = documento.digitalizado || !adaptador.tabelaDoPdf ? { linhas: [], avisos: [] } : adaptador.tabelaDoPdf(documento, periodo);
    return { formato, tabelas: [{ nome: "pdf", linhas: montado.linhas }], avisos: montado.avisos, documento };
  }
  if (formato === FORMATO.OFX) {
    const ofx = lerOfx(decodificar(bytes));
    const montado = adaptador.tabelaDoOfx ? adaptador.tabelaDoOfx(ofx, periodo) : { linhas: [], avisos: [] };
    return { formato, tabelas: [{ nome: "ofx", linhas: montado.linhas }], avisos: montado.avisos, documento: { inicio: ofx.inicio, fim: ofx.fim } };
  }
  return { formato, tabelas: [], avisos: [] };
}
