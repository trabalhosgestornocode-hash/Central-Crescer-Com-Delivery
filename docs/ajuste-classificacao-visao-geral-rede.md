# Classificação financeira da Visão Geral da Rede

Data: 05/11/2026.

## Correção

A situação principal usa exclusivamente o indicador Total de deduções dos Indicadores de Rentabilidade. A classificação chama `statusIndicadorRentabilidade` e traduz seus estados:

- Dentro da Meta → Em dia.
- Dentro do Limite → Atenção.
- Acima do limite (estado Atenção do indicador original) → Crítica na rede.
- Indicador ou referência indisponíveis → Sem dados.

Foi removida a banda extra `limite + (limite - metaIdeal)`. A comparação mantém precisão integral e prioriza o limite quando uma meta dinâmica o supera. Na ausência de meta ideal, mantém a interpretação homologada Dentro do Limite, sem inventar uma meta ideal.

O total do indicador é distinto das deduções financeiras de caixa: usa as parcelas aplicáveis ao modelo logístico, conforme `totalDeducoesIndicador`, sem ajustes de caixa. A leitura foi extraída para `dashboardExecutivo.totalDeducoes.js`, compartilhada entre o Dashboard e a rede. As metas usam `escolherMetas` e `metasComProtecaoPrecificacao`; períodos mistos usam a conciliação e ponderação existentes. Os preços oficiais são carregados em lote, com paginação, reutilizando a seleção do produto de referência.

## Alcance

- Rankings Melhores desempenhos e Maior necessidade de atenção, com os respectivos badges.
- Melhores desempenhos prioriza a situação financeira e preserva o desempate por folga do limite.
- Badges das listas, cards de atenção/críticas, distribuição e filtro por situação.
- Tabelas gerenciais por unidade e empresa; a empresa mantém a regra existente de pior situação financeira entre suas unidades.
- Detalhe financeiro da empresa e classificação financeira explícita no detalhe da unidade.
- Textos e tooltips identificam Total de deduções como referência. A tabela de unidades mostra o percentual do indicador separadamente das deduções de caixa.

O Monitoramento Dashboard iFood conserva sua lógica operacional de preenchimento, pendências, calendário e D-1. Os cards e a distribuição continuam respeitando o universo empresa/unidade/modalidade sem restringir pelo próprio filtro de situação; tabelas e rankings respeitam todos os filtros.

## Validação local

790 testes passaram, 0 falhas, 0 ignorados. Executados com Node v20.19.4 e `--experimental-vm-modules --test`, abrangendo:

- `backend/test/administrativo-*.test.js`, exceto comunicação e mentorados, fora do escopo.
- Testes `backend/test/dashboard-executivo-*.test.js` de rentabilidade, período misto, proteção, total de deduções e ajustes.
- Todos os `frontend/test/painelAdm*.test.js`.

Casos adicionados: fronteiras exatas da meta/limite; percentual acima do limite sem banda extra; quatro estados e seus reflexos em cards, filtros e rankings; ausência de indicador; distinção entre ajustes financeiros e parcelas aplicáveis; meta dinâmica por preços oficiais; metas personalizadas na ordenação; detalhe administrativo; período misto; precisão da meta ideal.

`git diff --check` passou. Os testes usam banco simulado e variáveis de conexão locais fictícias (`http://127.0.0.1:9`); nenhum teste foi conectado ao banco de produção. Alguns testes preexistentes de desbloqueio tentam registrar auditoria nesse endereço local fechado e registram falha de conexão esperada, sem falha de teste.

## Entrega e limites

Alterações somente locais; nenhum push, merge, deploy, migração ou alteração de produção. O checkout foi encontrado em `C:/x` (junction para `C:/Users/ponte/OneDrive/Desktop/crescer com delivery`), pois o caminho D: informado não está disponível nesta sessão. Arquivos preexistentes fora deste ajuste foram preservados.

GO técnico para homologação. A validação visual em navegador com dados reais de homologação não foi executada; publicação em produção permanece NO-GO até essa validação e autorização do responsável.
