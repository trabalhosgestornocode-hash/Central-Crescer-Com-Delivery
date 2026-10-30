# 09 — Roadmap de implementação

> **Plano executável e consolidado: [doc 11](11-plano-execucao-consolidada.md)** (prevalece sobre este roadmap nos detalhes de execução).
>
> Numeração de migrations: em 30/10/2026 a última na `main` era a 131 e nenhuma branch usava 132+. **Reconfirmar o próximo número livre no início da execução** (as trilhas do Financeiro também numeram migrations).

## Agrupamento proposto

| Execução | Etapas | Por que juntas |
|---|---|---|
| **Execução única A** (uma missão do Claude Code, branch isolada, sem produção) | **1 + 2 + 3 + 4 + 5**, com transporte **`noop`** | compartilham tela, permissões, migrations e testes; tudo é testável em Postgres descartável, no Supabase de teste e no navegador, sem enviar nada. O D-1 real não é tocado (fase M0/M1 do doc 07) |
| **Implantação A** (com autorização) | migrations + deploy da Execução A; M0 → M1 | a Central fica visível; os novos destinatários entram por convite. **OTP real ainda indisponível**: sem provedor oficial, o convite fica em "aguardando verificação" (ou só a simulação em ambiente de teste) |
| **Execução B** (outra missão) | **6** (transporte oficial). Com o OTP real disponível, a **adesão voluntária** dos legados (M2) passa a funcionar; não há regularização obrigatória | depende de provedor, conta, templates e decisões D-12/D-13 — externo ao código |

## Etapa 1 — Configurações 2.0

- **Funcionalidades:**
  - navegação lateral/celular e rotas por seção;
  - estados de salvamento, validação e diálogos;
  - as 7 categorias (doc 03);
  - fuso e horário da unidade;
  - "Minha conta" (nome e troca de senha via Supabase Auth);
  - correção das permissões de Usuários;
  - atalhos com estado (Checklist, Modelo logístico, Bonificação, Financeiro, Integrações).
- **Arquivos:** `frontend/src/configuracoes.js` (dividido em `configuracoes/` por categoria), CSS novo `configuracoes.css`, `router.js` (sub-rota), `api.js`; `backend/src/modules/unidade/*` (fuso/horário); rota de resumo `GET /api/v1/configuracoes/resumo` (pendências).
- **Reaproveitamento:** todas as APIs atuais (dados, metas CMV, tabelas, usuários, MFA); `cfg-*`; `icon()`; padrões do Dashboard 2.0.
- **Migrations:** `132_unidade_fuso_horario` (`unidades.timezone` com validação IANA, `horario_funcionamento` jsonb validado; sem default que altere comportamento).
- **Testes:**
  - unitários de render (padrão `configuracoes.test.js`);
  - navegador (todas as seções, teclado, 390 px, permissões por papel);
  - rotas (`podeVer`/`podeGerenciar`);
  - migração idempotente + rollback.
- **Riscos:** regressão em fluxos existentes (Tabelas Comerciais é chamada pelo Dashboard iFood). **Mitigação:** manter `abrirSecaoConfiguracoes(id)`.
- **Aceite:** nenhuma funcionalidade some; unit_manager não vê ação que não pode executar; nenhum emoji como ícone; nenhuma rolagem horizontal; foco e anúncios corretos.
- **Decisões:** D-3 APROVADA (matriz no doc 06 §3.2); pendentes que afetam esta etapa: D-14 (convite por e-mail) e D-15 (uso do fuso da unidade no Dashboard 2.0).

## Etapa 2 — Central de Notificações (cadastro, escopos, preferências)

- **Funcionalidades:**
  - lista de destinatários por unidade e da empresa;
  - adicionar (gera convite);
  - suspender, reativar e remover vínculo;
  - categorias e horários por destinatário × unidade;
  - histórico por unidade;
  - consentimentos (leitura);
  - pendências.
- **Arquivos:**
  - `backend/src/modules/notificacoes/` (novo: `notificacoes.routes.js`, `.service.js`, `.repository.js`, `.escopos.js`), reaproveitando `comunicacao.destinatarios.repo.js`, `comunicacao.contatosEmpresa.repo.js`, `mascararTelefone`, auditoria;
  - `backend/src/shared/permissoes.js` (`notificacoes.ver/gerenciar`);
  - frontend `configuracoes/notificacoes*.js`.
- **Migrations:** `133_notificacoes_escopos_categorias`:
  - `comunicacao_destinatario_escopos`;
  - colunas novas em `comunicacao_categorias` e seed (`fechamento_operacional_diario` em estado de simulação);
  - `comunicacao_legado_snapshot` (imutável) e a RPC `comunicacao_ativar_selecao_por_escopo`, que grava o snapshot dos legados (`LEGACY_ACTIVE`, só `pendencia_d1`, universo do monitor D-1) e cria os escopos **na transação da ativação**. **A migration não executa a ativação**: ela acontece na Etapa 4/implantação, com autorização (D-16, doc 07 §1). Sem linha no livro-razão; `contatos_whatsapp` e `comunicacao_destinatario_categorias` intocados;
  - pendência "Nenhum destinatário configurado para o Dashboard iFood D-1" e vínculo explícito de legado a unidade nova (só D-1, auditado — doc 06 §4.1);
  - transferência: **D-11 resolvida por desenho** (nenhuma tabela nova com o par `organizacao_id + unidade_id`; doc 06 §4). **Sem** alterar a função de transferência.
- **Testes:**
  - isolamento (doc 06 §5); transferência (harness `testes-seguros/pg`); resolução do D-1 inalterada antes/depois das migrations (M0 não cria vínculo);
  - **permissões D-3, um caso por linha da matriz do doc 06 §3.2**, nas **três camadas** (interface esconde, API recusa com 403/404, RPC/banco recusa com `42501` mesmo chamada diretamente):
    - admin da empresa A1+A2: gerencia nas duas; não vê nada da empresa B;
    - gerente de A1: gerencia só A1; não lista, não convida, não suspende e não vincula em A2; ids de A2 → 404;
    - destinatário com escopo em A1 **e** A2: o gerente de A1 suspende só o escopo de A1 (A2 intacto); não edita nome/número; registrar pedido de revogação afeta só A1;
    - número compartilhado entre empresas (5 em produção): nenhuma ação de gestor altera `contatos_whatsapp` nem o vínculo em outra empresa;
    - nenhum papel grava `CONCEDIDO` nem reativa um `REVOGADO` (rota inexistente + RPC recusa);
    - legado: o gerente vincula legado à **própria** unidade nova só para o D-1; outra categoria → recusa no banco;
    - finance: só leitura; viewer/operations: nada;
    - múltiplos perfis do mesmo usuário: a troca de empresa ou unidade troca o escopo; nada vaza entre sessões;
    - auditoria: toda escrita sensível gera evento com `detalhes.unidade_id`; o gerente lê só a da própria unidade; a resposta não contém IP, user-agent nem número completo.
- **Riscos:** quebrar a transferência de unidade (FK composta) → teste obrigatório. Divergência entre Painel ADM e Central → uma só fonte (as mesmas tabelas).
- **Aceite:**
  - a **prova de regressão do doc 07 §1.1** passa por inteiro: mesmos destinatários, mensagens, chaves, conteúdo, horários e cotas do D-1, com a flag desligada e ligada;
  - os legados ficam `LEGACY_ACTIVE` sem evidência fabricada;
  - o cliente gerencia só o próprio escopo.

## Etapa 3 — OTP e consentimento

- **Funcionalidades:**
  - convite;
  - página pública do titular (verificação, consentimento, gestão/revogação);
  - livro-razão;
  - termos versionados;
  - palavra-chave de saída (atrás de flag, só com inbound confiável).
- **Arquivos:** `notificacoes.titular.routes.js` (público, sem `requireAuth`), `notificacoes.otp.js` (puro: gerar, HMAC, comparar), `notificacoes.consentimento.js`; páginas estáticas mínimas `frontend/titular/` (sem o app inteiro).
- **Migrations:** `134_notificacoes_otp_consentimento` (`comunicacao_convites`, `comunicacao_desafios_titular`, `comunicacao_consentimentos`, `comunicacao_termos`, RPC atômica de consumo do desafio, imutabilidade do livro-razão).
- **Env nova:** `NOTIFICACOES_SEGREDO_MESTRE` (só criada na implantação, com autorização).
- **Testes:**
  - CSPRNG e distribuição;
  - HMAC e tempo constante;
  - expiração, uso único e 5 tentativas;
  - reenvio de 60 s e invalidação;
  - limites por telefone/IP/unidade/usuário;
  - anti-enumeração (corpo e tempo);
  - concorrência real (duas sessões Postgres consumindo o mesmo código);
  - replay;
  - nenhum código em log, banco ou auditoria (varredura);
  - navegador do fluxo do titular a 390 px.
- **Riscos:** página pública como superfície de ataque → rate limit, CSP (já em report-only), tokens com hash, sem dados da unidade.
- **Aceite:** posse e consentimento são registros separados; o consentimento é por empresa e categoria, com texto versionado; a revogação funciona sem admin.

## Etapa 4 — Integração dos módulos

- **Funcionalidades:**
  - resolução do D-1 pelos escopos (M3 atrás de flag, desligada por padrão);
  - fechamento operacional enfileirado no `REGISTRADO` com transporte `noop`;
  - correção de revisão;
  - roteamento de transporte por categoria.
- **Arquivos:** `comunicacao.alertas.service.js` (só a resolução, atrás de flag), `checklistOperacional.operacional.service.js` (gancho pós-registro), `whatsapp.service.js` / `whatsapp.provider.js` (`sendTemplate`, `capabilities`, roteamento), `providers/noop.provider.js`.
- **Migrations:** `135_notificacoes_resolucao_escopos` (nova versão de `comunicacao_resolver_destinatarios` com rollback guardando o corpo atual; `comunicacao_categorias.transporte`).
- **Testes:**
  - com a flag desligada, o D-1 fica idêntico byte a byte (mesmas mensagens e chaves);
  - **ativação M3 (doc 07 §1.2):**
    - atomicidade: falha injetada em cada passo → nada gravado, flag desligada, D-1 pelo ramo antigo;
    - sem estado intermediário: duas sessões reais no Postgres, uma ativando e outra agendando o D-1 ao mesmo tempo; o agendamento vê só antigo ou só novo, e os destinatários são iguais;
    - idempotência: segunda chamada → `JA_ATIVADA`, sem linhas novas;
    - equivalência interna: uma divergência plantada → `ROLLBACK`;
    - universo divergente (unidade inativa, de teste ou de outra empresa no `p_universo`) → recusa;
    - snapshot imutável;
    - desligar a flag volta ao comportamento anterior;
  - cenários D-16: 1 unidade, várias unidades, unidade criada antes e depois da ativação, unidade reativada;
  - com a flag ligada, os mesmos destinatários para os legados;
  - fechamento: uma mensagem por destinatário e versão, nenhuma para PRELIMINAR/INCOMPLETO, cancelamento da versão superada, mesmos números da prévia;
  - teste arquitetural: OTP nunca pelo Baileys.
- **Aceite:**
  - zero mudança de comportamento real com as flags padrão;
  - a ativação M3 cumpre todas as garantias do doc 07 §1.2 em Postgres real;
  - **a ativação não é executada** em nenhum ambiente real sem autorização específica.

## Etapa 5 — Simulação e homologação

- Regressão completa branch × `main` (mesma matriz do PR #54).
- PG descartável com a cadeia real.
- Supabase de **teste** via PostgREST (anon/authenticated negados, isolamento, consumo concorrente do OTP).
- Navegador (Configurações inteira + fluxo do titular).
- Simulação ponta a ponta com o transporte `noop`.
- Relatório de homologação no padrão do doc 02 do Dashboard 2.0.

## Etapa 6 — WhatsApp real (Execução B)

Ver doc 08 §4. O que muda no código:
- provider `meta_cloud` (ou BSP);
- webhook com assinatura;
- `comunicacao_templates`;
- categorização de custo.

Depende de **decisões externas** (D-12, D-13) e de autorização explícita para cada ativação.

## Bloqueadores conhecidos

1. **Provedor oficial inexistente.** Sem ele não há OTP real: nenhum destinatário **novo** pode ser ativado e a adesão voluntária dos legados fica indisponível. Os legados continuam recebendo o D-1 normalmente.
2. ~~Recriar a 054~~ — **resolvido (D-11)**: desenho invisível ao remapeamento; a alteração pendente do Financeiro na função (`5233380`) só pode gerar conflito de merge (DEP-1, doc 11 §5).
3. **Base legal e textos do consentimento** precisam de validação jurídica (D-1).
4. **Promoção de unidade** continua quebrada pelo 42P10 (outra frente). Os testes de promoção ficam informativos até lá.
