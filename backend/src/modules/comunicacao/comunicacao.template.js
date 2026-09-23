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

/**
 * Reforço de PRAZO FINAL D-1 (2ª e última mensagem do alerta, 20:00-22:00). Deixa claro que o
 * lançamento precisa ser regularizado HOJE para evitar a perda da possibilidade de preenchimento
 * do período, sem prometer o que o sistema não garante ("última chance" NUNCA), sem ameaça, sem
 * "quando possível", sem citar o Agente Crescer e permitindo desconsiderar se já regularizado.
 * Mesma disciplina de dado real das demais: nunca inventa data ausente.
 * @param {{unidadeNome?: string|null, pendenciaMaisAntiga?: string|null}} params
 */
export function formatarMensagemReforcoDia({ unidadeNome, pendenciaMaisAntiga }) {
  const dataClausula = pendenciaMaisAntiga ? ` referente ao dia ${pendenciaMaisAntiga.split("-").reverse().join("/")}` : "";
  return `Último lembrete de hoje — Crescer com Delivery. O lançamento da unidade ${unidadeNome ?? "—"}${dataClausula} ainda consta pendente. É preciso regularizá-lo hoje para evitar a perda da possibilidade de preenchimento desse período. Caso já tenha realizado o preenchimento, desconsidere esta mensagem. — Crescer com Delivery`;
}
