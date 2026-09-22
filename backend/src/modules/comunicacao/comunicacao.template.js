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
