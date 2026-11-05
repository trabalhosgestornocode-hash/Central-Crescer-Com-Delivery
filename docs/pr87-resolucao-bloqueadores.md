# PR #87 — verificação para merge

## Infraestrutura confirmada por leitura autenticada

Render: serviço crescercomdelivery, srv-d96rl5naqgkc73ccflr0; repositório Central-Crescer-Com-Delivery; branch main; rootDir backend; autoDeploy yes, trigger commit; build npm ci; start node src/server.js; health /health; Ohio, uma instância. Deploy live dep-dbmekiec6qcc73edg94g, SHA e7642c7dc2d65eb2c13926a46beb41b9e318927b.

O domínio oficial centralcrescercomdelivery.com.br e subway-saci-adm.onrender.com retornaram health 200/ok, versão e7642c7, módulo painelAdmViews.js com hash igual à main e API_BASE vazio. O frontend oficial e a API são servidos juntos pelo Render, na mesma origem; módulos retornam Cache-Control no-cache. Isso resolve a coordenação no domínio oficial sem depender da ordem de publicação Vercel.

GitHub registra Vercel Production e7642c7 e Preview 14b7ac8. URLs Vercel redirecionam para autenticação; configuração interna e destino da API desses domínios não foram confirmados. Não promover Vercel a destino oficial sem essa confirmação. O conector Render não oferece leitura de env vars; não foram extraídos segredos nem confirmada a identidade secreta efetiva do serviço.

## Otimização e medições

O lookup anterior transferia o catálogo ativo inteiro e filtrava Churrasco em memória. A otimização aplica no banco o mesmo ILIKE %Churrasco% do Dashboard. Mantém ordenação, seleção e fórmulas. Os resultados de preços das 46 unidades coincidiram integralmente nas três comparações; 29 pares válidos.

Antes: 2388/2311/2198 ms, 5 consultas, 454705 bytes. Depois: 642/642/985 ms, 3 consultas, 112069 bytes. Mediana reduzida em 72,2%, tráfego em 75,4%. Índices de organização/produto/preços constam do schema versionado; índices ativos não foram inspecionados nem alterados. Não se presume índice de nome para curinga inicial.

Serviço completo visaoGeralRede: 20 chamadas sequenciais, competência 2026-10, banco real de produção com guarda GET/HEAD, sem servidor/workers e sem escritas. Intervalo de dois segundos. 46 unidades, 16 consultas por chamada. Mínimo 3843 ms; mediana 4210 ms; p95 nearest-rank 4568 ms; máximo 4607 ms; zero erros/timeouts. Respostas idênticas. Dados: pr87-desempenho.json.

A amostra cobre consultas e cálculos locais contra o banco real. Não inclui HTTP/autenticação, concorrência, rede e CPU do Render. Passa a referência de 5 s nessa medição, sem comprovar p95 HTTP em produção. Não houve benchmark completo antes da otimização; o antes/depois se refere ao lookup.

155 testes direcionados passaram, zero falhas, incluindo rentabilidade, mensal/misto, metas e Foody. Não foram repetidos os 793 testes ou o navegador. Flags e arquivos de outras demandas preservados.

## Publicação e rollback planejados

Enviar a otimização somente após autorização, conferir os checks do novo SHA e a main. Publicar o domínio oficial pelo artefato único Render, que contém API e frontend. Merge autorizado dispara auto-deploy: registrar SHA resultante, aguardar esse SHA live/healthy e verificar módulo, API, filtro misto, classificação por competência e monitoramento. Não promover frontend Vercel independente antes de confirmar API compatível; a configuração protegida Vercel ainda não foi inspecionada.

Rollback para o artefato retido dep-dbmekiec6qcc73edg94g/e7642c7, restaurando frontend/API juntos. Preserva #86 e Foody; não usar cf49bd6 nem reverter #86/#84/#85. Sem rollback de banco. Confirmar retenção e estado de auto-deploy no momento da reversão.

Critérios propostos: divergência financeira reproduzível, erro de permissão/schema, três falhas health ou três 5xx/timeouts consecutivos; p95 acima de 5 s em 20 observações comparáveis após aquecimento exige investigação/rollback. Não são SLA preexistente.

## Decisão

NO-GO para merge imediato: o PR remoto ainda está em 14b7ac8, sem a otimização local e sem seus checks. GO técnico para preparar o envio dessa correção. Após autorização de push, exigir checks do novo SHA e integração sem conflitos. Nenhum push, merge, deploy, migration ou escrita em produção nesta etapa.
