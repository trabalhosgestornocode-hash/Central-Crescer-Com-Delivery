# 10 — Resumo executivo e decisões

## Resumo

- **Configurações hoje:**
  - 8 cartões. São reais e completos: Dados da Unidade, Metas de CMV, Tabelas Comerciais, 2FA próprio e Aparência.
  - **Usuários** está parcial: mostra ações que o servidor recusa ao gerente de unidade e trabalha com senha definida e repassada pelo admin.
  - **Notificações** é placeholder. **Backup** só exporta o tema.
  - Faltam fuso e horário da unidade, "Minha conta" e Privacidade.
  - Várias configurações reais vivem em outros módulos (metas do Checklist, modelo logístico, bonificação, Financeiro, iFood) ou só no Painel ADM (WhatsApp, perfis, módulos).
- **Notificações hoje:**
  - o D-1 do Dashboard iFood é **produção ativa**: 38 empresas com envio automático, cerca de 1.200 mensagens/mês, via **Baileys**;
  - o pipeline (fila com lease, policy pura fail-closed, reservador atômico, idempotência) é sólido e reaproveitável.
- **Fragilidades do cadastro:**
  - os destinatários são **por empresa**, não por unidade;
  - só a equipe Crescer cadastra;
  - "verificado" e "consentimento" são um **atestado do operador**, gravado de uma vez e **global por telefone**: 5 números aparecem em mais de uma empresa;
  - não há texto nem versão do consentimento;
  - o titular não consegue sair sozinho.
- **Proposta:**
  - **Configurações 2.0** com 7 categorias e navegação lateral;
  - **Central de Notificações** do cliente com escopo por unidade;
  - **convite → OTP (template de autenticação oficial) → consentimento por empresa e categoria em livro-razão**;
  - revogação pelo titular por link de gestão, palavra-chave ou pedido;
  - integração do **fechamento operacional disparado pela consolidação**, sem recalcular;
  - **migração do D-1 sem interrupção**: os destinatários atuais são preservados como `LEGACY_ACTIVE` (só D-1, sem prazo, sem OTP retroativo, sem evidência fabricada), com adesão voluntária ao fluxo novo;
  - transporte desacoplado (`noop` → oficial), mantendo o Baileys só durante a transição e **nunca** para OTP.
- **Execução recomendada:**
  - **uma** missão para as Etapas 1–5, com tudo simulado;
  - depois a implantação com autorização;
  - a Etapa 6 (WhatsApp oficial) separada, dependente de provedor e templates.

## Respostas aos critérios de aceite

| Pergunta | Onde |
|---|---|
| O que existe em Configurações / o que está incompleto | doc 01 §2–3 |
| Reformulação visual | doc 03 |
| Como funcionam as notificações atuais | doc 02 §1–3 |
| Preservar destinatários já cadastrados | doc 07 §1 e §1.1 (`LEGACY_ACTIVE`, adesão voluntária, prova de regressão do D-1) |
| Cliente administra os próprios números | doc 04 §4 |
| Verificação OTP | doc 05 §2–3 |
| Prova do consentimento | doc 05 §4 (livro-razão + termo versionado + evidência do desafio) |
| Revogação | doc 05 §5 |
| Preferências por unidade | doc 04 §5–6, doc 06 §1 (escopos) |
| Isolamento multi-tenant | doc 06 §2–5 |
| Integração com o Dashboard iFood | doc 07 §1 |
| Integração do fechamento operacional | doc 07 §2 |
| Homologação do WhatsApp real | doc 08 §4 |
| Sequência de implementação | doc 09 |

## Riscos principais

1. **Interromper o D-1** durante a migração. Mitigação: as flags começam desligadas, há prova automatizada "mesmos destinatários e mensagens", e a migração tem fases reversíveis.
2. **Quebrar a transferência de unidade** com tabelas novas (FK composta e remapeamento automático). Mitigação: exclusão explícita, gatilho de suspensão e teste no harness PG.
3. **Autorização legada sem prova de consentimento do titular** (risco **aceito** pela decisão de 30/10/2026). Mitigação:
   - restrita ao D-1 (com `CHECK` no banco);
   - rotulada com honestidade, sem OTP, aceite ou versão fabricados;
   - revogação imediata pelo titular;
   - adesão voluntária ao fluxo com evidência;
   - nunca estendida a categoria nova.
4. **Dependência do Baileys** (bloqueio do número, travamento do sync). Mitigação: provedor oficial para OTP desde o início e migração por categoria.
5. **Página pública do titular.** Mitigação: rate limit, anti-enumeração, tokens com hash e sem dados operacionais.
6. **Custo por mensagem** na API oficial (cobrança por mensagem; serviço e utility dentro da janela também cobrados desde 01/10/2026, segundo a documentação). Mitigação: estimativa antes da ativação e agrupamento.

## Decisões tomadas

| Data | Decisão | Efeito no plano |
|---|---|---|
| 30/10/2026 | **Preservação dos destinatários existentes** — todos os ativos que recebem o D-1 viram `LEGACY_ACTIVE`: sem exclusão, interrupção, OTP retroativo ou prazo. Número, vínculos, preferências e estado de envio preservados. Nenhuma evidência fabricada. Nenhuma categoria nova automática. Novos destinatários só pelo fluxo novo. Adesão voluntária dos legados. Revogação e bloqueio imediatos para todos. Testes de regressão do D-1. Nada em produção ou no gateway sem autorização específica | docs 04 §3, 05 §4.1 e §5, 06 §1, 07 §1 e §1.1, 09 (Etapa 2 e bloqueadores). **Encerra D-2** (não há prazo) e **resolve D-7** para destinatários novos: o Painel ADM não autoriza novos por atestado |
| 30/10/2026 | **D-16 APROVADA — escopo de unidades dos legados.** A lista de unidades é congelada num snapshot **imutável** por destinatário × empresa × unidade (data e rastreabilidade). Unidades posteriores não herdam e aparecem como pendência "Nenhum destinatário configurado para o Dashboard iFood D-1". Vínculo explícito de legado a unidade nova só para o D-1, com permissão e auditoria. Inclusão e remoção auditadas. Nenhuma categoria nova automática; adesão só por OTP + consentimento. Revogação e bloqueio antes de qualquer envio, inclusive já enfileirado. Equivalência exata do D-1 antes/depois. Testes com 1 unidade, várias unidades e unidades posteriores. Comportamento anterior preservado até a nova seleção ser homologada e ativada | docs 06 §1 (`comunicacao_legado_snapshot`, escopo com `unidade_id` obrigatório), 06 §4 e §4.1, 07 §1 (M0 sem backfill; **snapshot na transação da ativação M3 = "data da migração"**; universo = o do monitor D-1) e §1.1 (cenários e provas 8–10), 04 §4, 09 (Etapas 2 e 4) |
| 30/10/2026 | **D-16 — momento do congelamento CONFIRMADO.** A data da migração é a ativação M3. M0 não cria vínculo legado; antes da M3 o D-1 segue integralmente o comportamento anterior. Em M3, snapshot e vínculos são criados atomicamente com a troca da seleção, sobre as unidades efetivamente abrangidas pelo monitor atual. A ativação é idempotente e tem falha segura, sem estado intermediário visível ao D-1. Revogação vale também para mensagens enfileiradas. Snapshot imutável; alterações posteriores em eventos de auditoria separados. **A ativação M3 exige autorização específica** | doc 07 §1.2 (garantias e mecanismo: RPC única, lock consultivo exclusivo × compartilhado, resolução num único comando, equivalência verificada antes do COMMIT, `JA_ATIVADA`, rollback total); doc 09 Etapa 4 (testes e aceite) |
| 30/10/2026 | **D-3 APROVADA — permissões de gerenciamento.**<br>• Admin da empresa: unidades a que tem acesso, categorias dentro do consentimento, convites, vínculos legados D-1 e auditoria da empresa.<br>• Gerente da unidade: exclusivamente a própria unidade, com convites OTP, categorias autorizadas, vínculo legado só D-1, histórico e auditoria da unidade.<br>• Ninguém consente pelo titular nem reativa revogação.<br>• Sem acesso entre empresas ou entre unidades; número compartilhado não afeta outras unidades.<br>• Validação no backend **e** no banco; auditoria das alterações sensíveis | doc 06 §3.1–3.4 (permissão própria `notificacoes.gerenciar`, matriz ação × papel, garantia em cada camada, auditoria por unidade em `detalhes.unidade_id` **sem coluna nova**, para não quebrar a transferência); doc 04 §4; doc 09 Etapa 2 (testes por linha da matriz, nas três camadas) |

## Decisões pendentes

D-2 foi encerrada; D-3 e D-16 estão aprovadas. Abaixo, as pendentes separadas pelo que de fato **bloqueia a implementação** (Execução A, Etapas 1–5 em simulação) e pelo que pode ser decidido **antes da ativação real** (implantação, ativação M3 e WhatsApp oficial).

### A. Bloqueiam a implementação (decidir antes de começar)

| # | Decisão | Por que bloqueia | Recomendação |
|---|---|---|---|
| **D-11** | Recriar a 054 para excluir as tabelas novas (escopos, snapshot, consentimentos, convites, desafios) do remapeamento da transferência | sem isso, a migration de escopos **quebra a transferência de unidade** (FK composta, snapshot imutável). A 054 atual foi alterada pela frente do Financeiro (a lista `gestao_financeira_tabelas_da_unidade()`), então a mudança precisa de coordenação para não sobrescrever o trabalho de lá | sim, com uma função própria `comunicacao_tabelas_fora_do_remapeamento()` chamada pela 054, mantendo o corpo atual do Financeiro, e prova no harness PG com a cadeia real |
| **D-9** | Cota por categoria | o fechamento simulado passa pelo mesmo pipeline. Se consumir a cota de `max_por_contato_por_dia = 3`, **altera o D-1** e viola a regra de equivalência | cota por categoria (o D-1 conserva exatamente a regra atual) e transporte `noop` sem consumir cota real. O resumo agrupado de D-1 fica para depois |
| **D-4** | Exibição do número completo e armazenamento do telefone no desafio OTP | define o esquema de `comunicacao_desafios_titular` e as respostas da API | mascarado sempre na listagem; completo só no formulário para `gerenciar` da unidade; o desafio guarda o E.164 (necessário para enviar) e é apagado em 30 dias |
| **D-14** | Usuários: convite por e-mail × senha definida pelo admin | define o escopo da seção Usuários da Etapa 1 | convite por e-mail (Supabase Auth invite). Se preferir não mexer agora, a Etapa 1 só corrige a permissão visível e mantém o fluxo atual |
| **D-15** | Fuso e horário por unidade também no Dashboard 2.0 | a Etapa 1 cria as colunas. Usá-las no fechamento muda a competência dos fechamentos já gerados (hoje no fuso da plataforma, com a origem gravada) | criar as colunas e usar nas notificações; no Dashboard 2.0 só a partir de uma data de corte, com a origem gravada, **sem** reprocessar o histórico |

### B. Podem ser definidas antes da ativação real (não impedem construir e testar em simulação)

| # | Decisão | Quando precisa estar decidida | Recomendação |
|---|---|---|---|
| **D-1** | Base legal e textos dos termos | antes do primeiro convite real (a implementação usa uma versão de texto "rascunho" só em simulação) | consentimento explícito por categoria; textos validados juridicamente |
| **D-5** | Como o link do convite chega ao titular | antes do primeiro convite real (a implementação entrega QR + link copiável; outros canais são acréscimo) | QR/link exibido ao gestor; template utility só depois do opt-in |
| **D-6** | Revalidação periódica da posse (só para o fluxo novo) | antes de completar 12 meses do primeiro ATIVO | 12 meses, ou após falhas permanentes |
| **D-7** | Capacidades restantes do Painel ADM (destinatário novo por atestado já está proibido) | antes da implantação | suspender, registrar pedido do titular, visão cross-tenant |
| **D-8** | Valores dos limites de OTP | antes do primeiro OTP real (os limites são configuráveis) | os do doc 05 §3, revistos após o piloto |
| **D-10** | Retenção (livro-razão, desafios, mensagens) | antes da implantação (os jobs de limpeza não executam sem decisão) | livro-razão: vínculo + 5 anos; desafios: 30 dias; mensagens: com a política geral |
| **D-12** | Formato do fechamento no transporte oficial | antes da Etapa 6 | template utility resumido + detalhe sob demanda |
| **D-13** | Provedor oficial, número dedicado e orçamento | antes da Etapa 6 (sem ele não há OTP real; os legados seguem no D-1 normalmente) | cotar 2 BSPs brasileiros e o Cloud API; número novo dedicado |

**Autorizações específicas (não são decisões de desenho):** aplicar migrations em cada ambiente, publicar (push/PR/merge), deploy, criar a env `NOTIFICACOES_OTP_SEGREDO`, ativar a M3 e ligar qualquer transporte real.
