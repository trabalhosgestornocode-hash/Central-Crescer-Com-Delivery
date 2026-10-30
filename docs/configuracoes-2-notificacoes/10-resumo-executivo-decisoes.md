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
  - **migração gradual do D-1 sem interrupção**, com legado válido só para o D-1 até a regularização;
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
| Preservar destinatários já cadastrados | doc 07 §1 (backfill M0, legado só D-1, regularização M2–M4) |
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
3. **Consentimento legado sem prova.** Mitigação: legado restrito ao D-1, regularização com prazo e nunca estendido a categoria nova.
4. **Dependência do Baileys** (bloqueio do número, travamento do sync). Mitigação: provedor oficial para OTP desde o início e migração por categoria.
5. **Página pública do titular.** Mitigação: rate limit, anti-enumeração, tokens com hash e sem dados operacionais.
6. **Custo por mensagem** na API oficial (cobrança por mensagem; serviço e utility dentro da janela também cobrados desde 01/10/2026, segundo a documentação). Mitigação: estimativa antes da ativação e agrupamento.

## Decisões que exigem a sua aprovação

| # | Decisão | Recomendação |
|---|---|---|
| **D-1** | Base legal dos avisos (consentimento × legítimo interesse/contrato) e textos dos termos | consentimento explícito por categoria (atende a política da Meta e a decisão de produto); validação jurídica dos textos |
| **D-2** | Prazo da regularização dos 41 destinatários legados (fim do atestado do operador) | 60 dias após o provedor oficial estar ativo; o D-1 continua até lá |
| **D-3** | Quem gerencia destinatários: só o admin da empresa, ou também o gerente de unidade (na própria unidade) | org admin + unit_manager restrito às suas unidades; finance só leitura |
| **D-4** | Exibição do número completo e forma de guardar o telefone no desafio (claro × hash) | sempre mascarado na listagem; completo só na edição para `gerenciar`; desafio guarda o E.164 (necessário para enviar) e apaga em 30 dias |
| **D-5** | Como o link do convite chega ao titular (presencial/QR/e-mail do admin × template utility) | QR/link exibido ao admin na Etapa A; template utility só depois do opt-in |
| **D-6** | Revalidação periódica da posse do número | 12 meses, ou após falhas permanentes |
| **D-7** | O Painel ADM deixa de "atestar consentimento" depois da regularização | sim: a equipe passa a "registrar pedido do titular", com motivo |
| **D-8** | Valores dos limites de OTP (telefone, IP, unidade, usuário) | os do doc 05 §3, revisados após o piloto |
| **D-9** | Cota por categoria e resumo agrupado de D-1 multiunidade | cota por categoria (o fechamento não consome a cota do D-1); agrupamento opcional depois da M3 |
| **D-10** | Retenção (livro-razão, desafios, mensagens) | livro-razão: vínculo + 5 anos; desafios: 30 dias; mensagens: junto com a política geral de retenção ainda pendente |
| **D-11** | Recriar a 054 para excluir as tabelas de notificação do remapeamento (função hoje alterada pela frente do Financeiro) | sim, coordenado com a frente do Financeiro, com teste no harness |
| **D-12** | Formato do fechamento no transporte oficial (template utility resumido + detalhe sob demanda × documento PDF) | template resumido com os 5 números principais + "responda DETALHE"; PDF só sob pedido, dentro da janela |
| **D-13** | Provedor oficial (Cloud API direto × BSP), número dedicado e orçamento mensal | cotar 2 BSPs brasileiros e o Cloud API; número novo dedicado |
| **D-14** | Usuários: convite por e-mail (o usuário define a senha) em vez de senha definida pelo admin | sim (via Supabase Auth invite) |
| **D-15** | Fuso e horário por unidade passam a valer também para o Dashboard 2.0 (hoje usa o fuso da plataforma) | sim, com a origem registrada (já previsto no fechamento) |
