# Menu lateral retrátil — revisão para publicação conjunta

05/11/2026. Origem: 86bdf18 em feat/menu-lateral-retratil, worktree separado preservado. Integrado por cherry-pick d70fef3 na branch feat/visao-geral-rede, junto do acabamento visual da legenda financeira c41383b. Sem conflitos.

## Escopo

Componente frontend/src/menuLateral.js, instalado no app da empresa (incluindo setor Financeiro), SuperAdmin, Painel Administrativo e navegação de categorias das Configurações. Recolhido: 68 px nos shells, 64 px nas Configurações. Conteúdo ocupa o espaço liberado. Rótulos acessíveis, teclado, aria-current, dicas no hover/foco e preferência em localStorage. Chave global ccd:menu-lateral; Configurações usam chave própria. Sem preferência, auto-recolhe abaixo de 1280 px. Gavetas móveis preservadas completas e sobrepostas, sem botão de recolher.

A correção de aplicação inicial sem animação está presente; reduced-motion é respeitado. Nenhuma mudança em regras financeiras, permissões, banco ou flags Foody.

## Evidências revistas

Matriz corrigida original: 50/50 OK, arquivo matriz2.txt do harness em C:/Users/ponte/AppData/Local/Temp/claude/911658808f22e6e1/9d7d0579-adc8-48cf-a8c4-071eb57ca3a1/scratchpad/menu-harness. Revisadas as 20 capturas da pasta menu-shots irmã, incluindo desktop expandido/recolhido, dicas, gaveta móvel, Configurações, zoom e tema escuro. Nenhuma sobreposição impeditiva identificada nas capturas; estas usam dados e gráfico sintéticos, não comprovam Chart.js ou tabelas com dados reais autenticados.

Frontend completo combinado: 1748 testes; 1722 passaram, 26 pulados, zero falhas. A repetição foi necessária pela integração de navegação global e CSS com a legenda financeira; não foram repetidos os 793 testes de backend.

## Validação real e gate

Foi realizado login real com a credencial de teste configurada, usando os arquivos JS/CSS candidatos apenas no navegador e preservando a API real. Nenhuma ação de negócio foi enviada. A conta autentica, mas a seleção retorna “Nenhuma empresa vinculada à sua conta”; o acesso administrativo também já havia retornado 403. Não foram criados vínculos, perfis ou permissões para contornar isso.

A validação técnica automatizada permanece limitada aos cenários controlados. Em seguida foi disponibilizada ao usuário uma prévia combinada em http://127.0.0.1:8791, com login/API reais e gravações de negócio bloqueadas. O usuário verificou a prévia e confirmou: “está ótimo, pode fazer merge”. Essa confirmação resolve o gate de aceite visual para esta publicação; não é uma alegação de que o agente tenha exercitado todos os perfis administrativos.

**GO para publicação conjunta**, mediante checks do novo PR e integração sem conflitos. A matriz foi repetida sobre os arquivos combinados: 50/50 OK, incluindo viewport real de 390 px via Playwright. Evidência em menu-lateral-retratil-matriz.json. As 20 capturas originais foram revisadas. Nenhuma falha aberta encontrada.
## Publicação futura e rollback

Após validar a sessão real e concluir o gate, publicar as duas mudanças em PR incremental contra main. Confirmar checks do SHA combinado, merge preservando histórico e Render live no SHA do merge, frontend oficial na mesma origem da API e arquivos no-cache. Nenhuma migration ou flag nova.

Se o menu impedir navegação, sobrepor conteúdo ou tornar controles inacessíveis, reverter somente o novo PR/artefato ao SHA 3e8da2e, preservando #88, #87, #86 e Foody. A preferência em localStorage é ignorada pelo código anterior e não exige exclusão de dados.
