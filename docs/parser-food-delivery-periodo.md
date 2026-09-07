# Parser Food Delivery — análise por período

## Diagnóstico

O frontend é JavaScript modular, sem framework. `parserFoodDelivery.js` mantém
o estado de todas as abas; o wizard está em `parserFoodDeliveryImportModal.js`.
Rotas, controller e service ficam em `backend/src/modules/parser-food-delivery`.
O service acessa Supabase diretamente; não existe repository separado.

Antes desta alteração, a confirmação montava a resposta a partir dos objetos
processados antes do INSERT. `paraApiPedido` retornava `id: null`, enquanto o
drawer procurava pelo UUID. Abrir o Histórico fazia uma nova leitura do banco,
recuperando os IDs. Não havia falta de importação ativa: faltava a identidade
persistida dos pedidos no resultado ativo.

O filtro antigo selecionava até 200 importações presentes no Histórico e
somava seus resumos e listas completos no navegador. Isso incluía dias fora do
intervalo e repetia pedidos sobrepostos. O Histórico continua tendo o limite
legado de 200 entradas; ele deixou de limitar a análise por período.

Schema verificado nas migrations 037, 038, 039, 040 e 046, e consultas
exercitadas no Supabase de teste. Importações, pedidos e auditoria são tabelas
separadas. A FK é `parser_fd_pedidos.importacao_id`; eventos/timeline são
colunas do pedido; entregadores e indicadores são derivados das mesmas linhas.
A migration 040 removeu a unicidade de número de pedido dentro do arquivo.

## Contrato e fonte de verdade

`GET /api/v1/parser-food-delivery/periodo?dataInicio=2026-09-01&dataFim=2026-09-05`

As duas datas são obrigatórias, em `YYYY-MM-DD`. Datas inexistentes, formatos
inválidos, parâmetros repetidos/arrays, ausência de um extremo ou intervalo
invertido resultam em `ApiError.badRequest` (HTTP 400). Sem registros é HTTP
200, listas vazias e totais zero.

O controller extrai organização/unidade de `req.tenant`, nunca da query. A
rota exige a permissão de visualização já existente. O service valida que a
unidade pertence à organização e aplica ambos os filtros aos pedidos e às
importações relacionadas. Somente importações concluídas participam.

A data consultada é `data_hora` do pedido, não a data de upload nem o período
declarado no cabeçalho. O intervalo é `[início às 00:00, dia seguinte ao fim às
00:00)`. Registros sem data operacional permanecem no Histórico, mas não são
atribuídos artificialmente a um dia na análise por período.

## Datas e compatibilidade

O parser de planilhas retorna horas locais sem sufixo de fuso. O legado usa
`timestamptz` para guardar essas horas de parede em UTC. A alteração explicita
essa convenção na gravação e nos limites das queries. A API de pedidos retira
o marcador UTC na apresentação da hora operacional, evitando que o navegador
transforme `01/09 00:00` em `31/08 21:00` no Brasil. Datas de auditoria/upload
continuam sendo instantes reais e continuam usando a formatação habitual.

Não foi feita conversão ou atualização em massa de timestamps históricos.
Os atalhos Hoje/Ontem/7 dias/Este mês usam o calendário de America/Fortaleza.

## Consolidação e deduplicação

A chave da ocorrência é organização + unidade + número textual do pedido +
data/hora operacional + origem. O número isoladamente não é uma identidade.
Para a mesma chave presente em arquivos diferentes, vence a importação mais
recente por `criado_em`, com desempate pelo ID da importação. Todas as linhas
dessa chave presentes no arquivo vencedor são preservadas: não se impõe a
unicidade que a migration 040 removeu. Códigos iguais em dias, horários ou
origens distintos permanecem separados. Sem identidade completa, não se
fundem linhas.

A seleção ocorre somente em memória no backend depois da consulta temporal.
Nenhuma linha histórica é apagada, reescrita ou reclassificada. A resposta
informa as fontes e a quantidade de linhas sobrepostas desconsideradas.
Não se tenta unir pedidos cujo número, horário ou origem tenham mudado entre
arquivos, pois o schema não oferece uma identidade global mais forte.

## Resumo e detalhes

Resumo financeiro, distribuição das operações, pedidos elegíveis, ignorados e
entregadores usam o mesmo conjunto consolidado e as funções de cálculo já
existentes. Os UUIDs e `importacaoId` de origem acompanham cada pedido.

A flag de cancelamento e a chave normalizada do entregador vêm do backend.
Isso permite que cards e listas representem o mesmo universo. O cálculo dos
contadores de classificação agora considera a decisão efetiva já usada pelo
frontend: override manual, depois classificação automática, com compatibilidade
pelo status financeiro para pedidos legados. A classificação automática
original permanece intacta; nenhuma regra do motor ou fórmula financeira foi
reescrita. Essa correção evita indicar uma revisão pendente que já foi
resolvida manualmente no detalhe.

No frontend, `pfd.periodo` é o estado único aplicado. O calendário mantém
apenas um rascunho até o segundo clique. O mesmo dia pode ser clicado duas
vezes; seleção invertida é ordenada no calendário. A API ainda rejeita ranges
invertidos enviados diretamente. O período permanece ao trocar de aba.
Cada consulta recebe uma sequência e a geração do tenant; respostas antigas
não podem substituir a consulta mais recente nem dados de outra unidade.

Cards de pedidos/entregues/cancelados/valor devido abrem as respectivas
listas. O entregador tem acesso aos seus pedidos. Mudança de período fecha
drawers e limpa filtros internos; os filtros continuam funcionando dentro do
período. Erro de consulta tem estado próprio e botão para tentar novamente.

## Pós-importação e Histórico

Uma nova importação usa temporariamente o status não concluído já suportado
pelo schema (`erro`). Só recebe `concluida` após a gravação dos lotes. Uma
falha de lote não publica o processamento parcial na análise. Isso não
transforma o upload em uma transação SQL: tentativas interrompidas podem
permanecer registradas como não concluídas e o arquivo pode ser reenviado.

A confirmação retorna a leitura persistida via `obterImportacao`, incluindo
UUIDs reais. O callback seleciona o período operacional da nova importação e
consulta o consolidado por esse intervalo. Os detalhes ficam utilizáveis
sem abrir o Histórico, incluindo arquivos com vários dias. O Histórico é
atualizado depois, sem participar da ativação dos detalhes.

Abrir uma entrada concluída do Histórico inspeciona exatamente aquele arquivo,
com indicação visual desse modo. Usar o calendário volta à análise por
período. Classificações manuais usam o ID de origem do pedido e recarregam o
mesmo intervalo. A exclusão oferecida pela interface mantém o fluxo existente
e invalida o consolidado ativo; nenhuma exclusão foi executada em produção.

## Banco e performance

Não há migration nem passo manual de banco. O índice existente
`idx_pfdped_unidade (unidade_id, data_hora desc)` atende ao recorte principal;
a PK das importações e a FK já permitem o join. Não foi criado índice
redundante nem alterada migration aplicada.

A consulta faz um inner join, sem N+1 de arquivos, e pagina em blocos de 500
pedidos, ordenados por data e ID. Todas as páginas são lidas antes de calcular
os KPIs. O payload não inclui `dados_brutos`. As abas compartilham a resposta,
sem repetir consultas idênticas entre cards e listas. As listas deste módulo
já eram completas, sem paginação visual; esse comportamento foi preservado.

O custo cresce com os pedidos do intervalo. Não existe limite arbitrário de
1.000 linhas nem consulta de todo o banco para filtrar no navegador. O teste
real cobre 1.387 pedidos consolidados em dois arquivos sobrepostos; não
constitui benchmark de cargas muito maiores.

## Verificação

- Testes unitários do contrato, limites de dia/mês/ano, bissexto, timezone,
  consolidação, multiplicidade, legado/override, dados vazios e erros.
- Service real com I/O substituído para verificar filtros, paginação,
  isolamento, IDs persistidos e falha de lote.
- PostgREST/Supabase de teste: 1.387 pedidos, sobreposição, detalhe de origem,
  corte de um dia e virada de mês, além da regressão existente do Parser.
- Edge headless com módulos frontend reais e API controlada: calendário,
  ranges visuais, abas, cards, pós-importação, detalhe por UUID, override,
  erro/retry, Histórico, respostas atrasadas, troca de tenant e mobile.
- Suítes existentes de isolamento multi-tenant executadas no ambiente
  explicitamente marcado como descartável e diferente da produção.

O teste de navegador usa `playwright` instalado ou `PFD_PLAYWRIGHT_PATH`;
`PFD_BROWSER_CHANNEL=msedge` permite usar o Edge local. Nenhuma dependência
foi adicionada ao runtime do produto.

Graphify não está disponível no PATH deste ambiente. As tentativas de
`graphify query` e `graphify update .` não puderam executar; o grafo não foi
atualizado. O diagnóstico e as alterações foram verificados diretamente no
código, nas migrations e pelos testes.
