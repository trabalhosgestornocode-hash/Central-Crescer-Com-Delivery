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
 * @param {{unidadeNome?: string|null, diasPendentes: number, pendenciaMaisAntiga?: string|null}} params
 */
export function formatarMensagemPendencia({ unidadeNome, diasPendentes, pendenciaMaisAntiga }) {
  const dias = diasPendentes === 1 ? "1 dia" : `${diasPendentes} dias`;
  const desde = pendenciaMaisAntiga ? `, desde ${pendenciaMaisAntiga.split("-").reverse().join("/")}` : "";
  return `Olá! Identificamos que a unidade ${unidadeNome ?? "—"} possui um lançamento pendente no Crescer com Delivery há ${dias}${desde}. Por favor, acesse o sistema para verificar e regularizar a pendência. — Crescer com Delivery`;
}
