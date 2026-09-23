// Template de texto das mensagens de comunicação — separado de
// comunicacao.alertas.service.js (Checkpoint H.4-A) especificamente para
// poder ser reaproveitado pela pré-visualização somente-leitura do Painel
// Administrativo (administrativo.comunicacao.service.js) sem que o admin
// precise importar o PIPELINE de orquestração (o teste arquitetural em
// comunicacao-arquitetura-agendamento.test.js só permite worker-comunicacao/
// importar comunicacao.alertas.service.js — texto puro não é orquestração,
// então vive num arquivo à parte, de propósito).
//
// Função PURA — sem I/O. Toda variável usada vem de dado REAL já resolvido
// pelo chamador (nunca inventa/estima um valor ausente).

/**
 * Checkpoint H.4-A.1, item 2: texto revisado para o primeiro piloto — não
 * mais insinua que o Agente Crescer já pode continuar a conversa (etapa
 * ainda não habilitada). Chamada à ação neutra: pedir para acessar o sistema.
 *
 * Checkpoint H.4-A.3.2, item 7-8: removida a contagem "há N dia(s)". O
 * `diasPendentes` de `administrativo.monitores.js#listarPendencias` conta
 * BACKLOG ANTES do D-1 (regra de negócio correta e intocada aqui) — um gap
 * de um único dia (o cenário mais comum de um primeiro alerta) tem
 * `diasPendentes=0`, o que rendia "há 0 dias" no texto. Em vez de forçar
 * 0→1 (mexeria na regra de negócio para consertar só a redação), o texto
 * passou a citar a DATA de referência, que é sempre verdadeira e nunca
 * depende dessa semântica de contagem. `diasPendentes` continua aceito no
 * parâmetro só para não quebrar os chamadores existentes — nunca usado.
 *
 * @param {{unidadeNome?: string|null, diasPendentes?: number, pendenciaMaisAntiga?: string|null}} params
 */
export function formatarMensagemPendencia({ unidadeNome, pendenciaMaisAntiga }) {
  const dataClausula = pendenciaMaisAntiga ? ` referente ao dia ${pendenciaMaisAntiga.split("-").reverse().join("/")}` : "";
  return `Olá! Identificamos que a unidade ${unidadeNome ?? "—"} possui um lançamento pendente no Crescer com Delivery${dataClausula}. Por favor, acesse o sistema para verificar e regularizar a pendência. — Crescer com Delivery`;
}

const dataPtBr = (iso) => (iso ? iso.split("-").reverse().join("/") : null);

/**
 * Checkpoint H.4-A.4, item 11 — ESTÁGIO 1 da janela crítica D-1 (prazo
 * encerra HOJE, ver administrativo.status.js#prazoFinalHoje). Semanticamente
 * separado do lembrete normal (formatarMensagemPendencia): tom de urgência
 * real, sem prometer nada que o sistema não garante — nunca menciona Agente
 * Crescer, nunca insinua resposta automática. Função PURA, mesma disciplina
 * das demais (nunca inventa data ausente).
 * @param {{unidadeNome?: string|null, pendenciaMaisAntiga?: string|null}} params
 */
export function formatarMensagemCriticaD1({ unidadeNome, pendenciaMaisAntiga }) {
  const data = dataPtBr(pendenciaMaisAntiga);
  const dataClausula = data ? ` referente ao dia ${data}` : "";
  return `Olá! Atenção: a unidade ${unidadeNome ?? "—"} ainda possui o lançamento${dataClausula} pendente no Crescer com Delivery. Esse lançamento precisa ser regularizado hoje para evitar a perda da possibilidade de preenchimento desse período. Por favor, acesse o sistema e conclua o lançamento o quanto antes. — Crescer com Delivery`;
}

/**
 * Checkpoint H.4-A.4, item 12 — ESTÁGIO FINAL (último estágio do dia).
 * Nunca diz "última chance" (o sistema não pode garantir tecnicamente que
 * não haverá outra oportunidade) — diz apenas que é o último lembrete DESTE
 * dia, o que é sempre verdadeiro por construção (V1 nunca agenda um
 * terceiro estágio). Mesma disciplina de dado real das demais.
 * @param {{unidadeNome?: string|null, pendenciaMaisAntiga?: string|null}} params
 */
export function formatarMensagemUltimoLembreteD1({ unidadeNome, pendenciaMaisAntiga }) {
  const data = dataPtBr(pendenciaMaisAntiga);
  const dataClausula = data ? ` referente ao dia ${data}` : "";
  return `Último lembrete de hoje: o lançamento da unidade ${unidadeNome ?? "—"}${dataClausula} continua pendente. Regularize antes do encerramento do dia para evitar perder a possibilidade de preenchimento desse período. — Crescer com Delivery`;
}
