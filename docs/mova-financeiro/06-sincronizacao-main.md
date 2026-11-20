# MOVA — Execução 06: sincronização com a main (20/11/2026)

- main usada: `78cfe12` (origin/main; a ref local `main` deste clone está desatualizada e não foi usada)
- branch antes: `d90d785` · merge: `cd01d52`
- Estratégia: **merge --no-ff** (branch nunca publicada, mas merge preserva o histórico das Execuções 01–05 sem reescrever SHAs citados nos documentos).
- Entraram 2 commits da main (quadro da conferência da nota do entregador: `app.js`, `fv2.css`, `telasEntregadores.js`, teste). **Nenhum conflito**; nenhum arquivo em comum com o MOVA; contratos do Financeiro v2 (propostas, aprovação, permissões, unidades, DRE, caixa, conciliação, isolamento) inalterados ⇒ nenhuma adaptação necessária.
- Testes (sem IA real; `ANTHROPIC_API_KEY` ausente): MOVA 84/84 (memória e PostgreSQL isolado), Financeiro v2 732/732, Gateway 1092/1092, frontend 2040/2040, navegador 6/6, backend completo 6488 ok / 16 falhas **pré-existentes** (Central de Conversas/visão, migrations 088 e 103, distribuições, selecionarPerfil) — nenhuma nova.
- Produção não alterada: sem push, PR, deploy, migração, infraestrutura ou WhatsApp.
- Próximas dependências para homologação: as do checklist do doc 05 (ambiente de homologação, janela de reinício do Gateway, autorizações por fase).
