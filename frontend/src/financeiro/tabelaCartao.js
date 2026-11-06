// Tabela das telas do Financeiro 2.0. No celular (modo cartão) cada <td> é flex: célula com vários elementos (texto, <br>, <small>, selos)
// virava vários itens lado a lado e o conteúdo era cortado. Aqui o conteúdo de cada célula vai num ÚNICO bloco que quebra linha.
import { tabela } from "./ui.js";
export const tabelaCartao = ({ colunas, ...resto }) => tabela({ ...resto, colunas: colunas.map((c) => ({ ...c, render: (l) => `<span class="fin-cel">${c.render(l)}</span>` })) });
