# Configurações 2.0 + Central de Notificações — auditoria e planejamento

Missão **somente de auditoria e planejamento** (30/10/2026): nenhum código funcional, migration, variável, permissão ou destinatário foi alterado; nenhum WhatsApp/OTP enviado. Base: `origin/main` `9da8210`.

| Documento | Conteúdo |
|---|---|
| [01 — Auditoria das Configurações](01-auditoria-configuracoes.md) | Inventário completo (página + configurações espalhadas), estado, persistência, permissões, problemas de UX, recomendações |
| [02 — Auditoria das notificações](02-auditoria-notificacoes.md) | D-1 do Dashboard iFood, Central de Comunicação, gateway Baileys, fila, retry, dedupe, respostas às 10 perguntas, riscos do modelo atual |
| [03 — Proposta visual](03-proposta-visual-configuracoes.md) | 7 categorias, navegação lateral/celular, padrões de formulário, protótipo |
| [04 — Central de Notificações](04-central-notificacoes.md) | Modelo de destinatário, estados e transições, funcionalidades, categorias, horários/limites/entrega |
| [05 — OTP e consentimento](05-otp-consentimento.md) | Fluxo convite → OTP → consentimento, parâmetros de segurança, livro-razão, LGPD, revogação pelo titular, riscos |
| [06 — Arquitetura multi-tenant](06-arquitetura-multitenant.md) | Entidades (reuso × novas), RLS/privilégios, permissões, transferência/promoção, testes de isolamento |
| [07 — Integração Dashboard iFood e Operacional](07-integracao-dashboard-ifood-operacional.md) | Preservação dos destinatários (`LEGACY_ACTIVE`, M0–M3) e prova de regressão do D-1, fechamento disparado pela consolidação, futuras fontes |
| [08 — Transporte WhatsApp](08-transporte-whatsapp.md) | Gateway atual × plataforma oficial, requisitos da Meta, camada desacoplada, homologação |
| [09 — Roadmap](09-roadmap-implementacao.md) | Etapas 1–6, agrupamento em uma execução, arquivos, migrations, testes, riscos, aceite, bloqueadores |
| [10 — Resumo executivo e decisões](10-resumo-executivo-decisoes.md) | Resumo, mapa dos critérios de aceite, riscos, decisões tomadas (preservação dos legados, D-16, D-3) e pendentes separadas em "bloqueiam a implementação" × "antes da ativação real" |
| [11 — Plano de execução consolidada](11-plano-execucao-consolidada.md) | Plano final das Etapas 1–5 numa execução: invariantes, pré-voo, blocos B1–B7, migrations 132–135, flags, matriz de testes, dependências não resolvidas (DEP-1..9), aceite |
| [12 — Relatório de implementação e homologação](12-relatorio-implementacao-homologacao.md) | O que foi entregue (blocos A–F), testes, evidências do D-1/segurança/M3/transferência, regressão × main, correções, limitações |
| [13 — Dependências para produção](13-dependencias-producao.md) | Ordem de implantação, variáveis novas (nenhuma criada), DEP-1..11, garantias do que não muda |
| [14 — Pré-voo, implantação e recuperação](14-preflight-implantacao-recuperacao.md) | Pré-voo de produção (só leitura), procedimento de implantação, plano de recuperação, estado e procedimento do Supabase de teste |
